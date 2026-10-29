/* =========================================================
    REFILLER APP
    Refillers log in on their phone with their phone number and a PIN (set by the office in
    Refill Audit → Refillers) and see one very simple page (RefillerApp.jsx):
      • today's refills — tap "Take photo", and the refill is recorded exactly as if the photos
        were sent on WhatsApp and the site picked (refillSchedule.js), for the office to verify;
      • problems to fix (Refill Audit CAPA tasks) — "Fixed" or "Can't fix" (refillerTasks.js);
      • a refill at another of their sites.
    A refiller login can only use /refiller/… (accessControl.js).
========================================================= */
import { notifyLocationManagers } from "./locationTeams.js";
import { hashPassword, verifyPassword, newSessionToken } from "./accessControl.js";
import { istDate, completeRefillFromApp, refillerSites } from "./refillSchedule.js";
import { answerCapaFromApp } from "./refillerTasks.js";
import { storeDashboardFile } from "./ticketChat.js";

let db = null;
const phoneDigits = (phone) => { const digits = String(phone || "").replace(/\D/g, ""); return digits.length === 10 ? `91${digits}` : digits; };
// Wrong PINs: 5 tries, then 15 minutes' wait for that phone number.
const failures = new Map();

export async function ensureRefillerApp(database) {
  db = database;
  await db.query("ALTER TABLE audit_refillers ADD COLUMN IF NOT EXISTS app_pin TEXT, ADD COLUMN IF NOT EXISTS app_pin_set_at TIMESTAMPTZ");
}

// "9110623553" (any spacing, with or without +91) → that refiller, if the PIN is right.
export const looksLikePhone = (text) => /^\+?[\d\s-]{10,16}$/.test(String(text || "").trim());
export async function refillerLogin(phoneText, pin) {
  if (!db) return { error: "Please try again in a minute." };
  const phone = phoneDigits(phoneText);
  const failed = failures.get(phone);
  if (failed && failed.count >= 5 && Date.now() - failed.at < 15 * 60000) return { error: "Too many wrong PINs. Please wait 15 minutes, or ask the office." };
  const { rows } = await db.query("SELECT id, name, phone, app_pin FROM audit_refillers WHERE phone IS NOT NULL AND phone <> ''");
  const refiller = rows.find((row) => phoneDigits(row.phone) === phone);
  if (refiller && !refiller.app_pin) return { error: "Your app PIN isn't set yet. Ask the office to set it (Refill Audit → Refillers)." };
  if (!refiller || !verifyPassword(String(pin || ""), refiller.app_pin)) {
    failures.set(phone, { count: (failed && Date.now() - failed.at < 15 * 60000 ? failed.count : 0) + 1, at: Date.now() });
    return null;
  }
  failures.delete(phone);
  const token = newSessionToken();
  global.internalSessions.set(token, { refillerId: refiller.id, name: refiller.name, phone, createdAt: Date.now() });
  return { token, role: "refiller", name: refiller.name, refillerId: refiller.id };
}

// For the WhatsApp code login (otpLogin.js): the refiller with this number, and their session.
export async function refillerByPhone(phone) {
  if (!db) return null;
  const { rows } = await db.query("SELECT id, name, phone FROM audit_refillers WHERE phone IS NOT NULL AND phone <> ''");
  return rows.find((row) => phoneDigits(row.phone) === phoneDigits(phone)) || null;
}
export function refillerSession(refiller) {
  const token = newSessionToken();
  global.internalSessions.set(token, { refillerId: refiller.id, name: refiller.name, phone: phoneDigits(refiller.phone), createdAt: Date.now() });
  return { token, role: "refiller", name: refiller.name, refillerId: refiller.id };
}

