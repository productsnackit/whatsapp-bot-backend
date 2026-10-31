/* =========================================================
    INTERNAL AUDIT FINDINGS & CAPA
    Company-wide audit observations with a corrective action plan, an
    action owner (an employee), a due date and a follow-up trail.
    Everyone can view, log and follow up; only admin can delete.
========================================================= */
import { sendPushToUsers } from "./pushNotifications.js";
import { storeDashboardFile, sendStoredFile } from "./ticketChat.js";
import { sendWhatsAppButtons, sendWhatsAppPayload } from "./whatsapp.js";
import { sendWithFallback, noteInbound, onDeliveryUpdate } from "./whatsappOutbox.js";

const MAX_ATTACHMENTS = 10;

export const FINDING_RISKS = ["Critical", "Major", "Minor", "Observation"];
export const FINDING_STATUSES = ["Open", "In Progress", "Under Review", "Closed"];

async function ensureFindingsTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_findings (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE,
      department TEXT NOT NULL,
      observed_on DATE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      root_cause TEXT,
      action_plan TEXT NOT NULL,
      assignee_id TEXT,
      assignee_name TEXT,
      due_date DATE NOT NULL,
      follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Which locations (Refill Audit locations) it's about, and files attached (photos, PDFs, sheets).
  await db.query(`
    ALTER TABLE audit_findings
      ADD COLUMN IF NOT EXISTS locations TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS closed_by TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_status TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_error TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS whatsapp_delivery TEXT,
      ADD COLUMN IF NOT EXISTS files_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS owner_department TEXT,
      ADD COLUMN IF NOT EXISTS cc JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  // When it was closed and by whom (for how long it took). Findings closed before this was kept:
  // from their last "Closed" follow-up, else when they were last changed.
  await db.query(`
    UPDATE audit_findings f SET
      closed_at = COALESCE((SELECT NULLIF(e->>'recordedAt', '')::timestamptz FROM jsonb_array_elements(f.follow_ups) e WHERE e->>'status' = 'Closed' ORDER BY e->>'recordedAt' DESC NULLS LAST LIMIT 1), f.updated_at, NOW()),
      closed_by = (SELECT COALESCE(e->>'recordedBy', e->>'auditor') FROM jsonb_array_elements(f.follow_ups) e WHERE e->>'status' = 'Closed' ORDER BY e->>'recordedAt' DESC NULLS LAST LIMIT 1)
    WHERE f.status = 'Closed' AND f.closed_at IS NULL
  `);
}

// Postgres DATE comes back as local midnight; send it as plain "YYYY-MM-DD" so no timezone shifts the day.
function plainDate(value) {
  if (!(value instanceof Date)) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toApi(row) {
  return row && { ...row, observed_on: plainDate(row.observed_on), due_date: plainDate(row.due_date) };
}

// Accepts 2026-09-20, 20/09/2026, 20-09-2026, 20.09.2026 or "20 Sept 2026"; returns "YYYY-MM-DD" or null.
function importDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const pad = (n) => String(n).padStart(2, "0");
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) return `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  const parsed = new Date(text.replace(/Sept/i, "Sep"));
  return Number.isNaN(parsed.getTime()) ? null : `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function userName(user) {
  return user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee";
}

/* Who can see a task and its files: whoever raised it, whoever it's with (or, while it waits in a
   department, that department's people, so they can take it), the people in CC, and directors /
   admins. Nobody else. */
export function canSeeFinding(finding, user) {
  if (!finding || !user) return false;
  if (user.isAdmin) return true;
  const me = String(user.userId ?? user.id ?? "");
  return (Boolean(me) && String(finding.assignee_id || "") === me)
    || (Boolean(finding.created_by) && finding.created_by === userName(user))
    || (finding.cc || []).some((person) => String(person?.id) === me)
    || (!finding.assignee_id && Boolean(finding.owner_department) && finding.owner_department === user.department);
}

function employeeById(id) {
  return (global.internalUsers || []).find((user) => String(user.id) === String(id)) || null;
}

// Tell the action owner on their phone.
function notifyAssignee(db, finding, byName, reassigned) {
  const owner = employeeById(finding.assignee_id);
  if (!owner?.username) return;
  sendPushToUsers(db, [owner.username], {
    title: `${reassigned ? "Audit action assigned to you" : "New audit finding for you"} · ${finding.ref}`,
    body: `${finding.risk}: ${finding.title} (due ${finding.due_date}). From ${byName}.`.slice(0, 180),
    view: "findings",
  });
}

// People kept in CC ([{ id, name }]): they can see it and are told when it's given out,
// forwarded, started or resolved, like CC on an email. The person doing it isn't told twice.
function notifyCc(db, finding, title, body, skipNames = []) {
  const skip = new Set([...skipNames, finding.assignee_name].filter(Boolean));
  const usernames = (finding.cc || []).map((person) => employeeById(person.id)).filter((user) => user?.username && !skip.has(user.name)).map((user) => user.username);
  if (!usernames.length) return;
  sendPushToUsers(db, usernames, { title: `CC · ${title}`.slice(0, 120), body: String(body || "").slice(0, 180), view: "findings" }).catch(() => {});
}

/* ---------- The task on the action owner's WhatsApp ----------
   When a finding is given to someone, it goes to their WhatsApp (Employees & Access → WhatsApp
   number) with all its details and two buttons: "Started" (→ In Progress) and "Done" (→ Under
   Review, for the person who raised it to verify and close). Files go right after it. If they
   haven't written to us in 24 hours, the approved Call Log template (FINDING_TEMPLATE_NAME,
   default CALL_TEMPLATE_NAME or "call_log_task": {{1}} ref, {{2}} the task, {{3}} raised by,
   {{4}} due, three quick-reply buttons) is used instead, and the files follow their first tap. */
const fndPhone = (phone) => { const digits = String(phone || "").replace(/\D/g, ""); return digits.length === 10 ? `91${digits}` : digits; };
const oneLine = (text, max = 900) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
const dueLabel = (date) => (date ? new Date(`${plainDate(date)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "no due date");
const findingButtons = (id) => [{ id: `FND_START:${id}`, title: "Started" }, { id: `FND_DONE:${id}`, title: "Done" }];
function findingDetails(finding) {
  return [finding.description, finding.action_plan && finding.action_plan !== finding.description ? `To do: ${finding.action_plan}` : ""].filter(Boolean).join("\n");
}
function findingText(finding, byName, reassigned) {
  const files = (finding.attachments || []).length;
  return [
    reassigned ? `↪️ *Audit task ${finding.ref} is now yours*` : `📋 *New audit task ${finding.ref}*`,
    "",
    `*${finding.title}*`,
    findingDetails(finding).slice(0, 600),
    "",
    (finding.locations || []).length ? `📍 ${finding.locations.join(", ")}` : "",
    `⚠️ ${finding.risk} · ${finding.department}`,
    `⏰ Due: ${dueLabel(finding.due_date)}`,
    `👤 Raised by ${byName || finding.created_by || "the team"}`,
    files ? `📎 ${files} file${files === 1 ? "" : "s"} (sent below)` : "",
    "",
    "Tap *Started* when you begin and *Done* when it's finished.",
  ].filter((line, index, all) => line !== "" || (all[index - 1] !== "" && index > 0)).join("\n").slice(0, 1024);
}
function findingTemplate(finding, byName) {
  const name = process.env.FINDING_TEMPLATE_NAME || process.env.CALL_TEMPLATE_NAME || "call_log_task";
  if (name === "off") return null;
  const files = (finding.attachments || []).length;
  const summary = [`Audit: ${finding.title}`, findingDetails(finding), (finding.locations || []).length && `Location: ${finding.locations.join(", ")}`, `Risk: ${finding.risk}`,
    files && `📎 ${files} file${files === 1 ? "" : "s"}: tap a button to receive ${files === 1 ? "it" : "them"}`].filter(Boolean).join(" · ");
  return {
    name, lang: process.env.FINDING_TEMPLATE_LANG || process.env.CALL_TEMPLATE_LANG || "en",
    params: [finding.ref, oneLine(summary), oneLine(byName || finding.created_by || "the team", 60), dueLabel(finding.due_date)],
    buttons: [`FND_START:${finding.id}`, `FND_DONE:${finding.id}`, `FND_INFO:${finding.id}`],
  };
}
async function sendFindingFiles(finding, to) {
  for (const file of finding.attachments || []) await sendStoredFile(to, file, `${finding.ref}: ${file.name}`).catch(() => {});
}
// Audit tasks are handled on the dashboard (status buttons, Forward); WhatsApp only if
// FINDING_WHATSAPP=on on Render.
const findingWhatsAppOn = () => process.env.FINDING_WHATSAPP === "on";
export async function sendFindingToOwner(db, findingId, { byName = null, reassigned = false } = {}) {
  if (!findingWhatsAppOn()) return { ok: false, off: true };
  const finding = (await db.query("SELECT * FROM audit_findings WHERE id = $1", [findingId])).rows[0];
  if (!finding) return { ok: false };
  const owner = employeeById(finding.assignee_id);
  const to = fndPhone(owner?.phone);
  const save = (status, error) => db.query("UPDATE audit_findings SET whatsapp_status = $2, whatsapp_error = $3, whatsapp_delivery = NULL, whatsapp_sent_at = CASE WHEN $2 = 'SENT' THEN NOW() ELSE whatsapp_sent_at END WHERE id = $1", [findingId, status, error]);
  if (!to) {
    await save("NO_PHONE", `${owner?.name || "The action owner"} has no WhatsApp number. Add it in Employees & Access, then tap Send again.`);
    return { ok: false };
  }
  const result = await sendWithFallback({
    kind: "finding", refIds: [finding.id], to,
    send: () => sendWhatsAppButtons(to, findingText(finding, byName, reassigned), findingButtons(finding.id)),
    template: findingTemplate(finding, byName),
    noWindowError: `Not delivered: ${owner.name} hasn't messaged the Snackit WhatsApp number in the last 24 hours and the WhatsApp template isn't set up.`,
  });
  if (result.ok && !result.viaTemplate) await sendFindingFiles(finding, to);
  await save(result.ok ? "SENT" : "FAILED", result.ok ? null : result.error || "Could not send");
  return result;
}

// The action owner tapping Started / Done (or the third template button) on WhatsApp.
let replyDb = null;
let replyChanged = null;
const textTo = (to, body) => sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096) } });
export async function handleFindingWhatsApp(msg) {
  const choice = msg?.interactive?.button_reply?.id || msg?.button?.payload || "";
  const match = choice.match(/^FND_(START|DONE|INFO):(\d+)$/);
  if (!replyDb || !match) return false;
  const phone = fndPhone(msg.from);
  await noteInbound(phone).catch(() => {});
  const [, action, id] = match;
  const finding = (await replyDb.query("SELECT * FROM audit_findings WHERE id = $1", [id])).rows[0];
  if (!finding) { await textTo(phone, "This audit task no longer exists."); return true; }
  const owner = employeeById(finding.assignee_id);
  if (fndPhone(owner?.phone) !== phone) { await textTo(phone, `${finding.ref} is now with ${finding.assignee_name || "someone else"}, so it wasn't changed.`); return true; }
  // Came as a template (24-hour window was closed): the files go now that they've tapped.
  if ((finding.attachments || []).length && finding.whatsapp_sent_at && (!finding.files_sent_at || finding.files_sent_at < finding.whatsapp_sent_at)) {
    await sendFindingFiles(finding, phone);
    await replyDb.query("UPDATE audit_findings SET files_sent_at = NOW() WHERE id = $1", [id]).catch(() => {});
  }
  if (finding.status === "Closed") { await textTo(phone, `${finding.ref} is already closed. Thank you!`); return true; }
  // The template's third button (Call Log's "Forward"): audit tasks aren't forwarded; the details again.
  if (action === "INFO") {
    await textTo(phone, `Audit tasks can't be passed on from WhatsApp. If it should be someone else's, ask ${finding.created_by || "the person who raised it"}. Here it is again:`);
    await sendWhatsAppButtons(phone, findingText(finding, finding.created_by, false), findingButtons(finding.id));
    return true;
  }
  const next = action === "START" ? "In Progress" : "Under Review";
  if (action === "START" && finding.status !== "Open") { await textTo(phone, `${finding.ref} is already ${finding.status.toLowerCase()}.`); return true; }
  const entry = {
    date: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), status: next,
    notes: action === "START" ? "Started (from WhatsApp)." : "Done: waiting for verification (from WhatsApp).",
    auditor: owner.name, recordedBy: `${owner.name} (WhatsApp)`, recordedAt: new Date().toISOString(),
  };
  await replyDb.query("UPDATE audit_findings SET follow_ups = follow_ups || $1::jsonb, status = $2, updated_at = NOW() WHERE id = $3", [JSON.stringify([entry]), next, id]);
  await textTo(phone, action === "START"
    ? `👍 ${finding.ref} marked as *In Progress*. Tap *Done* when it's finished.`
    : `✅ Thank you! ${finding.ref} is marked *Done* and goes to ${finding.created_by || "the person who raised it"} to verify and close.`);
  // The person who raised it is told on their phone.
  const raiser = finding.created_by === "Admin" ? "admin" : (global.internalUsers || []).find((user) => user.name === finding.created_by)?.username;
  if (raiser) sendPushToUsers(replyDb, [raiser], {
    title: action === "START" ? `${owner.name} started ${finding.ref}` : `✅ ${owner.name} finished ${finding.ref}: please verify`,
    body: finding.title.slice(0, 150), view: "findings",
  }).catch(() => {});
  notifyCc(replyDb, finding, action === "START" ? `${owner.name} started ${finding.ref}` : `${owner.name} finished ${finding.ref}`, finding.title, [owner.name]);
  replyChanged?.();
  return true;
}

