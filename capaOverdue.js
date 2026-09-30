/* =========================================================
    CAPA OVERDUE ALERTS
    A CAPA task still open 24 hours after it was raised is overdue. The people set up
    in Admin Settings → "CAPA overdue alerts" (e.g. Monish) get a WhatsApp message
    once, when it crosses 24 hours, and a reminder every day at 10 am listing the
    tasks that are still overdue. The Refill Audit page shows overdue tasks in red.

    Outside WhatsApp's 24-hour window the approved template CAPA_OVERDUE_TEMPLATE
    (default "capa_overdue", language CAPA_OVERDUE_TEMPLATE_LANG, "en") is sent:
    body {{1}} what is overdue (a task ref, or "3 tasks"), {{2}} the details, and one
    quick-reply button "Mark resolved".

    Tapping "Mark resolved" (or picking a task from the list sent for several) marks the
    CAPA task resolved on the dashboard as "<name> (WhatsApp)", tells the refiller, and
    asks who fixed it (refiller / team or person / themselves); a name or note typed
    in the next 15 minutes is saved with the task.
========================================================= */
import { sendWhatsApp, sendWhatsAppPayload, sendWhatsAppButtons, sendWhatsAppList } from "./whatsapp.js";
import { sendWithFallback, noteInbound } from "./whatsappOutbox.js";

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

// One task: a "Mark resolved" button. Several: the text, then a list to pick the resolved one.
async function sendToContacts(contacts, text, headline, details, tasks) {
  let sent = 0;
  const single = tasks.length === 1;
  const payload = single ? `CAPA_OD_YES:${tasks[0].id}` : "CAPA_OD_LIST";
  for (const contact of contacts) {
    const to = phoneDigits(contact.phone);
    const result = await sendWithFallback({
      kind: "capa_overdue",
      to,
      send: async () => {
        if (single) return sendWhatsAppButtons(to, text, [{ id: payload, title: "Mark resolved" }]);
        const first = await sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
        if (first.ok) await sendResolveList(to, tasks);
        return first;
      },
      template: process.env.CAPA_OVERDUE_TEMPLATE === "off" ? null : {
        name: process.env.CAPA_OVERDUE_TEMPLATE || "capa_overdue",
        lang: process.env.CAPA_OVERDUE_TEMPLATE_LANG || "en",
        params: [oneLine(headline), oneLine(details)],
        buttons: [payload],
      },
    }).catch((err) => ({ ok: false, error: err.message }));
    if (result.ok) sent += 1;
    else console.log(`CAPA OVERDUE ALERT to ${contact.name} failed:`, result.error);
  }
  return sent;
}

/* ---------- "Mark resolved" on WhatsApp ---------- */

const NOTE_WINDOW_MS = 15 * 60 * 1000;
const WHO_FIXED = { R: "Refiller fixed it", T: "Team / person fixed it", S: "Fixed it myself" };

// Open overdue tasks as a tappable list (WhatsApp shows up to 10).
async function sendResolveList(to, tasks) {
  const open = tasks.filter((task) => task.status === "OPEN").slice(0, 10);
  if (!open.length) return null;
  return sendWhatsAppList(
    to,
    open.length === 1 ? "Tap below once it's fixed." : "Which task is fixed? Pick one; send the list again with *resolved* to mark another.",
    "Mark resolved",
    "Overdue CAPA tasks",
    open.map((task) => ({ id: `CAPA_OD_YES:${task.id}`, title: task.ref.slice(0, 24), description: `${task.defect || "Issue"} · ${task.location || ""}`.slice(0, 72) }))
  );
}

async function contactFor(phone) {
  const { rows } = await db.query("SELECT name, phone FROM capa_overdue_contacts");
  return rows.find((row) => phoneDigits(row.phone) === phone) || null;
}

async function overdueTasks() {
  const { rows } = await db.query(`SELECT * FROM audit_capa WHERE ${overdueSql} ORDER BY created_at`);
  return rows;
}