export function registerRefillerAppRoutes(app, { auth, adminGuard }) {
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { console.log(`${label} ERROR:`, err.message); res.status(500).json({ error: err.message?.length < 160 ? err.message : "Something went wrong. Please try again." }); }
  };
  // The refiller behind the login (still in the Refillers list, with the same phone).
  const me = async (req, res) => {
    if (req.user?.role !== "refiller") { res.status(403).json({ error: "This is for refillers" }); return null; }
    const { rows } = await db.query("SELECT id, name, phone FROM audit_refillers WHERE id = $1", [req.user.refillerId]);
    if (!rows[0]) { res.status(401).json({ error: "Session expired. Please log in again." }); return null; }
    return { id: rows[0].id, name: rows[0].name, phone: phoneDigits(rows[0].phone) };
  };

  app.get("/refiller/today", auth, handle("REFILLER TODAY", async (req, res) => {
    const refiller = await me(req, res);
    if (!refiller) return;
    const today = istDate();
    const yesterday = new Date(Date.now() + 330 * 60000 - 86400000).toISOString().slice(0, 10);
    const [visits, capa, sites] = await Promise.all([
      // Today's visits, plus yesterday's still open (missed / to redo).
      db.query(
        `SELECT id, location_id, location_name, machine_code, due_date, due_time, due_at, status, unscheduled, reject_reason, completed_at, jsonb_array_length(COALESCE(photos, '[]'::jsonb)) AS photo_count
         FROM refill_tasks WHERE refiller_phone = $1 AND status <> 'cancelled'
           AND (due_date = $2 OR (due_date = $3 AND status IN ('missed', 'rejected', 'scheduled')))
         ORDER BY due_date, due_at, location_name`,
        [refiller.phone, today, yesterday]
      ),
      db.query(
        `SELECT id, ref, location, defect, severity, status, escalated_at, escalated_to, created_at FROM audit_capa
         WHERE status = 'OPEN' AND (refiller_phone = $1 OR LOWER(refiller) = LOWER($2)) ORDER BY created_at`,
        [refiller.phone, refiller.name]
      ),
      refillerSites(refiller.phone),
    ]);
    res.json({
      name: refiller.name, today,
      visits: visits.rows.map((visit) => ({ ...visit, yesterday: visit.due_date !== today })),
      problems: capa.rows,
      sites: sites.map((site) => ({ id: site.id, name: site.name, machine_code: site.machine_code })),
    });
  }));

  // Photos of the machine (1–4), then which site: the refill is recorded for the office to check.
  app.post("/refiller/refilled", auth, handle("REFILLER REFILLED", async (req, res) => {
    const refiller = await me(req, res);
    if (!refiller) return;
    const locationId = Number(req.body?.location_id);
    const files = (Array.isArray(req.body?.photos) ? req.body.photos : []).slice(0, 4);
    if (!locationId) return res.status(400).json({ error: "Choose the site" });
    if (!files.length) return res.status(400).json({ error: "Take a photo of the machine first" });
    const sites = await refillerSites(refiller.phone);
    const { rows: scheduled } = await db.query("SELECT 1 FROM refill_tasks WHERE refiller_phone = $1 AND location_id = $2 AND due_date >= $3 LIMIT 1", [refiller.phone, locationId, istDate(new Date(Date.now() - 86400000))]);
    if (!sites.some((site) => site.id === locationId) && !scheduled.length) return res.status(403).json({ error: "That site isn't one of yours" });
    const urls = [];
    for (const file of files) {
      const stored = await storeDashboardFile({ name: file.name || "refill.jpg", type: file.type || "image/jpeg", data: file.data });
      if (stored.kind !== "image") return res.status(400).json({ error: "Please send photos only" });
      urls.push(stored.url);
    }
    const task = await completeRefillFromApp(refiller, locationId, urls);
    if (!task) return res.status(400).json({ error: "Could not record it. Please try again." });
    res.locals.activity = { section: "Refills", action: `${refiller.name} recorded a refill at ${task.location_name} from the refiller app`, actorName: refiller.name };
    res.json({ success: true, location: task.location_name, photos: urls.length, status: task.status });
  }));

  // A problem from a Refill Audit: fixed, or can't fix (goes to the right person, with a reason).
  app.post("/refiller/problems/:id", auth, handle("REFILLER PROBLEM", async (req, res) => {
    const refiller = await me(req, res);
    if (!refiller) return;
    const answer = req.body?.answer === "fixed" ? "fixed" : req.body?.answer === "cant" ? "cant" : null;
    if (!answer) return res.status(400).json({ error: "Choose Fixed or Can't fix" });
    const { rows } = await db.query("SELECT * FROM audit_capa WHERE id = $1 AND (refiller_phone = $2 OR LOWER(refiller) = LOWER($3))", [req.params.id, refiller.phone, refiller.name]);
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: "That problem could not be found" });
    if (ticket.status === "RESOLVED") return res.json({ success: true, already: true });
    await answerCapaFromApp(db, refiller, ticket, answer, String(req.body?.note || "").slice(0, 500));
    if (answer === "cant") notifyLocationManagers(ticket.location, { title: `🆘 ${refiller.name} can't fix ${ticket.ref || "a problem"} at ${ticket.location}`, body: `${ticket.defect}${req.body?.note ? ` · ${String(req.body.note).slice(0, 80)}` : ""}` });
    res.json({ success: true });
  }));

  // The office sets (or clears) a refiller's app PIN.
  app.put("/audit/refillers/:id/pin", auth, adminGuard, handle("REFILLER PIN", async (req, res) => {
    const pin = String(req.body?.pin ?? "").trim();
    if (pin && !/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "The PIN must be 4 to 6 digits" });
    const { rows } = await db.query("UPDATE audit_refillers SET app_pin = $2, app_pin_set_at = $3 WHERE id = $1 RETURNING name, phone", [req.params.id, pin ? hashPassword(pin) : null, pin ? new Date() : null]);
    if (!rows[0]) return res.status(404).json({ error: "Refiller not found" });
    // A new PIN logs them out of other phones.
    for (const [token, session] of global.internalSessions) if (String(session.refillerId) === String(req.params.id)) global.internalSessions.delete(token);
    res.locals.activity = { section: "Refill Audit", action: `${pin ? "Set" : "Removed"} the app PIN for refiller ${rows[0].name}` };
    res.json({ success: true, has_pin: Boolean(pin), phone: rows[0].phone });
  }));
}
