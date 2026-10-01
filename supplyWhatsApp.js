/* =========================================================
    DIRECT SUPPLY · ORDERS BY WHATSAPP
    Company admins send their orders to the Snackit WhatsApp number (the same number as the
    customer bot). A message from a number saved on a supply company (Companies → admin's
    WhatsApp, several numbers allowed) is a supply order, never a customer chat:
      • a typed list or an Excel/CSV file is read like a pasted order;
      • it goes to the delivery date written in the message; a list sent again without a date
        within 12 hours goes to the same date as their last one; otherwise the next date still
        collecting orders, else tomorrow (a new date is started if needed);
      • sending the list again for the same date replaces their earlier WhatsApp order;
      • the admin gets a reply with what was understood and the dashboard is told; the stock
        buyer gets the combined list, and later changes, from supplyBuyer.js.
    Employees can forward a message with several companies ("AERO / - Apple 6 kg / CRED One /
    …"): each company heading becomes that company's order. Other employee messages are left
    alone, so they still reach the rest of the bot.
========================================================= */
import axios from "axios";
import { readOrder, saveOrderLines } from "./directSupply.js";
import { parseOrderMessage, displayName } from "./supplyParse.js";
import { sendWhatsApp } from "./whatsapp.js";
import { noteInbound } from "./whatsappOutbox.js";
import { storeIncomingMedia } from "./ticketChat.js";
import { sendPushToUsers } from "./pushNotifications.js";

let db = null;
let onChange = () => {};
const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const istDay = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const dayLabel = (date) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const qty = (value) => String(Math.round(Number(value) * 1000) / 1000);
const EXCEL = /\.(xlsx|xls|csv)$/i;

export function initSupplyWhatsApp(database, { onChanged } = {}) {
  db = database;
  if (onChanged) onChange = onChanged;
}

async function companyFor(phone) {
  const key = last10(phone);
  if (key.length < 10) return null;
  const { rows } = await db.query("SELECT * FROM supply_companies WHERE active = TRUE AND contact_phone IS NOT NULL");
  return rows.find((company) => String(company.contact_phone).split(/[,;/\n]+/).some((number) => last10(number) === key)) || null;
}

const employeeFor = (phone) => (global.internalUsers || []).find((user) => user.phone && last10(user.phone) === last10(phone)) || null;

/* The delivery date for an order: the one in the message (unless already delivered); else, for a
   correction sent soon after (within 12 hours of this company's last WhatsApp order), that same
   date unless it's delivered (the buyer gets the updated list);
   else the next date still collecting; else tomorrow. */
async function roundFor(date, title, by, companyId = null) {
  if (!date && companyId) {
    const { rows } = await db.query(
      `SELECT r.* FROM supply_orders o JOIN supply_rounds r ON r.id = o.round_id
       WHERE o.company_id = $1 AND o.source = 'whatsapp' AND o.created_at > NOW() - INTERVAL '12 hours'
         AND r.status <> 'Delivered' AND r.delivery_date >= $2 ORDER BY o.created_at DESC LIMIT 1`,
      [companyId, istDay()]
    );
    if (rows[0]) return rows[0];
  }
  if (date) {
    // A date already delivered isn't reopened: a new delivery is started for it instead.
    const { rows } = await db.query("SELECT * FROM supply_rounds WHERE delivery_date = $1 AND status <> 'Delivered' ORDER BY (status = 'Collecting') DESC, id DESC LIMIT 1", [date]);
    if (rows[0]) return rows[0];
  } else {
    const { rows } = await db.query("SELECT * FROM supply_rounds WHERE status = 'Collecting' AND delivery_date >= $1 ORDER BY delivery_date, id LIMIT 1", [istDay()]);
    if (rows[0]) return rows[0];
  }
  const day = date || istDay(1);
  const { rows } = await db.query("INSERT INTO supply_rounds (delivery_date, title, created_by) VALUES ($1, $2, $3) RETURNING *", [day, title || null, `${by} (WhatsApp)`]);
  const { rows: named } = await db.query("UPDATE supply_rounds SET ref = 'DS-' || LPAD(id::text, 4, '0') WHERE id = $1 RETURNING *", [rows[0].id]);
  return named[0];
}

async function companyByName(name) {
  const key = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const { rows } = await db.query("SELECT * FROM supply_companies");
  const found = rows.find((company) => key(company.name) === key(name));
  if (found) return found;
  const { rows: created } = await db.query("INSERT INTO supply_companies (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *", [displayName(name).slice(0, 120)]);
  return created[0];
}

// Saves one company's WhatsApp order for a date (replacing their earlier one) and returns it.
async function saveOrder({ round, company, lines, rawText, from, sender }) {
  const { rows: previous } = await db.query("DELETE FROM supply_orders WHERE company_id = $1 AND round_id = $2 AND source = 'whatsapp' RETURNING id", [company.id, round.id]);
  const { rows: order } = await db.query(
    "INSERT INTO supply_orders (round_id, company_id, source, raw_text, submitted_by, created_by) VALUES ($1, $2, 'whatsapp', $3, $4, $5) RETURNING id",
    [round.id, company.id, String(rawText || "").slice(0, 20000) || null, sender, `${sender} (WhatsApp ${from})`]
  );
  await saveOrderLines(order[0].id, round.id, company.id, lines);
  return { updated: previous.length > 0 };
}

