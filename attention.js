/* =========================================================
    TICKETS THAT NEED A PERSON
    There is no "talk to admin" option in the bot's menus. Instead the bot reads what the
    customer writes and hands the chat to the team when:
      • they ask for a person ("talk to someone", "customer care", "call me", "manager"…)
        or are clearly upset ("fraud", "cheated", "complaint", "worst"…);
      • they write a sentence where the bot expects a menu number, or pick a wrong option twice;
      • they write a sentence after their ticket was submitted or closed.
    The ticket goes to Admin Mode (the bot stops replying), gets high priority and a
    "Needs attention" badge, and the admins set in Admin Settings → "Admin WhatsApp alerts"
    get a WhatsApp message with what the customer said.

    Outside WhatsApp's 24-hour window the approved template ATTENTION_TEMPLATE (default
    "ticket_attention", language ATTENTION_TEMPLATE_LANG, "en") is sent: body {{1}} ticket
    number, {{2}} customer's number, {{3}} what they said and the issue.
========================================================= */
import { sendWhatsAppPayload } from "./whatsapp.js";
import { sendWithFallback } from "./whatsappOutbox.js";

let db = null;

const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

const PEOPLE = "admin|administrator|human|person|agent|executive|someone|somebody|anyone|support|staff|team|manager|owner|representative|customer ?care|care|operator|officer";
const ASKS_FOR_PERSON = [
  new RegExp(`\\b(talk|speak|chat|connect|contact|call|reach|transfer)\\w*\\b.{0,30}\\b(${PEOPLE})\\b`, "i"),
  /\b(customer (care|service|support)|real person|human being|live (agent|chat|person)|call me|call back|callback|give me a call|phone number|contact number|your number|helpline)\b/i,
  /^(agent|human|admin|support|helpline|customer care|manager)[.!? ]*$/i,
  /\b(baat|bat)\s*(karna|karni|karo|krna|krni)\b/i,
];
const UPSET = /\b(fraud|scam|cheat(ed|ing)?|police|consumer (court|forum)|legal action|complaint|complain|worst|pathetic|useless|disgusting|no response|not responding|nobody (is )?respond|still (not|no|didn'?t)|waiting since|how many days|when will i get|refund (not|nahi) (received|came|credited))\b/i;

export const asksForPerson = (text) => ASKS_FOR_PERSON.some((pattern) => pattern.test(String(text || "").trim()));
export const soundsUpset = (text) => UPSET.test(String(text || ""));

// A real sentence (not "ok", "hi", "2", a transaction ID or a UPI ID).
export function isSentence(text) {
  const value = String(text || "").trim();
  const words = value.split(/\s+/).filter((word) => /[a-zऀ-ൿ]/i.test(word));
  return words.length >= 3 && value.length >= 12;
}

// Steps where the bot waits for a photo or screenshot.
const PHOTO_STEPS = ["STEP1", "STEP3", "EXP_IMG", "EXP_UPI_IMG", "PRICE_IMG", "PRICE_UPI_IMG", "DAM_IMG", "DAM_UPI_IMG"];
const YES_NO = /^(yes|no)\b/i;
// Where the bot expects one of a few answers: the valid ones.
export function expectedAnswers(category, state) {
  if (category === "MENU") return ["1", "2", "3"];
  if (category === "REFUND" && state === "BANK_CHECK") return ["1", "2"];
  if (category === "REFUND" && state === "MAIN") return ["1", "2", "3", "4", "5"];
  if (category === "REFUND" && state === "MULTI_PRODUCT") return ["1", "2", YES_NO];
  if (category === "PRODUCT" && state === "OPTIONS") return ["1", "2"];
  if (category === "FEEDBACK" && state === "RATING") return ["1", "2", "3", "4", "5"];
  return null;
}

// null when the bot isn't waiting for one of a few answers here.
export function isExpectedAnswer(category, state, text) {
  const answers = expectedAnswers(category, state);
  if (!answers) return null;
  const answer = String(text || "").trim().toLowerCase();
  return answers.some((option) => (option instanceof RegExp ? option.test(answer) : option === answer));
}

/* Why this message should go to a person, or null.
   misses: how many wrong answers in a row at this step (kept by the caller). */
export function attentionReason({ category, state, text, isImage, hasTransactionIds, misses = 0 }) {
  if (isImage) return null;
  // Asking for a person counts at every step.
  if (asksForPerson(text)) return "Asked to talk to a person";
  const answers = expectedAnswers(category, state);
  // Complaints only where the bot isn't waiting for free text (a location, an ID, a comment):
  // at a menu, before the menu, at a photo step, or after the ticket was submitted or closed.
  const listening = Boolean(answers) || !category || PHOTO_STEPS.includes(state) || state === "DONE" || state === "CLOSED";
  if (listening && soundsUpset(text)) return "Upset or complaining";
  const sentence = isSentence(text) && !hasTransactionIds;
  if (state === "DONE" && sentence) return "Wrote again after the ticket was submitted";
  if (state === "CLOSED" && sentence) return "Wrote again after the ticket was closed";
  if (!answers || isExpectedAnswer(category, state, text)) return null;
  if (sentence) return "Wrote something the menu doesn't cover";
  if (misses >= 1) return "Couldn't pick a menu option";
  return null;
}

export async function ensureAttention(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS attention_contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS attention_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attention_reason TEXT,
      ADD COLUMN IF NOT EXISTS attention_text TEXT
  `);
}

const oneLine = (text, max = 700) => String(text || "").replace(/\s*\n+\s*/g, " · ").replace(/\s{4,}/g, "   ").trim().slice(0, max) || "-";

// WhatsApp to every admin in Admin Settings → "Admin WhatsApp alerts".
export async function alertAdmins(ticket, text, reason) {
  if (!db) return 0;
  const { rows: contacts } = await db.query("SELECT name, phone FROM attention_contacts ORDER BY id").catch(() => ({ rows: [] }));
  const issue = [ticket.main_issue, ticket.sub_issue].filter(Boolean).join(" · ");
  const place = ticket.site_name || ticket.location;
  const body = [
    `🔔 *Ticket #${ticket.id} needs attention*`,
    "",
    `Customer: +${phoneDigits(ticket.phone)}`,
    issue ? `Issue: ${issue}` : "",
    place ? `📍 ${place}` : "",
    text ? `They said: "${String(text).slice(0, 500)}"` : "",
    `Why: ${reason}`,
    "",
    "The bot has stopped replying to them. Please reply from the dashboard (Tickets).",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
  let sent = 0;
  for (const contact of contacts) {
    const to = phoneDigits(contact.phone);
    const result = await sendWithFallback({
      kind: "attention",
      refIds: [ticket.id],
      to,
      send: () => sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
      template: process.env.ATTENTION_TEMPLATE === "off" ? null : {
        name: process.env.ATTENTION_TEMPLATE || "ticket_attention",
        lang: process.env.ATTENTION_TEMPLATE_LANG || "en",
        params: [String(ticket.id), `+${phoneDigits(ticket.phone)}`, oneLine(`"${String(text || "").slice(0, 400)}"${issue ? ` · ${issue}` : ""}${place ? ` · ${place}` : ""} · ${reason}`)],
      },
    }).catch((err) => ({ ok: false, error: err.message }));
    if (result.ok) sent += 1;
    else console.log(`ATTENTION ALERT to ${contact.name} failed:`, result.error);
  }
  return sent;
}

export function registerAttentionRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  app.get("/admin/attention-contacts", auth, handle("ATTENTION CONTACTS", async (req, res) => {
    const { rows } = await db.query("SELECT id, name, phone FROM attention_contacts ORDER BY id");
    res.json(rows);
  }));

  app.put("/admin/attention-contacts", auth, handle("ATTENTION CONTACTS SAVE", async (req, res) => {
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
    await db.query("DELETE FROM attention_contacts");
    for (const contact of contacts) await db.query("INSERT INTO attention_contacts (name, phone) VALUES ($1, $2)", [contact.name, contact.phone]);
    res.locals.activity = { section: "Settings", action: `Set admin WhatsApp alerts to: ${contacts.map((contact) => contact.name).join(", ") || "nobody"}` };
    const { rows } = await db.query("SELECT id, name, phone FROM attention_contacts ORDER BY id");
    res.json(rows);
  }));
}

/* ---------- The location step ---------- */
// Words that mean a place (a building, floor, area or city).
const PLACE_WORDS = /\b(floor|flr|tower|block|building|bldg|office|cafe|cafeteria|canteen|pantry|lobby|gate|campus|park|road|rd|street|nagar|layout|colony|mall|hospital|college|university|school|station|airport|terminal|phase|wing|level|near|opp|opposite|behind|beside|metro|sez|tech|hub|plaza|complex|cent(er|re)|ground|basement|reception|hostel|gym|hotel|apartments?|society|sector|city|bangalore|bengaluru|hyderabad|chennai|pune|mumbai|delhi|noida|gurgaon|gurugram|whitefield|manyata|koramangala|hsr|marathahalli|electronic city)\b/i;
// Words that mean the customer is explaining or asking, not naming a place.
const NOT_A_PLACE = /₹|\b(refund|money|amount|paid|pay|payment|charged|deducted|debited|transactions?|txn|upi|rs|rupees?|help|please|pls|need|want|why|when|how|what|not (working|dispensed|received|coming)|didn'?t|did not|issue|problem|stuck|cancel|ok|okay|yes|no|thanks?|thank you|hi|hello|hey)\b/i;

// Why this isn't a location (null when it looks like one). site: the siteMatcher result.
export function locationProblem(text, site) {
  const value = String(text || "").trim();
  if (!value || site?.site_id) return null;
  if (/^[\d\s+\-()]+$/.test(value)) return "Only numbers";
  if (/\S+@\S+/.test(value)) return "A UPI ID or email";
  if (/\d{10,}/.test(value.replace(/\s/g, ""))) return "A phone number or transaction ID";
  if (PLACE_WORDS.test(value)) return null;
  if (NOT_A_PLACE.test(value) || value.includes("?")) return "Not a place";
  return null;
}

export const LOCATION_AGAIN = `📍 *Please send the machine location*

We need where the machine is, for example:
"Bangalore Airport Terminal 2, TCS Canteen" or "Strides 2, 4th floor cafeteria"

You can tell our team about the problem after this.`;
