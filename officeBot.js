/* =========================================================
    OFFICE WHATSAPP NUMBER (coexistence) + OFFICE BOT
    The director's office number stays on his WhatsApp Business app and is also connected to our
    Meta app (Embedded Signup v4, "Connect existing WhatsApp Business app"). Admin Settings →
    "Office WhatsApp number" connects it (app ID / configuration ID below; META_APP_SECRET on Render).

    Webhooks for that number (matched by metadata.phone_number_id) never reach the customer refund
    bot; they come here:
      • a new person messaging gets the office bot: a menu (refund / list your product / rent a
        machine / buy a machine / direct supply / talk to the team), then a few questions
        (name, company, city, what they need) → a lead on the Office Leads page + a phone alert;
      • the director's saved contacts (synced from his app) are never answered by the bot;
      • when the director replies from his phone (smb_message_echoes), the bot stays quiet in that
        chat for 12 hours (Admin Settings), so the two never talk over each other.
    Contacts are synced once after connecting (smb_app_data, within 24 hours). Old chat history is
    not imported (not needed for leads).
========================================================= */
import axios from "axios";
import { sendPushToUsers } from "./pushNotifications.js";

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v23.0"}`;
export const META_APP_ID = process.env.META_APP_ID || "970407229041334";
export const META_CONFIG_ID = process.env.META_CONFIG_ID || "2604764139965565";
const SETTINGS_KEY = "office_whatsapp";
const COEXISTENCE_FIELDS = ["smb_message_echoes", "smb_app_state_sync", "history", "account_update"];

let db = null;
let audience = () => ["admin"]; // who gets the phone alert for a new lead
let office = null; // cached settings
const digits = (phone) => String(phone || "").replace(/\D/g, "");

export async function ensureOfficeBot(database, { leadAudience } = {}) {
  db = database;
  if (leadAudience) audience = leadAudience;
  await db.query(`
    CREATE TABLE IF NOT EXISTS office_chats (
      phone TEXT PRIMARY KEY, name TEXT, state TEXT, data JSONB NOT NULL DEFAULT '{}'::jsonb,
      paused_until TIMESTAMPTZ, last_in_at TIMESTAMPTZ, last_bot_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS office_contacts (phone TEXT PRIMARY KEY, name TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS office_leads (
      id SERIAL PRIMARY KEY, ref TEXT, phone TEXT NOT NULL, wa_name TEXT, name TEXT, company TEXT, city TEXT,
      kind TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'New', notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT
    );
  `);
  await loadOffice();
}

async function loadOffice() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [SETTINGS_KEY]).catch(() => ({ rows: [] }));
  try { office = rows[0] ? JSON.parse(rows[0].value) : null; } catch { office = null; }
  return office;
}
async function saveOffice(next) {
  office = next;
  if (!next) return db.query("DELETE FROM app_settings WHERE key = $1", [SETTINGS_KEY]);
  return db.query(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [SETTINGS_KEY, JSON.stringify(next)]
  );
}
const token = () => office?.token || process.env.WHATSAPP_TOKEN;