const listOf = (lines) => lines.map((line) => `• ${line.name}: ${qty(line.qty)} ${line.unit}`).join("\n");

// Returns true when the message was a supply order (or from a company admin), so the customer bot skips it.
export async function handleSupplyWhatsApp(msg) {
  if (!db || !msg?.from) return false;
  const company = await companyFor(msg.from);
  const employee = company ? null : employeeFor(msg.from);
  if (!company && !employee) return false;

  const text = msg.text?.body || msg.document?.caption || msg.image?.caption || "";
  const isExcel = msg.type === "document" && (EXCEL.test(msg.document?.filename || "") || /sheet|excel|csv/i.test(msg.document?.mime_type || ""));
  const sender = company?.contact_name || employee?.name || company?.name || "Admin";

  // Employees: only a message with company headings is an order; anything else goes on to the bot.
  if (employee) {
    if (msg.type !== "text") return false;
    const message = parseOrderMessage(text);
    const groups = message.groups.filter((group) => group.heading && group.lines.length);
    if (!groups.length) return false;
    await noteInbound(msg.from);
    const round = await roundFor(message.date, message.title, employee.name);
    const summary = [];
    for (const group of groups) {
      const target = await companyByName(group.heading);
      const result = await saveOrder({ round, company: target, lines: group.lines, rawText: text, from: msg.from, sender: employee.name });
      summary.push(`*${target.name}*${result.updated ? " (updated)" : ""}\n${listOf(group.lines)}`);
    }
    const date = plainDate(round.delivery_date);
    await sendWhatsApp(msg.from, `✅ Added to ${round.ref} · delivery ${dayLabel(date)}:\n\n${summary.join("\n\n")}`.slice(0, 4000));
    finish(`${groups.length} companies' orders`, round, date, employee.name);
    return true;
  }

  // Company admins: never the refund menu.
  await noteInbound(msg.from);
  let lines = [];
  let message = { date: null, title: null };
  let fileName = null;
  if (isExcel) {
    const media = await storeIncomingMedia(msg);
    if (media?.url) {
      try {
        const file = await axios.get(media.url, { responseType: "arraybuffer", timeout: 30000 });
        lines = readOrder({ file: { data: Buffer.from(file.data).toString("base64") } });
        fileName = media.fileName;
      } catch (err) {
        console.log("SUPPLY EXCEL ERROR:", err.message);
      }
    }
    message = parseOrderMessage(text);
  } else if (msg.type === "text") {
    message = parseOrderMessage(text);
    lines = message.groups.flatMap((group) => group.lines);
  }
  if (!lines.length) {
    const reply = msg.type === "image"
      ? "Thanks! I can't read photos of lists yet. Please type the order (one item per line, e.g. \"Apple - 6 kg\") or send the Excel file."
      : `Hi${company.contact_name ? ` ${company.contact_name}` : ""} 👋 To place ${company.name}'s order, send the list here, one item per line, e.g.\n\nApple - 6 kg\nBanana - 7 kg\nLays Classic 52g - 20\n\nYou can add the delivery date on the first line (e.g. 3/10/26). Sending the list again replaces your earlier order for that date.`;
    await sendWhatsApp(msg.from, reply);
    return true;
  }
  const round = await roundFor(message.date, message.title, company.name, company.id);
  const result = await saveOrder({ round, company, lines, rawText: fileName ? `📄 ${fileName}` : text, from: msg.from, sender });
  const date = plainDate(round.delivery_date);
  const problems = lines.filter((line) => !(line.qty > 0)).map((line) => line.name);
  await sendWhatsApp(msg.from, [
    `✅ ${result.updated ? "Order updated" : "Order received"} for *${company.name}* · delivery *${dayLabel(date)}*:`,
    "",
    listOf(lines.filter((line) => line.qty > 0)),
    problems.length ? `\n⚠️ No quantity for: ${problems.join(", ")}. Please send the full list again with quantities.` : "",
    "",
    "To change it, just send the full list again. Thank you!",
  ].join("\n").replace(/\n{3,}/g, "\n\n").slice(0, 4000));
  finish(`${company.name}'s order`, round, date, sender, result.updated);
  return true;
}

// The buyer gets the combined list (and later changes) from supplyBuyer.js, not each order.
function finish(what, round, date, sender, updated = false) {
  onChange();
  sendPushToUsers(db, ["admin"], { title: `${updated ? "Order updated" : "New order"} on WhatsApp`, body: `${what} for ${round.ref} (${date}) from ${sender}`.slice(0, 180), view: "supply" }).catch(() => {});
  console.log(`🛒 WhatsApp supply order: ${what} → ${round.ref} (${date})`);
}
