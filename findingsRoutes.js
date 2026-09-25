/* =========================================================
    INTERNAL AUDIT FINDINGS & CAPA
    Company-wide audit observations with a corrective action plan, an
    action owner (an employee), a due date and a follow-up trail.
    Everyone can view, log and follow up; only admin can delete.
========================================================= */
import { sendPushToUsers } from "./pushNotifications.js";

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
  const required = ["department", "observed_on", "title", "description", "risk", "action_plan", "assignee_id", "due_date"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      if (!partial && required.includes(key)) return { error: `${key.replace("_", " ")} is required` };
      continue;
    }
    if (required.includes(key) && !value) return { error: `${key.replace("_", " ")} is required` };
    values[key] = value || null;
  }
  if (values.risk && !FINDING_RISKS.includes(values.risk)) return { error: "Invalid risk level" };
  if (values.status && !FINDING_STATUSES.includes(values.status)) return { error: "Invalid status" };
  for (const key of ["observed_on", "due_date"]) {
    if (values[key] && Number.isNaN(new Date(values[key]).getTime())) return { error: `Invalid ${key.replace("_", " ")}` };
  }
  if (values.assignee_id) {
    const owner = employeeById(values.assignee_id);
    if (!owner) return { error: "Choose the action owner from the employee list" };
    values.assignee_name = owner.name;
  }
  return { values };
}

export function registerFindingsRoutes(app, { db, auth }) {
  ensureFindingsTable(db).catch((err) => console.log("FINDINGS TABLE ERROR:", err.message));

  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  app.get("/findings", auth, handle("FINDINGS", async (req, res) => {
    const result = await db.query("SELECT * FROM audit_findings ORDER BY created_at DESC LIMIT 2000");
    res.json(result.rows.map(toApi));
  }));

  app.post("/findings", auth, handle("FINDING CREATE", async (req, res) => {
    const { values, error } = readFinding(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const by = userName(req.user);
    const inserted = await db.query(
      `INSERT INTO audit_findings (department, observed_on, title, description, risk, status, root_cause, action_plan, assignee_id, assignee_name, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [values.department, values.observed_on, values.title, values.description, values.risk, values.status || "Open",
        values.root_cause, values.action_plan, values.assignee_id, values.assignee_name, values.due_date, by]
    );
    const finding = toApi((await db.query(
      "UPDATE audit_findings SET ref = 'FND-' || LPAD(id::text, 5, '0') WHERE id = $1 RETURNING *",
      [inserted.rows[0].id]
    )).rows[0]);
    notifyAssignee(db, finding, by, false);
    res.status(201).json(finding);
  }));

  // Import findings from CSV (the Export CSV format). Rows whose ref already exists are skipped.
  app.post("/findings/import", auth, handle("FINDINGS IMPORT", async (req, res) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Only admin can import findings" });
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

  app.patch("/findings/:id", auth, handle("FINDING UPDATE", async (req, res) => {
    const { values, error } = readFinding(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    const keys = Object.keys(values);
    if (!keys.length) return res.status(400).json({ error: "Nothing to update" });
    const before = (await db.query("SELECT assignee_id FROM audit_findings WHERE id = $1", [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: "Finding not found" });
    const result = await db.query(
      `UPDATE audit_findings SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(", ")}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((key) => values[key]), req.params.id]
    );
    const finding = toApi(result.rows[0]);
    if (values.assignee_id && values.assignee_id !== before.assignee_id) notifyAssignee(db, finding, userName(req.user), true);
    res.json(finding);
  }));

  // A follow-up check: notes plus the outcome status, which becomes the finding's status.
  app.post("/findings/:id/follow-ups", auth, handle("FINDING FOLLOW-UP", async (req, res) => {
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
    const result = await db.query(
      `UPDATE audit_findings SET follow_ups = follow_ups || $1::jsonb, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [JSON.stringify([entry]), status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Finding not found" });
    res.json(toApi(result.rows[0]));
  }));

  app.delete("/findings/:id", auth, handle("FINDING DELETE", async (req, res) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Only admin can delete findings" });
    await db.query("DELETE FROM audit_findings WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));
}
