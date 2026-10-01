/* =========================================================
    DIRECT SUPPLY · THE STOCK BUYER
    The buyer is set in Admin Settings (name + WhatsApp number). For each delivery date:
      • the master sheet goes to the buyer's WhatsApp by itself as soon as every active company
        has ordered, or at the cutoff time (default 6 pm) the day before delivery with whatever
        has come in; it can also be sent from the dashboard (Buy page);
      • if orders change after that, the buyer gets an "updated list" with just the changes
        (once the change has settled for a couple of minutes), until he marks Goods received;
      • the message has a private link to a phone page (no login) where he fills, per item,
        how much he bought, the price, where he bought it, and the margin %; that becomes the
        purchase on the dashboard, the place's rate, and the item's selling price
        (price + margin %);
      • WhatsApp buttons take him through the steps:
        Received → Processing → Ordered → Goods received → Sent.
    Outside WhatsApp's 24-hour window the approved template "supply_buyer_list" is used:
    "Hi, {{1}} is ready: {{2}} items to buy. Open it to update …: {{3}} Thank you." ({{1}} = "the stock list for Tue, 6 Oct"); button "Received".
========================================================= */
import crypto from "crypto";
import { masterOf, buyingOf, masterWorkbook, roundById } from "./directSupply.js";
import { parseOrderMessage } from "./supplyParse.js";
import { storeDashboardFile, sendStoredFile } from "./ticketChat.js";
import { sendWhatsApp, sendWhatsAppPayload, sendWhatsAppButtons, sendWhatsAppTemplate } from "./whatsapp.js";
import { refillerWindowOpen } from "./whatsappOutbox.js";
import { sendPushToUsers } from "./pushNotifications.js";

export const BUYER_STEPS = ["Received", "Processing", "Ordered", "Goods received", "Sent"];
const STEP_TEXT = { Received: "✅ List received", Processing: "⏳ Processing", Ordered: "🛒 Ordered", "Goods received": "📦 Goods received", Sent: "🚚 Sent" };
const TEMPLATE = "supply_buyer_list";

let db = null;
let onChange = () => {};
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const dayLabel = (date) => new Date(`${plainDate(date)}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const istNow = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16); // "2026-10-02T18:05"
const dayBefore = (date) => { const day = new Date(`${plainDate(date)}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - 1); return day.toISOString().slice(0, 10); };
const qtyText = (qty) => String(Math.round(Number(qty) * 1000) / 1000);
const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

export async function ensureSupplyBuyer(database, { onChanged } = {}) {
  db = database;
  if (onChanged) onChange = onChanged;
  await db.query(`
    ALTER TABLE supply_rounds
      ADD COLUMN IF NOT EXISTS buyer_token TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS buyer_status TEXT,
      ADD COLUMN IF NOT EXISTS buyer_steps JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS buyer_snapshot JSONB;
    ALTER TABLE supply_purchases
      ADD COLUMN IF NOT EXISTS source TEXT,
      ADD COLUMN IF NOT EXISTS margin_percent NUMERIC;
  `);
}

async function setting(key) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]).catch(() => ({ rows: [] }));
  try { return JSON.parse(rows[0]?.value || "null"); } catch { return rows[0]?.value ?? null; }
}

// The buyer from Admin Settings (or, from before, the employee chosen as stock buyer).
export async function buyerContact() {
  const value = (await setting("supply_buyer_contact")) || {};
  const contact = {
    name: String(value.name || "").trim(),
    phone: String(value.phone || "").trim(),
    auto: value.auto !== false,
    cutoff: /^\d{2}:\d{2}$/.test(value.cutoff || "") ? value.cutoff : "18:00",
    origin: value.origin || "",
  };
  if (!contact.phone) {
    const oldId = await setting("supply_buyer_id");
    const employee = (global.internalUsers || []).find((user) => String(user.id) === String(oldId));
    if (employee?.phone) Object.assign(contact, { name: contact.name || employee.name, phone: employee.phone });
  }
  return contact;
}