// Validates the editable fields; returns { values } or { error }.
function readFinding(body, { partial }) {
  const values = {};
  const text = (key, max = 4000) => (body[key] === undefined ? undefined : String(body[key] ?? "").trim().slice(0, max));
  const fields = {
    department: text("department", 80),
    observed_on: text("observed_on", 10),
    title: text("title", 300),
    description: text("description"),
    risk: text("risk", 20),
    status: text("status", 20),
    root_cause: text("root_cause"),
    action_plan: text("action_plan"),
    assignee_id: text("assignee_id", 40),
    due_date: text("due_date", 10),
  };
  // The form has one box, "Details & what needs to be done" (description); a separate action
  // plan is only on older findings.
  const required = ["department", "observed_on", "title", "description", "risk", "assignee_id", "due_date"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      if (!partial && required.includes(key)) return { error: `${key.replace("_", " ")} is required` };
      continue;
    }
    if (required.includes(key) && !value) return { error: `${key.replace("_", " ")} is required` };
    values[key] = value || (key === "action_plan" ? "" : null);
  }
  if (body.locations !== undefined) {
    values.locations = [...new Set((Array.isArray(body.locations) ? body.locations : []).map((name) => String(name || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 30);
  }
  if (values.risk && !FINDING_RISKS.includes(values.risk)) return { error: "Invalid risk level" };
  if (values.status && !FINDING_STATUSES.includes(values.status)) return { error: "Invalid status" };
  for (const key of ["observed_on", "due_date"]) {
    if (values[key] && Number.isNaN(new Date(values[key]).getTime())) return { error: `Invalid ${key.replace("_", " ")}` };
  }
  if (body.cc !== undefined) {
    const ids = [...new Set((Array.isArray(body.cc) ? body.cc : []).map((id) => String(id?.id ?? id ?? "")).filter(Boolean))].slice(0, 20);
    const people = ids.map(employeeById);
    if (people.some((person) => !person)) return { error: "Choose CC people from the employee list" };
    values.cc = JSON.stringify(people.map((person) => ({ id: String(person.id), name: person.name })));
  }
  if (values.assignee_id) {
    const owner = employeeById(values.assignee_id);
    if (!owner) return { error: "Choose the action owner from the employee list" };
    values.assignee_name = owner.name;
  }
  return { values };
}

export function registerFindingsRoutes(app, { db, auth, onChanged }) {
  replyDb = db;
  replyChanged = onChanged;
  ensureFindingsTable(db).catch((err) => console.log("FINDINGS TABLE ERROR:", err.message));
  // WhatsApp's later report: delivered / read, or failed (e.g. outside the 24-hour window).
  onDeliveryUpdate("finding", async ({ refIds, ok, status, error }) => {
    if (!ok) await db.query("UPDATE audit_findings SET whatsapp_status = 'FAILED', whatsapp_error = $2, whatsapp_delivery = NULL WHERE id = ANY($1)", [refIds, error]);
    else if (status === "delivered" || status === "read") await db.query("UPDATE audit_findings SET whatsapp_delivery = $2 WHERE id = ANY($1) AND (whatsapp_delivery IS NULL OR $2 = 'read')", [refIds, status]);
    onChanged?.();
  });
  // Open dashboards reload the register (and My Home) when a finding is logged or changed.
  app.use("/findings", (req, res, next) => {
    if (req.method !== "GET") res.on("finish", () => { if (res.statusCode < 400) onChanged?.(); });
    next();
  });

  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };
  // For routes on one task: someone who can't see it gets "not found", as if it didn't exist.
  const own = (label, fn) => handle(label, async (req, res) => {
    const { rows } = await db.query("SELECT * FROM audit_findings WHERE id = $1", [req.params.id]);
    if (!rows[0] || !canSeeFinding(rows[0], req.user)) return res.status(404).json({ error: "Finding not found" });
    await fn(req, res);
  });

  app.get("/findings", auth, handle("FINDINGS", async (req, res) => {
    const result = await db.query("SELECT * FROM audit_findings ORDER BY created_at DESC LIMIT 2000");
    res.json(result.rows.filter((row) => canSeeFinding(row, req.user)).map(toApi));
  }));

  app.post("/findings", auth, handle("FINDING CREATE", async (req, res) => {
    const { values, error } = readFinding(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const by = userName(req.user);
    const inserted = await db.query(
      `INSERT INTO audit_findings (department, observed_on, title, description, risk, status, root_cause, action_plan, assignee_id, assignee_name, due_date, created_by, locations, cc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING id`,
      [values.department, values.observed_on, values.title, values.description, values.risk, values.status || "Open",
        values.root_cause, values.action_plan || "", values.assignee_id, values.assignee_name, values.due_date, by, values.locations || [], values.cc || "[]"]
    );
    const finding = toApi((await db.query(
      `UPDATE audit_findings SET ref = 'FND-' || LPAD(id::text, 5, '0'),
         closed_at = CASE WHEN status = 'Closed' THEN NOW() END, closed_by = CASE WHEN status = 'Closed' THEN $2 END
       WHERE id = $1 RETURNING *`,
      [inserted.rows[0].id, by]
    )).rows[0]);
    notifyAssignee(db, finding, by, false);
    notifyCc(db, finding, `${finding.ref} given to ${finding.assignee_name}`, `${finding.risk}: ${finding.title} (due ${finding.due_date}). From ${by}.`, [by]);
    // To their WhatsApp now, or once the files are attached (the page then calls /whatsapp).
    if (!req.body?.files_pending) await sendFindingToOwner(db, finding.id, { byName: by }).catch((err) => console.log("FINDING WHATSAPP ERROR:", err.message));
    res.status(201).json(toApi((await db.query("SELECT * FROM audit_findings WHERE id = $1", [finding.id])).rows[0]));
  }));

  // Import findings from CSV (the Export CSV format). Rows whose ref already exists are skipped.
  app.post("/findings/import", auth, handle("FINDINGS IMPORT", async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only admin can import findings" });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 2000) : [];
    if (!rows.length) return res.status(400).json({ error: "No rows to import" });
    const by = userName(req.user);
    const pick = (list, value, fallback) => list.find((item) => item.toLowerCase() === String(value || "").trim().toLowerCase()) || fallback;
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (const [index, row] of rows.entries()) {
      const line = index + 2; // CSV line number after the header
      const ref = String(row.ref || "").trim();
      const label = ref ? `Line ${line} (${ref})` : `Line ${line}`;
      const title = String(row.title || "").trim();
      const department = String(row.department || "").trim();
      const observedOn = importDate(row.observed_on) || importDate(new Date().toISOString());
      const dueDate = importDate(row.due_date);
      const riskText = String(row.risk || "").trim();
      const statusText = String(row.status || "").trim();
      const risk = pick(FINDING_RISKS, riskText, null);
      const status = pick(FINDING_STATUSES, statusText, null);

      if (!title) { errors.push(`${label}: missing finding title`); continue; }
      if (!department) { errors.push(`${label}: missing department`); continue; }
      if (!dueDate) { errors.push(`${label}: missing or invalid due date "${row.due_date || ""}"`); continue; }
      if (riskText && !risk) { errors.push(`${label}: unknown risk "${riskText}" (use Critical, Major, Minor or Observation)`); continue; }
      if (statusText && !status) { errors.push(`${label}: unknown status "${statusText}" (use Open, In Progress, Under Review or Closed)`); continue; }

      // Owner by employee name; kept as plain text if they're not in the employee list.
      const ownerName = String(row.assignee_name || "").trim();
      const owner = (global.internalUsers || []).find((user) => user.name.toLowerCase() === ownerName.toLowerCase());

      // Already imported? Same ref, or (for rows without a ref) same finding, department and date.
      const duplicate = ref
        ? await db.query("SELECT 1 FROM audit_findings WHERE ref = $1", [ref])
        : await db.query(
          "SELECT 1 FROM audit_findings WHERE lower(title) = lower($1) AND lower(department) = lower($2) AND observed_on = $3",
          [title.slice(0, 300), department, observedOn]
        );
      if (duplicate.rows.length) { skipped += 1; continue; }
      const result = await db.query(
        `INSERT INTO audit_findings (ref, department, observed_on, title, description, risk, status, root_cause, action_plan, assignee_id, assignee_name, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ref || null, department, observedOn, title.slice(0, 300), String(row.description || "").trim() || title,
          risk || "Observation", status || "Open", String(row.root_cause || "").trim() || null,
          String(row.action_plan || "").trim() || "Not recorded", owner ? String(owner.id) : null, owner?.name || ownerName || null,
          dueDate, String(row.created_by || "").trim() || `${by} (import)`]
      );
      if (!ref) await db.query("UPDATE audit_findings SET ref = 'FND-' || LPAD(id::text, 5, '0') WHERE id = $1", [result.rows[0].id]);
      inserted += 1;
    }
    res.json({ inserted, skipped, errors });
  }));

  app.patch("/findings/:id", auth, own("FINDING UPDATE", async (req, res) => {
    const { values, error } = readFinding(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    const keys = Object.keys(values);
    if (!keys.length) return res.status(400).json({ error: "Nothing to update" });
    const before = (await db.query("SELECT assignee_id, cc FROM audit_findings WHERE id = $1", [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: "Finding not found" });
    // Status changed on the edit form: closing records when and who, anything else clears it.
    const toPerson = values.assignee_id ? ", owner_department = NULL" : ""; // given to a person: no longer a team task
    const closing = toPerson + (values.status === undefined ? "" : values.status === "Closed"
      ? `, closed_at = CASE WHEN status = 'Closed' THEN closed_at ELSE NOW() END, closed_by = CASE WHEN status = 'Closed' THEN closed_by ELSE $${keys.length + 2} END`
      : ", closed_at = NULL, closed_by = NULL");
    const result = await db.query(
      `UPDATE audit_findings SET ${keys.map((key, i) => `${key} = $${i + 1}${key === "cc" ? "::jsonb" : ""}`).join(", ")}, updated_at = NOW()${closing} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((key) => values[key]), req.params.id, ...(values.status === "Closed" ? [userName(req.user)] : [])]
    );
    const finding = toApi(result.rows[0]);
    // Newly added to CC: told now.
    const hadCc = new Set((before.cc || []).map((person) => String(person.id)));
    const addedCc = (finding.cc || []).filter((person) => !hadCc.has(String(person.id)));
    if (addedCc.length) notifyCc(db, { ...finding, cc: addedCc }, `You're in CC on ${finding.ref}`, `${finding.title} · with ${finding.assignee_name || finding.owner_department || "—"} (added by ${userName(req.user)}).`, [userName(req.user)]);
    if (values.assignee_id && values.assignee_id !== before.assignee_id) {
      notifyAssignee(db, finding, userName(req.user), true);
      if (!req.body?.files_pending) await sendFindingToOwner(db, finding.id, { byName: userName(req.user), reassigned: true }).catch((err) => console.log("FINDING WHATSAPP ERROR:", err.message));
      return res.json(toApi((await db.query("SELECT * FROM audit_findings WHERE id = $1", [finding.id])).rows[0]));
    }
    res.json(finding);
  }));

  // A follow-up check: notes plus the outcome status, which becomes the finding's status.
  app.post("/findings/:id/follow-ups", auth, own("FINDING FOLLOW-UP", async (req, res) => {
    const status = String(req.body?.status || "");
    const notes = String(req.body?.notes || "").trim().slice(0, 4000);
    const date = String(req.body?.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!FINDING_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status" });
    if (!notes) return res.status(400).json({ error: "Write what was checked" });
    if (Number.isNaN(new Date(date).getTime())) return res.status(400).json({ error: "Invalid date" });
    const entry = {
      date,
      status,
      notes,
      auditor: String(req.body?.auditor || "").trim().slice(0, 80) || userName(req.user),
      recordedBy: userName(req.user),
      recordedAt: new Date().toISOString(),
    };
    // Closing records when and who; re-opening clears it.
    const result = await db.query(
      `UPDATE audit_findings SET follow_ups = follow_ups || $1::jsonb, status = $2, updated_at = NOW(),
         closed_at = CASE WHEN $2 = 'Closed' THEN COALESCE(CASE WHEN status = 'Closed' THEN closed_at END, NOW()) END,
         closed_by = CASE WHEN $2 = 'Closed' THEN COALESCE(CASE WHEN status = 'Closed' THEN closed_by END, $4) END
       WHERE id = $3 RETURNING *`,
      [JSON.stringify([entry]), status, req.params.id, userName(req.user)]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Finding not found" });
    // Started / resolved by someone else: the person who raised it is told on their phone.
    const finding = result.rows[0];
    const by = userName(req.user);
    if (["In Progress", "Closed"].includes(status) && finding.created_by && finding.created_by !== by) {
      const raiser = finding.created_by === "Admin" ? "admin" : (global.internalUsers || []).find((user) => user.name === finding.created_by)?.username;
      if (raiser) sendPushToUsers(db, [raiser], {
        title: status === "Closed" ? `✅ ${by} resolved ${finding.ref}` : `${by} started ${finding.ref}`,
        body: `${finding.title}${notes && !/^(started|resolved)\.?$/i.test(notes) ? ` · ${notes}` : ""}`.slice(0, 180), view: "findings",
      }).catch(() => {});
    }
    notifyCc(db, finding, status === "Closed" ? `✅ ${by} resolved ${finding.ref}` : `${finding.ref} is now ${status} (${by})`,
      `${finding.title}${notes && !/^(started|resolved)\.?$/i.test(notes) ? ` · ${notes}` : ""}`, [by, ["In Progress", "Closed"].includes(status) ? finding.created_by : null]); // the raiser was told above
    res.json(toApi(finding));
  }));

  /* Forward: the action owner (or whoever raised it, or an admin) passes the task to another
     person, or to a department, where anyone in it can take it. Kept in the follow-up trail. */
  const canPass = (finding, user) => user?.isAdmin || String(finding.assignee_id || "") === String(user?.userId || "")
    || (finding.created_by && finding.created_by === userName(user))
    || (!finding.assignee_id && finding.owner_department && finding.owner_department === user?.department);
  const trail = (status, notes, user) => ({
    date: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), status, notes,
    auditor: userName(user), recordedBy: userName(user), recordedAt: new Date().toISOString(),
  });
  app.post("/findings/:id/forward", auth, own("FINDING FORWARD", async (req, res) => {
    const finding = (await db.query("SELECT * FROM audit_findings WHERE id = $1", [req.params.id])).rows[0];
    if (!finding) return res.status(404).json({ error: "Finding not found" });
    if (finding.status === "Closed") return res.status(400).json({ error: "This task is closed. Re-open it first." });
    if (!canPass(finding, req.user)) return res.status(403).json({ error: "Only the person it's assigned to, whoever raised it, or an admin can forward it" });
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const from = finding.assignee_name || (finding.owner_department ? `${finding.owner_department} team` : "nobody");
    let result;
    if (req.body?.department) {
      const department = String(req.body.department).trim().slice(0, 80);
      const members = (global.internalUsers || []).filter((user) => user.department === department);
      if (!members.length) return res.status(400).json({ error: `Nobody is in ${department} yet` });
      const entry = trail(finding.status, `Forwarded from ${from} to the ${department} team${note ? `: ${note}` : "."}`, req.user);
      result = await db.query(
        `UPDATE audit_findings SET assignee_id = NULL, assignee_name = NULL, owner_department = $2, follow_ups = follow_ups || $3::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [finding.id, department, JSON.stringify([entry])]
      );
      sendPushToUsers(db, members.map((user) => user.username).filter(Boolean), {
        title: `Audit task for the ${department} team · ${finding.ref}`, body: `${finding.title} (from ${userName(req.user)}). Open it and tap "Take it".`.slice(0, 180), view: "findings",
      }).catch(() => {});
      res.locals.activity = { section: "Internal Audit", action: `Forwarded ${finding.ref} to the ${department} team` };
    } else {
      const owner = employeeById(req.body?.assignee_id);
      if (!owner) return res.status(400).json({ error: "Choose who to forward it to" });
      if (String(owner.id) === String(finding.assignee_id)) return res.status(400).json({ error: `${owner.name} already has it` });
      const entry = trail(finding.status, `Forwarded from ${from} to ${owner.name}${note ? `: ${note}` : "."}`, req.user);
      result = await db.query(
        `UPDATE audit_findings SET assignee_id = $2, assignee_name = $3, owner_department = NULL, follow_ups = follow_ups || $4::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [finding.id, String(owner.id), owner.name, JSON.stringify([entry])]
      );
      notifyAssignee(db, toApi(result.rows[0]), userName(req.user), true);
      res.locals.activity = { section: "Internal Audit", action: `Forwarded ${finding.ref} to ${owner.name}` };
    }
    const now = result.rows[0];
    notifyCc(db, now, `${finding.ref} forwarded to ${now.assignee_name || `the ${now.owner_department} team`}`, `${finding.title} (by ${userName(req.user)})${note ? ` · ${note}` : ""}`, [userName(req.user)]);
    res.json(toApi(result.rows[0]));
  }));

  // Someone in the department a task was forwarded to takes it: it becomes theirs.
  app.post("/findings/:id/take", auth, own("FINDING TAKE", async (req, res) => {
    const finding = (await db.query("SELECT * FROM audit_findings WHERE id = $1", [req.params.id])).rows[0];
    if (!finding) return res.status(404).json({ error: "Finding not found" });
    if (finding.assignee_id) return res.status(400).json({ error: `${finding.assignee_name || "Someone"} has already taken it` });
    if (!req.user?.userId) return res.status(400).json({ error: "Log in with your own account to take a task" });
    if (!req.user?.isAdmin && finding.owner_department !== req.user?.department) return res.status(403).json({ error: `This task is for the ${finding.owner_department} team` });
    const entry = trail(finding.status, `Taken by ${userName(req.user)} (${finding.owner_department} team).`, req.user);
    const result = await db.query(
      `UPDATE audit_findings SET assignee_id = $2, assignee_name = $3, owner_department = NULL, follow_ups = follow_ups || $4::jsonb, updated_at = NOW()
       WHERE id = $1 AND assignee_id IS NULL RETURNING *`,
      [finding.id, String(req.user.userId), userName(req.user), JSON.stringify([entry])]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Someone else took it just now" });
    res.locals.activity = { section: "Internal Audit", action: `Took ${finding.ref} for the ${finding.owner_department} team` };
    res.json(toApi(result.rows[0]));
  }));

  // Send (or send again) the task to the action owner's WhatsApp.
  app.post("/findings/:id/whatsapp", auth, own("FINDING WHATSAPP", async (req, res) => {
    const result = await sendFindingToOwner(db, Number(req.params.id), { byName: userName(req.user), reassigned: Boolean(req.body?.reassigned) });
    const finding = (await db.query("SELECT * FROM audit_findings WHERE id = $1", [req.params.id])).rows[0];
    if (!finding) return res.status(404).json({ error: "Finding not found" });
    res.json({ ...toApi(finding), sent: Boolean(result?.ok) });
  }));

  // The locations to choose from: the Refill Audit locations.
  app.get("/findings/locations", auth, handle("FINDING LOCATIONS", async (req, res) => {
    const { rows } = await db.query("SELECT name FROM audit_locations ORDER BY name").catch(() => ({ rows: [] }));
    res.json(rows.map((row) => row.name));
  }));

  // Attach a file ({ name, type, data: base64 }, up to 15 MB): photos, PDFs, Excel, Word…
  app.post("/findings/:id/attachments", auth, own("FINDING ATTACH", async (req, res) => {
    const { rows } = await db.query("SELECT jsonb_array_length(attachments) AS count FROM audit_findings WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Finding not found" });
    if (rows[0].count >= MAX_ATTACHMENTS) return res.status(400).json({ error: `Up to ${MAX_ATTACHMENTS} files per finding` });
    let stored;
    try {
      stored = await storeDashboardFile(req.body?.file);
    } catch (err) {
      return res.status(400).json({ error: err.message || "Could not store the file" });
    }
    const entry = { url: stored.url, name: stored.name, kind: stored.kind, mime: stored.mime, size: stored.size, by: userName(req.user), at: new Date().toISOString() };
    const result = await db.query("UPDATE audit_findings SET attachments = attachments || $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING *", [JSON.stringify([entry]), req.params.id]);
    res.locals.activity = { section: "Internal Audit", action: `Attached "${stored.name}" to ${result.rows[0].ref}` };
    res.json(toApi(result.rows[0]));
  }));

  // Remove an attached file: whoever attached it, or an admin.
  app.delete("/findings/:id/attachments/:index", auth, own("FINDING ATTACH DELETE", async (req, res) => {
    const { rows } = await db.query("SELECT attachments FROM audit_findings WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Finding not found" });
    const list = rows[0].attachments || [];
    const index = Number(req.params.index);
    const file = list[index];
    if (!file || (req.query.url && file.url !== req.query.url)) return res.status(404).json({ error: "That file is no longer there. Refresh the page." });
    if (!req.user?.isAdmin && file.by !== userName(req.user)) return res.status(403).json({ error: "Only the person who attached it or an admin can remove it" });
    list.splice(index, 1);
    const result = await db.query("UPDATE audit_findings SET attachments = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING *", [JSON.stringify(list), req.params.id]);
    res.json(toApi(result.rows[0]));
  }));

  app.delete("/findings/:id", auth, handle("FINDING DELETE", async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only admin can delete findings" });
    await db.query("DELETE FROM audit_findings WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));
}