// Returns true when the message was an overdue contact answering (it never reaches the customer bot).
export async function handleCapaOverdueWhatsApp(msg) {
  if (!db || !msg?.from) return false;
  const phone = phoneDigits(msg.from);
  const choice = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || msg.button?.payload || "";
  const tapped = choice.match(/^CAPA_OD_(YES|LIST|HOW)(?::(\d+))?(?::([RTS]))?$/);
  const text = String(msg.text?.body || "").trim();

  if (tapped || /^(resolved|mark resolved|overdue)$/i.test(text)) {
    const contact = await contactFor(phone);
    if (!contact) return false;
    await noteInbound(phone);
    const [, action = "LIST", id, how] = tapped || [];

    if (action === "LIST") {
      const tasks = await overdueTasks();
      if (!tasks.length) await sendWhatsApp(phone, `No overdue CAPA tasks right now, ${contact.name}. 👍`);
      else await sendResolveList(phone, tasks);
      return true;
    }

    const { rows } = await db.query("SELECT * FROM audit_capa WHERE id = $1", [id]);
    const task = rows[0];
    if (!task) {
      await sendWhatsApp(phone, "That task could not be found. It may have been removed.");
      return true;
    }

    if (action === "HOW") {
      await db.query(
        `UPDATE audit_capa SET resolution_note = $2, resolve_note_phone = $3, resolve_note_until = NOW() + ($4 * INTERVAL '1 millisecond') WHERE id = $1`,
        [task.id, WHO_FIXED[how], phone, NOTE_WINDOW_MS]
      );
      const ask = how === "T" ? "Who fixed it? Reply with their name (and anything worth noting)." : "Anything to note? Reply in the next 15 minutes, or ignore this.";
      await sendWhatsApp(phone, `Saved: ${WHO_FIXED[how].toLowerCase()}. ${ask}`);
      return true;
    }

    // YES: mark resolved.
    if (task.status === "RESOLVED") {
      await sendWhatsApp(phone, `${task.ref} is already resolved${task.resolved_by ? ` (by ${task.resolved_by.replace(" (WhatsApp)", "")})` : ""}. ✅`);
      return true;
    }
    await db.query(
      "UPDATE audit_capa SET status = 'RESOLVED', resolved_by = $2, resolved_at = NOW(), note_open_until = NULL WHERE id = $1",
      [task.id, `${contact.name} (WhatsApp)`]
    );
    console.log(`✅ ${task.ref} resolved by ${contact.name} from the overdue alert`);
    if (task.refiller_phone) {
      const to = phoneDigits(task.refiller_phone);
      await sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: `${task.ref} at ${task.location} is marked resolved by ${contact.name}. No action needed. Thank you!` } }).catch(() => {});
    }
    await sendWhatsAppButtons(phone, `✅ ${task.ref} (${task.defect || "task"} · ${task.location || ""}) is marked *resolved* on the dashboard.\n\nWho fixed it?`, [
      { id: `CAPA_OD_HOW:${task.id}:R`, title: "Refiller" },
      { id: `CAPA_OD_HOW:${task.id}:T`, title: "Team / person" },
      { id: `CAPA_OD_HOW:${task.id}:S`, title: "I fixed it" },
    ]);
    const left = (await overdueTasks()).length;
    if (left) await sendWhatsApp(phone, `${left} more overdue task${left === 1 ? "" : "s"}. Reply *resolved* to see the list.`);
    return true;
  }

  // A name or note right after "Who fixed it?".
  if (msg.type !== "text" || !text) return false;
  const { rows } = await db.query(
    "SELECT id, ref, resolution_note FROM audit_capa WHERE resolve_note_phone = $1 AND resolve_note_until > NOW() ORDER BY resolve_note_until DESC LIMIT 1",
    [phone]
  ).catch(() => ({ rows: [] }));
  if (!rows[0]) return false;
  await noteInbound(phone);
  const note = [rows[0].resolution_note, text].filter(Boolean).join(": ").slice(0, 500);
  await db.query("UPDATE audit_capa SET resolution_note = $2, resolve_note_until = NULL WHERE id = $1", [rows[0].id, note]);
  await sendWhatsApp(phone, `📝 Saved on ${rows[0].ref}. Thank you!`);
  return true;
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
  await db.query(`
    ALTER TABLE audit_capa
      ADD COLUMN IF NOT EXISTS overdue_alerted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS resolution_note TEXT,
      ADD COLUMN IF NOT EXISTS resolve_note_phone TEXT,
      ADD COLUMN IF NOT EXISTS resolve_note_until TIMESTAMPTZ
  `);
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
        for (const task of fresh) await sendToContacts(contacts, singleMessage(task), task.ref, summaryLine(task).replace(`${task.ref}: `, ""), [task]);
      } else {
        await sendToContacts(contacts, listMessage(fresh, `⚠️ *${fresh.length} CAPA tasks not resolved in ${OVERDUE_HOURS} hours*`), `${fresh.length} tasks`, fresh.map(summaryLine).join(" | "), fresh);
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
      await sendToContacts(contacts, listMessage(still, title), `${still.length} task${still.length === 1 ? "" : "s"} still open`, still.map(summaryLine).join(" | "), still);
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