async function linkFor(round) {
  let token = round.buyer_token;
  if (!token) {
    token = crypto.randomBytes(18).toString("base64url");
    await db.query("UPDATE supply_rounds SET buyer_token = $2 WHERE id = $1", [round.id, token]);
  }
  const seller = (await setting("supply_seller")) || {};
  const contact = await buyerContact();
  const base = String(seller.public_url || contact.origin || "").replace(/\/$/, "");
  return { token, url: `${base}/?buy=${token}` };
}

// What the buyer has seen: item, unit and total, for spotting changes later.
const snapshotOf = (sheet) => sheet.master.filter((row) => row.total > 0).map((row) => ({ key: row.key, name: row.name, unit: row.unit, total: row.total }));

function changesBetween(before = [], after = []) {
  const old = new Map(before.map((row) => [row.key, row]));
  const now = new Map(after.map((row) => [row.key, row]));
  const lines = [];
  for (const row of after) {
    const was = old.get(row.key);
    if (!was) lines.push(`🆕 ${row.name}: *${qtyText(row.total)} ${row.unit}*`);
    else if (Number(was.total) !== Number(row.total)) lines.push(`✏️ ${row.name}: ${qtyText(was.total)} → *${qtyText(row.total)} ${row.unit}*`);
  }
  for (const row of before) if (!now.has(row.key)) lines.push(`❌ ${row.name}: removed`);
  return lines;
}

/* Sends the list for a round to the buyer. kind: "new" (full list + Excel) or "update" (changes).
   Returns { ok, error, file_sent, via_template }. */
export async function sendListToBuyer(roundOrId, kind = "new") {
  const round = typeof roundOrId === "object" ? roundOrId : await roundById(roundOrId);
  if (!round) return { ok: false, error: "Delivery date not found" };
  const contact = await buyerContact();
  if (!contact.phone) return { ok: false, error: "Add the buyer's WhatsApp number in Admin Settings → Direct Supply buyer." };
  const sheet = await masterOf(round.id);
  const rows = snapshotOf(sheet);
  if (!rows.length) return { ok: false, error: "There are no orders for this date yet" };
  const { url } = await linkFor(round);
  const to = phoneDigits(contact.phone);
  const label = dayLabel(round.delivery_date);
  const isUpdate = kind === "update";
  const buying = await buyingOf(round.id, sheet);

  let body;
  if (isUpdate) {
    const changes = changesBetween(round.buyer_snapshot || [], rows);
    body = [
      `📝 *Updated stock list · ${label}*`,
      `${round.ref}${round.title ? ` · ${round.title}` : ""}`,
      "",
      ...changes.slice(0, 40),
      "",
      `Full list now: ${rows.length} items.`,
      `👉 Open the list: ${url}`,
    ].join("\n");
  } else {
    const lines = rows.slice(0, 60).map((row) => {
      const best = buying.rows.find((item) => item.key === row.key)?.best;
      return `• ${row.name}: *${qtyText(row.total)} ${row.unit}*${best ? ` · last ₹${best.price} at ${best.vendor_name}` : ""}`;
    });
    body = [
      `🛒 *Stock to buy · ${label}*`,
      `${round.ref}${round.title ? ` · ${round.title}` : ""} · ${sheet.companies.length} location${sheet.companies.length === 1 ? "" : "s"}: ${sheet.companies.map((company) => company.name).join(", ")}`,
      "",
      ...lines,
      rows.length > 60 ? `…and ${rows.length - 60} more in the Excel file.` : "",
      "",
      `👉 After buying, fill how much you bought, the price, where you bought it and the margin here:\n${url}`,
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
  }

  let fileSent = false;
  let viaTemplate = false;
  if (await refillerWindowOpen(to)) {
    const text = await sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4000) } });
    if (!text.ok) return { ok: false, error: text.error || "WhatsApp didn't accept the message" };
    if (!isUpdate) {
      const file = await storeDashboardFile({
        name: `Snackit-${round.ref}-master-${round.delivery_date}.xlsx`,
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: masterWorkbook(round, sheet, buying).toString("base64"),
      }).catch(() => null);
      if (file) fileSent = Boolean((await sendStoredFile(to, file, `${round.ref} master sheet`)).ok);
    }
    const next = nextStep(round.buyer_status);
    if (next) await sendWhatsAppButtons(to, isUpdate ? "Tap to say you've seen the change." : "Tap when you've seen the list.", [{ id: `SB:${round.id}:${next}`, title: next }]);
  } else {
    const result = await sendWhatsAppTemplate(to, TEMPLATE, "en", [`${isUpdate ? "the updated stock list" : "the stock list"} for ${label}`, String(rows.length), url], [`SB:${round.id}:Received`]);
    if (!result.ok) {
      return { ok: false, error: `${contact.name || "The buyer"} hasn't messaged the Snackit number in the last 24 hours, and the "${TEMPLATE}" template didn't go (${result.error}). Ask them to send "hi" to the Snackit number, or create the template in Meta.` };
    }
    viaTemplate = true;
  }

  await db.query(
    `UPDATE supply_rounds SET sent_at = NOW(), sent_to = $2, buyer_snapshot = $3,
       status = CASE WHEN status = 'Collecting' THEN 'Sent to buyer' ELSE status END, updated_at = NOW() WHERE id = $1`,
    [round.id, contact.name || contact.phone, JSON.stringify(rows)]
  );
  onChange();
  return { ok: true, file_sent: fileSent, via_template: viaTemplate };
}