/* ---------- Sending from the office number ---------- */
async function send(payload) {
  if (!office?.phone_number_id) return { ok: false };
  try {
    const response = await axios.post(`${GRAPH}/${office.phone_number_id}/messages`, { messaging_product: "whatsapp", ...payload }, {
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    });
    return { ok: true, id: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.log("OFFICE WHATSAPP SEND ERROR:", err.response?.data?.error?.message || err.message);
    return { ok: false, error: err.response?.data?.error?.message || err.message };
  }
}
const text = (to, body) => send({ to, type: "text", text: { body: String(body).slice(0, 4096) } });
const list = (to, body, button, rows) => send({
  to, type: "interactive",
  interactive: { type: "list", body: { text: body }, action: { button, sections: [{ title: "Choose one", rows }] } },
});

/* ---------- The office bot ---------- */
const KINDS = {
  OB_LIST: { kind: "List a product", ask: "Tell us about your product: brand, what it is, price and pack size. 🛒" },
  OB_RENT: { kind: "Rent a machine", ask: "Where would the machine go (office, factory, college…) and about how many people are there? 🏢" },
  OB_BUY: { kind: "Buy a machine", ask: "How many machines do you need, and for which location? 🤝" },
  OB_SUPPLY: { kind: "Direct supply", ask: "What would you like supplied (fruits, snacks, drinks…), how often, and for how many people? 🍎" },
};
const MENU_ROWS = [
  { id: "OB_REFUND", title: "Refund / machine issue", description: "Money deducted, product not received" },
  { id: "OB_LIST", title: "List your product", description: "Sell your brand in Snackit machines" },
  { id: "OB_RENT", title: "Rent a machine", description: "A vending machine at your place" },
  { id: "OB_BUY", title: "Buy a machine", description: "Buy vending machines" },
  { id: "OB_SUPPLY", title: "Direct supply", description: "Fruits & snacks for your office" },
  { id: "OB_TEAM", title: "Talk to our team", description: "A person will reply here" },
];
const QUESTIONS = { ask_name: "May I have your name? 🙂", ask_company: "Which company or organisation are you from?", ask_city: "Which city / area is this for? 📍" };
const NEXT = { ask_name: "ask_company", ask_company: "ask_city", ask_city: "ask_details" };

async function supportNumber() {
  if (process.env.SUPPORT_WHATSAPP) return digits(process.env.SUPPORT_WHATSAPP);
  if (supportNumber.cached) return supportNumber.cached;
  try {
    const { data } = await axios.get(`${GRAPH}/${process.env.PHONE_NUMBER_ID}`, { params: { fields: "display_phone_number" }, headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    supportNumber.cached = digits(data.display_phone_number);
  } catch { supportNumber.cached = ""; }
  return supportNumber.cached;
}

async function sendMenu(to, name, again = false) {
  await list(to, again
    ? "Please choose one of these options 👇"
    : `Hi${name ? ` ${name}` : ""} 👋 Welcome to *Snackit*!\n\nHow can we help you today? Tap the button below and choose an option.`, "Choose an option", MENU_ROWS);
}
const chatOf = async (phone) => (await db.query("SELECT * FROM office_chats WHERE phone = $1", [phone])).rows[0] || null;
async function setChat(phone, fields) {
  const keys = Object.keys(fields);
  await db.query(
    `INSERT INTO office_chats (phone, ${keys.join(", ")}, updated_at) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}, NOW())
     ON CONFLICT (phone) DO UPDATE SET ${keys.map((key) => `${key} = EXCLUDED.${key}`).join(", ")}, updated_at = NOW()`,
    [phone, ...keys.map((key) => (key === "data" ? JSON.stringify(fields[key]) : fields[key]))]
  );
}

async function handleIncoming(msg, contactName) {
  const phone = digits(msg.from);
  if (!phone || office?.bot_on === false) return;
  // The director's saved contacts are his own chats: the bot never answers them.
  const { rows: saved } = await db.query("SELECT 1 FROM office_contacts WHERE phone = $1", [phone]);
  if (saved.length) return;
  const chat = await chatOf(phone);
  await setChat(phone, { last_in_at: new Date(), name: contactName || chat?.name || null });
  if (chat?.paused_until && new Date(chat.paused_until) > new Date()) return; // the director is talking to them
  const choice = msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id || "";
  const said = String(msg.text?.body || msg.button?.text || "").trim();
  const data = chat?.data || {};
  const fresh = !chat?.state || (chat.last_in_at && Date.now() - new Date(chat.last_in_at).getTime() > 24 * 3600000 && chat.state === "done");

  if (/^(hi|hii+|hello|hey|menu|start|restart)\b/i.test(said) || fresh && !choice && !(chat?.state || "").startsWith("ask_")) {
    await sendMenu(phone, contactName);
    return setChat(phone, { state: "menu", data: {}, last_bot_at: new Date() });
  }
  if (choice === "OB_REFUND") {
    const support = await supportNumber();
    await text(phone, `For a refund or a problem with a machine, please message our support number${support ? `: https://wa.me/${support}` : ""}\n\nSend *hi* there and our bot will help you right away (keep your UPI payment screenshot ready). 🙏`);
    return setChat(phone, { state: "done", data: {}, last_bot_at: new Date() });
  }
  if (choice === "OB_TEAM") {
    await text(phone, "Sure 🙂 Someone from our team will reply to you here shortly.");
    await setChat(phone, { state: "done", data: {}, paused_until: new Date(Date.now() + pauseMs()), last_bot_at: new Date() });
    return alert(`💬 ${contactName || `+${phone}`} wants to talk to the team`, "Reply to them from the office WhatsApp.");
  }
  if (KINDS[choice]) {
    await text(phone, `Great! Just a few quick questions about *${KINDS[choice].kind.toLowerCase()}*.\n\n${QUESTIONS.ask_name}`);
    return setChat(phone, { state: "ask_name", data: { choice }, last_bot_at: new Date() });
  }
  const answer = said || (msg.type === "image" ? "(sent a photo)" : msg.type === "document" ? "(sent a document)" : msg.type === "audio" ? "(sent a voice note)" : "");
  if ((chat?.state || "").startsWith("ask_") && answer) {
    const step = chat.state;
    const field = { ask_name: "name", ask_company: "company", ask_city: "city", ask_details: "details" }[step];
    const next = { ...data, [field]: answer.slice(0, 1000) };
    if (step === "ask_details") {
      const lead = await saveLead(phone, contactName, next);
      await text(phone, `Thank you${next.name ? `, ${next.name.split(" ")[0]}` : ""}! 🙏 We've noted your request (${lead.ref}). Our team will get back to you soon.\n\nType *menu* anytime to start again.`);
      await setChat(phone, { state: "done", data: {}, last_bot_at: new Date() });
      return alert(`🆕 New lead: ${lead.kind} · ${lead.name || contactName || `+${phone}`}`, `${lead.company ? `${lead.company} · ` : ""}${lead.city || ""} · ${String(lead.details || "").slice(0, 80)}`);
    }
    const nextStep = NEXT[step];
    await text(phone, nextStep === "ask_details" ? KINDS[data.choice]?.ask || "What do you need?" : QUESTIONS[nextStep]);
    return setChat(phone, { state: nextStep, data: next, last_bot_at: new Date() });
  }
  if (chat?.state === "menu") {
    await sendMenu(phone, null, true);
    return setChat(phone, { last_bot_at: new Date() });
  }
  // Already answered and noted: one gentle line, then quiet (the team replies from the app).
  if (chat?.state === "done" && !data.nudged) {
    await text(phone, "Thanks for your message 🙏 Our team will reply here. Type *menu* to see the options again.");
    return setChat(phone, { data: { ...data, nudged: true }, last_bot_at: new Date() });
  }
}

const pauseMs = () => Math.max(1, Number(office?.pause_hours) || 12) * 3600000;
function alert(title, body) {
  return sendPushToUsers(db, audience(), { title, body: String(body).slice(0, 180), view: "office-leads" }).catch(() => {});
}
async function saveLead(phone, waName, data) {
  const kind = KINDS[data.choice]?.kind || "Enquiry";
  const { rows } = await db.query(
    "INSERT INTO office_leads (phone, wa_name, name, company, city, kind, details) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [phone, waName || null, data.name || null, data.company || null, data.city || null, kind, data.details || null]
  );
  const { rows: saved } = await db.query("UPDATE office_leads SET ref = 'LD-' || LPAD(id::text, 4, '0') WHERE id = $1 RETURNING *", [rows[0].id]);
  return saved[0];
}

/* ---------- Webhook: everything for the office number ends here ---------- */
// Returns true when the webhook was for the office number (so the refund bot doesn't see it).
export async function handleOfficeWebhook(body) {
  if (!db || !office?.phone_number_id) return false;
  let mine = false;
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const forOffice = String(value.metadata?.phone_number_id || "") === String(office.phone_number_id)
        || (COEXISTENCE_FIELDS.includes(change.field) && String(entry.id || "") === String(office.waba_id || ""));
      if (!forOffice) continue;
      mine = true;
      try {
        // The director wrote to someone from his phone: the bot stays out of that chat for a while.
        for (const echo of value.message_echoes || []) {
          const to = digits(echo.to);
          if (to) await setChat(to, { paused_until: new Date(Date.now() + pauseMs()) });
        }
        // His contacts (added / removed in the app): never answered by the bot.
        for (const item of value.state_sync || []) {
          const phone = digits(item.contact?.phone_number);
          if (!phone || item.type !== "contact") continue;
          if (item.action === "remove") await db.query("DELETE FROM office_contacts WHERE phone = $1", [phone]);
          else await db.query("INSERT INTO office_contacts (phone, name) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()", [phone, item.contact?.full_name || item.contact?.first_name || null]);
        }
        if (change.field === "account_update") console.log("OFFICE NUMBER ACCOUNT UPDATE:", JSON.stringify(value).slice(0, 300));
        const names = new Map((value.contacts || []).map((contact) => [digits(contact.wa_id), contact.profile?.name]));
        for (const msg of value.messages || []) await handleIncoming(msg, names.get(digits(msg.from)) || null);
      } catch (err) {
        console.log("OFFICE BOT ERROR:", err.message);
      }
    }
  }
  return mine;
}

/* ---------- Routes ---------- */
export function registerOfficeBotRoutes(app, { auth }) {
  const adminOnly = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: "Admin access required" }));
  const who = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Admin");
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      const reason = err.response?.data?.error?.message || err.message;
      console.log(`${label} ERROR:`, reason);
      res.status(500).json({ error: reason?.length < 300 ? reason : "Something went wrong" });
    }
  };
  const view = () => ({
    connected: Boolean(office?.phone_number_id), app_id: META_APP_ID, config_id: META_CONFIG_ID, secret_set: Boolean(process.env.META_APP_SECRET),
    display_phone: office?.display_phone || null, verified_name: office?.verified_name || null, phone_number_id: office?.phone_number_id || null,
    waba_id: office?.waba_id || null, connected_at: office?.connected_at || null, connected_by: office?.connected_by || null,
    bot_on: office?.bot_on !== false, pause_hours: Number(office?.pause_hours) || 12, contacts_synced: office?.contacts_synced || null,
  });

  app.get("/admin/office-whatsapp", auth, adminOnly, handle("OFFICE WA", async (req, res) => {
    await loadOffice();
    const { rows } = await db.query("SELECT (SELECT COUNT(*) FROM office_contacts)::int AS contacts, (SELECT COUNT(*) FROM office_leads)::int AS leads");
    res.json({ ...view(), ...rows[0] });
  }));

  // After Embedded Signup: the code (valid 30 seconds) → the business token; then subscribe our
  // app to the account's webhooks and ask for his contacts (so the bot leaves them alone).
  app.post("/admin/office-whatsapp/connect", auth, adminOnly, handle("OFFICE WA CONNECT", async (req, res) => {
    if (!process.env.META_APP_SECRET) return res.status(400).json({ error: "Add META_APP_SECRET (the app secret) in Render → Environment first." });
    const { code } = req.body || {};
    const phoneNumberId = digits(req.body?.phone_number_id);
    const wabaId = digits(req.body?.waba_id);
    if (!code) return res.status(400).json({ error: "Facebook didn't send the sign-in code. Please try again." });
    if (!phoneNumberId || !wabaId) return res.status(400).json({ error: "Facebook didn't say which number was connected. Please try again and finish all the steps." });
    if (phoneNumberId === digits(process.env.PHONE_NUMBER_ID)) return res.status(400).json({ error: "That is the refund bot's number. Choose the office number." });
    const { data: tokenData } = await axios.get(`${GRAPH}/oauth/access_token`, { params: { client_id: META_APP_ID, client_secret: process.env.META_APP_SECRET, code } });
    const businessToken = tokenData.access_token;
    const auth2 = { headers: { Authorization: `Bearer ${businessToken}` } };
    const { data: phone } = await axios.get(`${GRAPH}/${phoneNumberId}`, { params: { fields: "display_phone_number,verified_name,is_on_biz_app,platform_type" }, ...auth2 }).catch(() => ({ data: {} }));
    await axios.post(`${GRAPH}/${wabaId}/subscribed_apps`, {}, auth2);
    let contactsSynced = null;
    try {
      await axios.post(`${GRAPH}/${phoneNumberId}/smb_app_data`, { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" }, auth2);
      contactsSynced = new Date().toISOString();
    } catch (err) {
      console.log("OFFICE CONTACTS SYNC ERROR:", err.response?.data?.error?.message || err.message);
    }
    await saveOffice({
      phone_number_id: phoneNumberId, waba_id: wabaId, token: businessToken, display_phone: phone.display_phone_number || null,
      verified_name: phone.verified_name || null, on_biz_app: phone.is_on_biz_app ?? null, connected_at: new Date().toISOString(),
      connected_by: who(req.user), bot_on: true, pause_hours: 12, contacts_synced: contactsSynced,
    });
    res.locals.activity = { section: "Admin Settings", action: `Connected the office WhatsApp number ${phone.display_phone_number || phoneNumberId}` };
    res.json(view());
  }));

  app.patch("/admin/office-whatsapp", auth, adminOnly, handle("OFFICE WA UPDATE", async (req, res) => {
    if (!office) return res.status(400).json({ error: "The office number isn't connected" });
    const next = { ...office };
    if (req.body?.bot_on !== undefined) next.bot_on = Boolean(req.body.bot_on);
    if (req.body?.pause_hours !== undefined) {
      const hours = Math.round(Number(req.body.pause_hours));
      if (!(hours >= 1 && hours <= 72)) return res.status(400).json({ error: "Choose 1 to 72 hours" });
      next.pause_hours = hours;
    }
    await saveOffice(next);
    res.json(view());
  }));

  // Forget the number here (it stays connected in Meta until removed there).
  app.delete("/admin/office-whatsapp", auth, adminOnly, handle("OFFICE WA DELETE", async (req, res) => {
    await saveOffice(null);
    res.locals.activity = { section: "Admin Settings", action: "Disconnected the office WhatsApp number from the dashboard" };
    res.json(view());
  }));

  /* Office Leads page */
  app.get("/office-leads", auth, handle("OFFICE LEADS", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM office_leads ORDER BY created_at DESC LIMIT 2000");
    res.json({ leads: rows, connected: Boolean(office?.phone_number_id), display_phone: office?.display_phone || null });
  }));
  app.patch("/office-leads/:id", auth, handle("OFFICE LEAD UPDATE", async (req, res) => {
    const status = req.body?.status;
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    if (status && !["New", "Contacted", "Quoted", "Won", "Lost"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const entry = note || status ? [{ at: new Date().toISOString(), by: who(req.user), note, status: status || null }] : [];
    const { rows } = await db.query(
      `UPDATE office_leads SET status = COALESCE($2, status), notes = notes || $3::jsonb, updated_at = NOW(), updated_by = $4 WHERE id = $1 RETURNING *`,
      [req.params.id, status || null, JSON.stringify(entry), who(req.user)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Lead not found" });
    res.json(rows[0]);
  }));
}
