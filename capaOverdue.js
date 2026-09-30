/* =========================================================
    CAPA OVERDUE ALERTS
    A CAPA task still open 24 hours after it was raised is overdue. The people set up
    in Admin Settings → "CAPA overdue alerts" (e.g. Monish) get a WhatsApp message
    once, when it crosses 24 hours, and a reminder every day at 10 am listing the
    tasks that are still overdue. The Refill Audit page shows overdue tasks in red.

    Outside WhatsApp's 24-hour window the approved template CAPA_OVERDUE_TEMPLATE
    (default "capa_overdue", language CAPA_OVERDUE_TEMPLATE_LANG, "en") is sent:
    body {{1}} what is overdue (a task ref, or "3 tasks"), {{2}} the details.
========================================================= */
import { sendWhatsAppPayload } from "./whatsapp.js";
import { sendWithFallback } from "./whatsappOutbox.js";

export const OVERDUE_HOURS = 24;
const DIGEST_HOUR_IST = 10;
const MAX_SINGLE_ALERTS = 5; // more at once (e.g. tasks already overdue when Monish is added) go as one summary
let db = null;
let running = false;
let ready = false;

const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

function openFor(createdAt) {
  const hours = Math.floor((Date.now() - new Date(createdAt).getTime()) / 3600000);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Where the task stands on the refiller's side.
function progress(task) {
  if (task.refiller_reply === "CANT_DO") return `refiller can't do it${task.escalated_to ? `, sent to ${task.escalated_to}` : ""}`;
  if (task.refiller_reply === "NOT_RESOLVED") return "refiller replied Not yet";
  if (task.whatsapp_status === "FAILED") return "not delivered to the refiller";
  if (task.whatsapp_status === "SENT") return "no reply from the refiller";
  return "not sent to the refiller";
}

const summaryLine = (task) => `${task.ref}: ${task.defect || "Issue"} · ${task.location || "—"} · ${task.refiller || "no refiller"} · open ${openFor(task.created_at)} · ${progress(task)}`;

function singleMessage(task) {
  return [
    `⚠️ *CAPA not resolved in ${OVERDUE_HOURS} hours*`,
    "",
    `*${task.ref}*${task.severity ? ` · ${task.severity}` : ""}`,
    `Issue: ${task.defect || "—"}`,
    `📍 ${task.location || "—"}`,
    `Refiller: ${task.refiller || "—"}`,
    `Open for: ${openFor(task.created_at)}`,
    `Status: ${progress(task)}`,
    "",
    "Please follow up.",
  ].join("\n");
}

function listMessage(tasks, title) {
  const shown = tasks.slice(0, 15);
  return [
    title,
    "",
    ...shown.map((task, index) => `${index + 1}. ${summaryLine(task)}`),
    tasks.length > shown.length ? `…and ${tasks.length - shown.length} more on the dashboard (Refill Audit → CAPA).` : "",
    "",
    "Please follow up.",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
}

// Template parameters can't hold line breaks.
const oneLine = (text) => String(text || "").replace(/\s*\n+\s*/g, " | ").replace(/\s{4,}/g, "   ").slice(0, 900) || "-";

async function sendToContacts(contacts, text, headline, details) {
  let sent = 0;
  for (const contact of contacts) {
    const to = phoneDigits(contact.phone);
    const result = await sendWithFallback({
      kind: "capa_overdue",
      to,
      send: () => sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
      template: process.env.CAPA_OVERDUE_TEMPLATE === "off" ? null : {
        name: process.env.CAPA_OVERDUE_TEMPLATE || "capa_overdue",
        lang: process.env.CAPA_OVERDUE_TEMPLATE_LANG || "en",
        params: [oneLine(headline), oneLine(details)],
      },
    }).catch((err) => ({ ok: false, error: err.message }));
    if (result.ok) sent += 1;
    else console.log(`CAPA OVERDUE ALERT to ${contact.name} failed:`, result.error);
  }
  return sent;
}

export async function ensureCapaOverdue(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS capa_overdue_contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await addColumn();
}

// The audit tables are created as the server starts; the column is added once they exist.
async function addColumn() {
  if (ready) return;
  await db.query("ALTER TABLE audit_capa ADD COLUMN IF NOT EXISTS overdue_alerted_at TIMESTAMPTZ");
  ready = true;
}

const overdueSql = `status = 'OPEN' AND created_at < NOW() - INTERVAL '${OVERDUE_HOURS} hours'`;
const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const hourIst = () => new Date(Date.now() + 5.5 * 3600000).getUTCHours();

// Every few minutes: alert on tasks that just crossed 24 hours; at 10 am, the daily reminder.
export async function capaOverdueTick() {
  if (!db || running) return;
  running = true;
  try {
    await addColumn();
    const { rows: contacts } = await db.query("SELECT name, phone FROM capa_overdue_contacts ORDER BY id");
    if (!contacts.length) return;

    const { rows: fresh } = await db.query(`SELECT * FROM audit_capa WHERE ${overdueSql} AND overdue_alerted_at IS NULL ORDER BY created_at`);
    if (fresh.length) {
      if (fresh.length <= MAX_SINGLE_ALERTS) {
        for (const task of fresh) await sendToContacts(contacts, singleMessage(task), task.ref, summaryLine(task).replace(`${task.ref}: `, ""));
      } else {
        await sendToContacts(contacts, listMessage(fresh, `⚠️ *${fresh.length} CAPA tasks not resolved in ${OVERDUE_HOURS} hours*`), `${fresh.length} tasks`, fresh.map(summaryLine).join(" | "));
      }
      await db.query("UPDATE audit_capa SET overdue_alerted_at = NOW() WHERE id = ANY($1)", [fresh.map((task) => task.id)]);
      console.log(`⚠️ CAPA overdue alert: ${fresh.map((task) => task.ref).join(", ")} → ${contacts.map((contact) => contact.name).join(", ")}`);
    }

    // Daily reminder: tasks already alerted before today and still open.
    const today = todayIst();
    if (hourIst() < DIGEST_HOUR_IST) return;
    const { rows: last } = await db.query("SELECT value FROM app_settings WHERE key = 'capa_overdue_digest_on'").catch(() => ({ rows: [] }));
    if (last[0]?.value === today) return;
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('capa_overdue_digest_on', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [today]
    );
    const { rows: still } = await db.query(
      `SELECT * FROM audit_capa WHERE ${overdueSql} AND overdue_alerted_at < ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata') ORDER BY created_at`,
      [today]
    );
    if (still.length) {
      const title = `⏰ *${still.length} CAPA task${still.length === 1 ? "" : "s"} still not resolved*`;
      await sendToContacts(contacts, listMessage(still, title), `${still.length} task${still.length === 1 ? "" : "s"} still open`, still.map(summaryLine).join(" | "));
      console.log(`⏰ CAPA overdue daily reminder: ${still.length} task(s)`);
    }
  } catch (err) {
    console.log("CAPA OVERDUE CHECK ERROR:", err.message);
  } finally {
    running = false;
  }
}

export function registerCapaOverdueRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  app.get("/audit/overdue-contacts", auth, handle("CAPA OVERDUE CONTACTS", async (req, res) => {
    const { rows } = await db.query("SELECT id, name, phone FROM capa_overdue_contacts ORDER BY id");
    res.json(rows);
  }));

  app.put("/audit/overdue-contacts", auth, handle("CAPA OVERDUE CONTACTS SAVE", async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only admins can change this" });
    const contacts = [];
    for (const item of (Array.isArray(req.body?.contacts) ? req.body.contacts : []).slice(0, 20)) {
      const name = String(item?.name || "").trim().slice(0, 80);
      const digits = String(item?.phone || "").replace(/\D/g, "");
      if (!name && !digits) continue;
      if (!name) return res.status(400).json({ error: "Every person needs a name" });
      if (digits.length < 10 || digits.length > 13) return res.status(400).json({ error: `Enter ${name}'s WhatsApp number with 10 digits (or 91 + 10 digits)` });
      contacts.push({ name, phone: digits });
    }
    await db.query("DELETE FROM capa_overdue_contacts");
    for (const contact of contacts) await db.query("INSERT INTO capa_overdue_contacts (name, phone) VALUES ($1, $2)", [contact.name, contact.phone]);
    res.locals.activity = { section: "Refill Audit", action: `Set CAPA overdue alerts to: ${contacts.map((contact) => contact.name).join(", ") || "nobody"}` };
    const { rows } = await db.query("SELECT id, name, phone FROM capa_overdue_contacts ORDER BY id");
    res.json(rows);
  }));
}