const nextStep = (status) => {
  const index = BUYER_STEPS.indexOf(status);
  return BUYER_STEPS[index + 1] || null;
};

async function setStep(round, step, by) {
  if (!BUYER_STEPS.includes(step)) return null;
  const bought = ["Goods received", "Sent"].includes(step);
  const { rows } = await db.query(
    `UPDATE supply_rounds SET buyer_status = $2, buyer_steps = buyer_steps || jsonb_build_object($2::text, NOW()),
       status = CASE WHEN $3 AND status IN ('Collecting', 'Sent to buyer') THEN 'Bought' ELSE status END, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [round.id, step, bought]
  );
  onChange();
  sendPushToUsers(db, ["admin"], { title: `Buyer: ${step}`, body: `${by || "The buyer"} marked ${round.ref} (${dayLabel(round.delivery_date)}) as ${step}`, view: "supply" }).catch(() => {});
  return rows[0];
}

/* ---------- Auto send: every couple of minutes ---------- */
const settling = new Map(); // round id → the changed list seen on the last check
const failedAt = new Map(); // round id → when sending last failed (retry after 30 minutes)

export async function supplyBuyerTick() {
  if (!db) return;
  try {
    const contact = await buyerContact();
    if (!contact.phone || !contact.auto) return;
    const now = istNow();
    const { rows: rounds } = await db.query(
      "SELECT * FROM supply_rounds WHERE delivery_date >= $1::date AND status IN ('Collecting', 'Sent to buyer') ORDER BY delivery_date, id",
      [now.slice(0, 10)]
    );
    if (!rounds.length) return;
    const { rows: active } = await db.query("SELECT id FROM supply_companies WHERE active = TRUE");
    for (const raw of rounds) {
      const round = { ...raw, delivery_date: plainDate(raw.delivery_date) };
      if (failedAt.has(round.id) && Date.now() - failedAt.get(round.id) < 30 * 60000) continue;
      const { rows: ordered } = await db.query("SELECT DISTINCT company_id FROM supply_orders WHERE round_id = $1", [round.id]);
      if (!ordered.length) continue;
      let kind = null;
      if (!round.sent_at) {
        const have = new Set(ordered.map((row) => row.company_id));
        const everyone = active.length > 0 && active.every((company) => have.has(company.id));
        if (everyone || now >= `${dayBefore(round.delivery_date)}T${contact.cutoff}`) kind = "new";
      } else if (!["Goods received", "Sent"].includes(round.buyer_status)) {
        const current = JSON.stringify(snapshotOf(await masterOf(round.id)));
        // Sent before the buyer tracking existed: take today's list as what he has seen.
        if (!round.buyer_snapshot) { await db.query("UPDATE supply_rounds SET buyer_snapshot = $2 WHERE id = $1", [round.id, current]); continue; }
        if (current === JSON.stringify(round.buyer_snapshot)) { settling.delete(round.id); continue; }
        // Send the change once it has stayed the same for one check (a company may be mid-edit).
        if (settling.get(round.id) === current) kind = "update";
        else settling.set(round.id, current);
      }
      if (!kind) continue;
      const result = await sendListToBuyer(round, kind);
      settling.delete(round.id);
      if (result.ok) {
        failedAt.delete(round.id);
        console.log(`🛒 ${kind === "new" ? "Stock list" : "Updated list"} for ${round.ref} sent to the buyer`);
      } else {
        failedAt.set(round.id, Date.now());
        console.log(`SUPPLY BUYER SEND (${round.ref}):`, result.error);
        sendPushToUsers(db, ["admin"], { title: "Stock list not sent", body: `${round.ref}: ${result.error}`.slice(0, 180), view: "supply" }).catch(() => {});
      }
    }
  } catch (err) {
    console.log("SUPPLY BUYER TICK ERROR:", err.message);
  }
}

/* ---------- The buyer taps a step on WhatsApp ---------- */
export async function handleSupplyBuyerWhatsApp(msg) {
  if (!db || !msg?.from) return false;
  const choice = msg.interactive?.button_reply?.id || msg.button?.payload || "";
  const tapped = choice.match(/^SB:(\d+):(.+)$/);
  const contact = await buyerContact();
  if (!contact.phone || last10(contact.phone) !== last10(msg.from)) return false;
  if (!tapped) {
    // Anything else from the buyer (e.g. "hi"): never the customer bot. A message listing
    // companies' orders still goes on to the order reader.
    const text = String(msg.text?.body || "");
    if (parseOrderMessage(text).groups.some((group) => group.heading && group.lines.length)) return false;
    const { rows } = await db.query(
      "SELECT * FROM supply_rounds WHERE sent_at IS NOT NULL AND delivery_date >= $1::date ORDER BY delivery_date, id LIMIT 3",
      [istNow().slice(0, 10)]
    );
    if (!rows.length) {
      await sendWhatsApp(msg.from, `Hi${contact.name ? ` ${contact.name}` : ""} 👋 No stock list right now. You'll get it here as soon as the orders are in.`);
      return true;
    }
    for (const raw of rows) {
      const round = { ...raw, delivery_date: plainDate(raw.delivery_date) };
      const { url } = await linkFor(round);
      const next = nextStep(round.buyer_status);
      const body = `🛒 Stock list for ${dayLabel(round.delivery_date)} (${round.ref})${round.buyer_status ? ` · now: ${round.buyer_status}` : ""}\n${url}`;
      if (next) await sendWhatsAppButtons(msg.from, body, [{ id: `SB:${round.id}:${next}`, title: next }]);
      else await sendWhatsApp(msg.from, body);
    }
    return true;
  }
  const round = await roundById(tapped[1]);
  if (!round) {
    await sendWhatsApp(msg.from, "That delivery date isn't on the dashboard any more.");
    return true;
  }
  const updated = await setStep(round, tapped[2], contact.name);
  if (!updated) return false;
  const next = nextStep(updated.buyer_status);
  const { url } = await linkFor(updated);
  const text = `${STEP_TEXT[updated.buyer_status]} · ${round.ref} (${dayLabel(round.delivery_date)})`;
  if (next) {
    await sendWhatsAppButtons(msg.from, `${text}\n\nFill what you bought, price, place and margin: ${url}\n\nTap the next step when it's done.`, [{ id: `SB:${round.id}:${next}`, title: next }]);
  } else {
    await sendWhatsApp(msg.from, `${text}. Thank you! 🙏`);
  }
  return true;
}

/* ---------- Routes ---------- */
const recent = new Map();
function tooMany(token) {
  const now = Date.now();
  const list = (recent.get(token) || []).filter((time) => now - time < 3600000);
  list.push(now);
  recent.set(token, list);
  return list.length > 120;
}

async function roundByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) return null;
  const { rows } = await db.query("SELECT * FROM supply_rounds WHERE buyer_token = $1", [token]);
  return rows[0] ? { ...rows[0], delivery_date: plainDate(rows[0].delivery_date) } : null;
}

async function vendorFor(place) {
  const name = String(place || "").trim().slice(0, 120);
  if (!name) return null;
  const { rows } = await db.query("SELECT id FROM supply_vendors WHERE LOWER(name) = LOWER($1)", [name]);
  if (rows[0]) return rows[0].id;
  const { rows: created } = await db.query("INSERT INTO supply_vendors (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [name]);
  return created[0].id;
}

export function registerSupplyBuyerRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  // Admin Settings → Direct Supply buyer.
  app.get("/admin/supply-buyer", auth, handle("SUPPLY BUYER SETTINGS", async (req, res) => {
    res.json(await buyerContact());
  }));

  app.put("/admin/supply-buyer", auth, handle("SUPPLY BUYER SETTINGS SAVE", async (req, res) => {
    const body = req.body || {};
    const phone = String(body.phone || "").trim();
    if (phone && String(phone).replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Enter the buyer's full WhatsApp number" });
    const value = {
      name: String(body.name || "").trim().slice(0, 80),
      phone,
      auto: body.auto !== false,
      cutoff: /^\d{2}:\d{2}$/.test(body.cutoff || "") ? body.cutoff : "18:00",
      origin: /^https?:\/\//.test(body.origin || "") ? String(body.origin).slice(0, 200) : "",
    };
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_buyer_contact', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(value)]
    );
    res.locals.activity = { section: "Admin Settings", action: `Direct Supply buyer set to ${value.name || value.phone || "nobody"}` };
    res.json(await buyerContact());
  }));

  // For the Buy page: who the buyer is (no number), and when the list goes out.
  app.get("/supply/buyer-info", auth, handle("SUPPLY BUYER INFO", async (req, res) => {
    const contact = await buyerContact();
    res.json({ name: contact.name, has_phone: Boolean(contact.phone), auto: contact.auto, cutoff: contact.cutoff, steps: BUYER_STEPS });
  }));

  // Send now from the dashboard (the full list again).
  app.post("/supply/rounds/:id/send", auth, handle("SUPPLY SEND", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const result = await sendListToBuyer(round, "new");
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.locals.activity = { section: "Direct Supply", action: `Sent ${round.ref} stock list to the buyer` };
    res.json({ success: true, ...result, round: await roundById(round.id) });
  }));

  // The dashboard can open the buyer's page too.
  app.get("/supply/rounds/:id/buyer-link", auth, handle("SUPPLY BUYER LINK", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    res.json(await linkFor(round));
  }));

  /* ---------- The buyer's phone page (no login: the link is the key) ---------- */
  const pageData = async (round) => {
    const sheet = await masterOf(round.id);
    const buying = await buyingOf(round.id, sheet);
    const { rows: mine } = await db.query(
      `SELECT pu.product_id, pu.unit, pu.qty, pu.price, pu.margin_percent, v.name AS place
       FROM supply_purchases pu LEFT JOIN supply_vendors v ON v.id = pu.vendor_id
       WHERE pu.round_id = $1 AND pu.source = 'buyer'`,
      [round.id]
    );
    const { rows: places } = await db.query("SELECT name FROM supply_vendors WHERE active = TRUE ORDER BY name");
    const seller = (await setting("supply_seller")) || {};
    const companyName = new Map(sheet.companies.map((company) => [String(company.id), company.name]));
    return {
      seller: seller.name || "Snackit",
      round: { ref: round.ref, delivery_date: round.delivery_date, title: round.title, buyer_status: round.buyer_status, buyer_steps: round.buyer_steps || {} },
      steps: BUYER_STEPS,
      items: buying.rows.filter((row) => row.need > 0).map((row) => {
        const own = mine.find((item) => item.product_id === row.product_id && item.unit === row.unit);
        return {
          key: row.key, product_id: row.product_id, name: row.name, unit: row.unit, need: row.need,
          for: Object.entries(sheet.master.find((item) => item.key === row.key)?.by_company || {}).map(([id, qty]) => ({ name: companyName.get(id) || "", qty: Number(qtyText(qty)) })),
          last: row.best ? { price: row.best.price, place: row.best.vendor_name } : null,
          bought: own ? { qty: Number(own.qty), price: Number(own.price), place: own.place || "", margin: own.margin_percent == null ? null : Number(own.margin_percent) } : null,
        };
      }),
      places: places.map((place) => place.name),
    };
  };

  app.get("/public/supply/buy/:token", handle("BUYER PAGE", async (req, res) => {
    const round = await roundByToken(req.params.token);
    if (!round) return res.status(404).json({ error: "This link isn't valid any more. Ask Snackit for the latest list." });
    res.json(await pageData(round));
  }));

  app.post("/public/supply/buy/:token/status", handle("BUYER PAGE STATUS", async (req, res) => {
    const round = await roundByToken(req.params.token);
    if (!round) return res.status(404).json({ error: "This link isn't valid any more." });
    if (tooMany(req.params.token)) return res.status(429).json({ error: "Too many changes. Try again in a while." });
    const contact = await buyerContact();
    if (!(await setStep(round, String(req.body?.step || ""), contact.name))) return res.status(400).json({ error: "Unknown step" });
    res.json(await pageData(await roundByToken(req.params.token)));
  }));

  // Saves what he bought: replaces his earlier entry per item. Margin % sets the item's selling price.
  app.post("/public/supply/buy/:token/items", handle("BUYER PAGE ITEMS", async (req, res) => {
    const round = await roundByToken(req.params.token);
    if (!round) return res.status(404).json({ error: "This link isn't valid any more." });
    if (tooMany(req.params.token)) return res.status(429).json({ error: "Too many changes. Try again in a while." });
    const contact = await buyerContact();
    const by = contact.name || "Buyer";
    const sheet = await masterOf(round.id);
    const known = new Set(sheet.master.filter((row) => row.product_id).map((row) => `${row.product_id}|${row.unit}`));
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : [];
    let saved = 0;
    for (const item of items) {
      const productId = Number(item.product_id);
      if (!known.has(`${productId}|${item.unit}`)) continue;
      const qty = Number(item.qty);
      const price = item.price === "" || item.price == null ? NaN : Number(item.price);
      const margin = item.margin === "" || item.margin == null ? null : Number(item.margin);
      await db.query("DELETE FROM supply_purchases WHERE round_id = $1 AND product_id = $2 AND unit = $3 AND source = 'buyer'", [round.id, productId, item.unit]);
      if (!(qty > 0) || !(price >= 0)) continue;
      const vendorId = await vendorFor(item.place);
      await db.query(
        "INSERT INTO supply_purchases (round_id, product_id, vendor_id, unit, qty, price, bought_by, source, margin_percent) VALUES ($1, $2, $3, $4, $5, $6, $7, 'buyer', $8)",
        [round.id, productId, vendorId, item.unit, qty, price, by, margin != null && margin >= 0 && margin < 1000 ? margin : null]
      );
      if (vendorId) await db.query("INSERT INTO supply_prices (product_id, vendor_id, unit, price, round_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)", [productId, vendorId, item.unit, price, round.id, by]);
      if (margin != null && margin >= 0 && margin < 1000 && price > 0) {
        await db.query("UPDATE supply_products SET sell_price = $3 WHERE id = $1 AND unit = $2", [productId, item.unit, Math.round(price * (1 + margin / 100) * 100) / 100]);
      }
      saved += 1;
    }
    await db.query("UPDATE supply_rounds SET updated_at = NOW() WHERE id = $1", [round.id]);
    onChange();
    if (saved) sendPushToUsers(db, ["admin"], { title: "Buyer updated purchases", body: `${by}: ${saved} item${saved === 1 ? "" : "s"} for ${round.ref} (${dayLabel(round.delivery_date)})`, view: "supply" }).catch(() => {});
    res.json({ saved, ...(await pageData(round)) });
  }));
}

