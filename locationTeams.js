/* =========================================================
    LOCATION TEAMS
    Who looks after each location: its refiller (Refill Audit, audit_locations.refiller_id), the
    area managers (audit_locations.managers, names, first = main manager) and helpers
    (audit_locations.support). Filled once from the "Operators Location List" (Oct 2026);
    anything that list says differently from the dashboard is kept as a note to apply or dismiss.

    Managers are matched to employees by name (Employees & access) for phone, CC and alerts.
    A manager on leave can be covered by someone else until a date (app_settings
    "location_manager_cover"); alerts then go to the cover.

    Used by: the Locations & teams page and the location card, Internal Audit (action owner and
    CC filled from the location), My Home ("My locations"), and alerts (missed refills, new Refill
    Audit problems, a refiller's "Can't fix") which go to the location's managers.
========================================================= */
import { sendPushToUsers } from "./pushNotifications.js";

let db = null;
const COVER_KEY = "location_manager_cover";
const NOTES_KEY = "location_teams_import_notes";
const SEEDED_KEY = "location_teams_seeded_v1";
const istDay = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (phone) => { const only = String(phone || "").replace(/\D/g, ""); return only.length === 10 ? `91${only}` : only; };

// The Operators Location List: [location, refiller, managers (main first), helpers].
// Location names as already on the dashboard (Refill Audit), so they match.
const LIST = [
  ...["NT3", "Strides - 2", "Strides - 1", "Paychex Primco", "Paychex Vista", "Call Hub", "Fortis", "Bluebrich", "Fleek", "Amagi", "Greaves New", "Graves old"].map((name) => [name, "Promod", ["Kushith"]]),
  ["Bitgo", "Abbas", ["Kushith", "Praharsha"]],
  ...["Nes", "Hostel MI", "NI", "Smart stream", "NT1", "NT 4"].map((name) => [name, "Abbas", ["Kushith"]]),
  ...["Securanix", "Alorica nitish", "Pixxel", "PWC (Bagmane)", "Sila decathlon", "NT 2", "NT 5", "Caterpiller", "Solera"].map((name) => [name, "Nitish", ["Monish"]]),
  ...["Stonex", "ODA", "RRI", "Sangrila", "Millennial Hostel (vasanth nagar)", "Millennial Hostel (Mysur Road)", "Alorica (Mysure Road)", "Lewis", "clicktech", "Enerpac", "Spain Io"].map((name) => [name, "Karan Sharma", ["Mihika", "Aparna"]]),
  ...["UI path (onex)", "Alorica Sachin", "Sony(Average sales)", "Point 72", "Awfis ebay (less sales)", "Micron", "BDO", "Polaris", "ODA (Raman)", "Refyne (less sales)"].map((name) => [name, "Raman", ["Monish"]]),
  ...["Devrev", "Pwc", "SBS", "Opentext", "Anthropic"].map((name) => [name, "Jitendar", ["Aparna"]]),
  ...["SCB", "Mouser 1 and 2", "Oberoi", "Natural Remedies", "ittiam", "Acer", "Book my show", "Mother India"].map((name) => [name, "Manoj", ["Mihika", "Aparna"]]),
  ...["Fluck", "Techtronix", "Newtap"].map((name) => [name, "Karan R", ["Aparna"]]),
  ["CRED", "Karan R", ["Aparna"], ["Chand", "Akash"]],
  ["Nutanix", "Harish", ["Monish"], ["Rahul", "Vishnu", "Vijay"]],
  ["ZF", "Rahul", ["Monish"]],
];

async function getSetting(key, fallback) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]).catch(() => ({ rows: [] }));
  try { return rows[0] ? JSON.parse(rows[0].value) : fallback; } catch { return fallback; }
}
const setSetting = (key, value) => db.query(
  "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
  [key, JSON.stringify(value)]
);

export async function ensureLocationTeams(database) {
  db = database;
  await db.query("ALTER TABLE audit_locations ADD COLUMN IF NOT EXISTS managers TEXT[] NOT NULL DEFAULT '{}'");
  if (await getSetting(SEEDED_KEY, false)) return;
  // Once: managers from the list; differences (refiller, helpers, names not found) become notes.
  const { rows: locations } = await db.query("SELECT l.id, l.name, l.support, l.managers, r.name AS refiller FROM audit_locations l LEFT JOIN audit_refillers r ON r.id = l.refiller_id");
  const byName = new Map(locations.map((location) => [norm(location.name), location]));
  const notes = [];
  for (const [name, refiller, managers, helpers = []] of LIST) {
    const location = byName.get(norm(name));
    if (!location) { notes.push({ kind: "missing", location: name, refiller, managers, helpers }); continue; }
    if (!location.managers?.length) await db.query("UPDATE audit_locations SET managers = $2, updated_at = NOW() WHERE id = $1", [location.id, managers]);
    if (norm(location.refiller) !== norm(refiller)) notes.push({ kind: "refiller", location_id: location.id, location: location.name, now: location.refiller || null, list: refiller });
    if (helpers.length && norm(location.support) !== norm(helpers.join(""))) notes.push({ kind: "helpers", location_id: location.id, location: location.name, now: location.support || null, list: helpers.join(", ") });
  }
  await setSetting(NOTES_KEY, notes);
  await setSetting(SEEDED_KEY, true);
  console.log(`📍 Location teams: managers added from the operators list (${notes.length} note${notes.length === 1 ? "" : "s"} to check)`);
}

/* ---------- People ---------- */
// An employee for a manager's name: full name, else a unique first-name match.
export function employeeFor(name) {
  const users = global.internalUsers || [];
  const wanted = norm(name);
  if (!wanted) return null;
  const exact = users.find((user) => norm(user.name) === wanted);
  if (exact) return exact;
  const first = users.filter((user) => norm(String(user.name || "").split(/\s+/)[0]) === wanted);
  return first.length === 1 ? first[0] : null;
}
const coverNow = (cover, name) => {
  const entry = cover?.[name];
  return entry && entry.until >= istDay() ? entry : null;
};
// The managers alerts go to right now (a manager on leave → their cover).
export async function managersFor(location) {
  const cover = await getSetting(COVER_KEY, {});
  return (location?.managers || []).map((name) => {
    const covering = coverNow(cover, name);
    const person = covering ? covering.by : name;
    const user = employeeFor(person);
    return { name, acting: person, covered_by: covering ? covering.by : null, until: covering?.until || null, user_id: user ? String(user.id) : null, username: user?.username || null, phone: user?.phone || null };
  });
}
async function locationByName(name) {
  const { rows } = await db.query("SELECT id, name, managers FROM audit_locations WHERE LOWER(name) = LOWER($1) OR regexp_replace(LOWER(name), '[^a-z0-9]', '', 'g') = $2 LIMIT 1", [name, norm(name)]);
  return rows[0] || null;
}

// Alerts for a location go to its managers (or whoever covers them).
export async function notifyLocationManagers(locationIdOrName, payload) {
  if (!db) return;
  try {
    const location = typeof locationIdOrName === "number"
      ? (await db.query("SELECT id, name, managers FROM audit_locations WHERE id = $1", [locationIdOrName])).rows[0]
      : await locationByName(locationIdOrName);
    if (!location) return;
    const usernames = (await managersFor(location)).map((manager) => manager.username).filter(Boolean);
    if (usernames.length) await sendPushToUsers(db, [...new Set(usernames)], { view: "location-teams", ...payload });
  } catch (err) {
    console.log("LOCATION ALERT ERROR:", err.message);
  }
}

/* ---------- Numbers per location ---------- */
async function stats() {
  const today = istDay();
  const [findings, capa, refills, sales] = await Promise.all([
    db.query(`SELECT loc, COUNT(*)::int AS open, COUNT(*) FILTER (WHERE due_date < $1::date)::int AS overdue
              FROM audit_findings, UNNEST(locations) AS loc WHERE status <> 'Closed' GROUP BY loc`, [today]).catch(() => ({ rows: [] })),
    db.query("SELECT location, COUNT(*)::int AS open FROM audit_capa WHERE status = 'OPEN' GROUP BY location").catch(() => ({ rows: [] })),
    db.query(`SELECT location_id, COUNT(*) FILTER (WHERE status = 'missed')::int AS missed, COUNT(*) FILTER (WHERE status IN ('done', 'verified'))::int AS done
              FROM refill_tasks WHERE due_date >= to_char(NOW() + INTERVAL '330 minutes' - INTERVAL '14 days', 'YYYY-MM-DD') AND due_date <= $1 GROUP BY location_id`, [today]).catch(() => ({ rows: [] })),
    db.query(`SELECT m.location_id,
                     COALESCE(SUM(s.amount) FILTER (WHERE s.day > $1::date - 30), 0)::float AS value,
                     COALESCE(SUM(s.amount) FILTER (WHERE s.day <= $1::date - 30), 0)::float AS prev
              FROM stock_sales s JOIN stock_machines m ON m.id = s.machine_id
              WHERE m.location_id IS NOT NULL AND s.day > $1::date - 60 GROUP BY m.location_id`, [today]).catch(() => ({ rows: [] })),
  ]);
  return {
    findings: new Map(findings.rows.map((row) => [norm(row.loc), row])),
    capa: new Map(capa.rows.map((row) => [norm(row.location), row.open])),
    refills: new Map(refills.rows.map((row) => [row.location_id, row])),
    sales: new Map(sales.rows.map((row) => [row.location_id, row])),
  };
}

async function teamRows() {
  const { rows } = await db.query(
    `SELECT l.id, l.name, l.machine_code, l.support, l.managers, l.refiller_id, r.name AS refiller_name, r.phone AS refiller_phone
     FROM audit_locations l LEFT JOIN audit_refillers r ON r.id = l.refiller_id ORDER BY l.name`
  );
  const numbers = await stats();
  const out = [];
  for (const location of rows) {
    const finding = numbers.findings.get(norm(location.name));
    const refill = numbers.refills.get(location.id);
    const sale = numbers.sales.get(location.id);
    out.push({
      id: location.id, name: location.name, machine_code: location.machine_code,
      refiller: location.refiller_id ? { id: location.refiller_id, name: location.refiller_name, phone: digits(location.refiller_phone) || null } : null,
      helpers: location.support || "",
      managers: await managersFor(location),
      open_tasks: finding?.open || 0, overdue_tasks: finding?.overdue || 0,
      open_problems: numbers.capa.get(norm(location.name)) || 0,
      missed_refills: refill?.missed || 0, refills_done: refill?.done || 0,
      sales_30d: sale ? Math.round(sale.value) : null, sales_prev_30d: sale ? Math.round(sale.prev) : null,
    });
  }
  return out;
}

// For My Home: the locations this person manages (or is covering), with what needs attention.
export async function myLocations(user) {
  if (!db || !user?.name) return [];
  const rows = await teamRows();
  const mine = (manager) => (manager.user_id && String(manager.user_id) === String(user.userId)) || norm(manager.acting) === norm(user.name);
  return rows.filter((row) => row.managers.some(mine))
    .map((row) => ({ ...row, attention: row.overdue_tasks * 3 + row.missed_refills * 2 + row.open_problems + row.open_tasks }))
    .sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name));
}

export function registerLocationTeamRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };
  const by = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Admin");

  app.get("/location-teams", auth, handle("LOCATION TEAMS", async (req, res) => {
    const [locations, refillers, cover, notes] = await Promise.all([
      teamRows(),
      db.query("SELECT id, name, phone FROM audit_refillers ORDER BY name").then((result) => result.rows),
      getSetting(COVER_KEY, {}),
      getSetting(NOTES_KEY, []),
    ]);
    const today = istDay();
    res.json({
      locations, refillers: refillers.map((row) => ({ ...row, phone: digits(row.phone) || null })),
      cover: Object.fromEntries(Object.entries(cover).filter(([, entry]) => entry.until >= today)),
      notes, can_edit: Boolean(req.user?.isAdmin || req.user?.pages?.includes("audit")),
    });
  }));

  // One location's card: the team, open tasks and problems, recent refills, sales.
  app.get("/location-teams/:id", auth, handle("LOCATION CARD", async (req, res) => {
    const row = (await teamRows()).find((item) => String(item.id) === String(req.params.id));
    if (!row) return res.status(404).json({ error: "Location not found" });
    const [findings, problems, refills, products] = await Promise.all([
      db.query("SELECT id, ref, title, status, risk, due_date::text, assignee_name, owner_department FROM audit_findings WHERE status <> 'Closed' AND $1 = ANY(locations) ORDER BY due_date LIMIT 20", [row.name]).catch(() => ({ rows: [] })),
      db.query("SELECT id, ref, defect, severity, refiller, created_at, escalated_at FROM audit_capa WHERE status = 'OPEN' AND LOWER(location) = LOWER($1) ORDER BY created_at DESC LIMIT 20", [row.name]).catch(() => ({ rows: [] })),
      db.query("SELECT id, due_date, due_time, status, refiller_name, completed_at FROM refill_tasks WHERE location_id = $1 AND due_date <= to_char(NOW() + INTERVAL '330 minutes', 'YYYY-MM-DD') ORDER BY due_date DESC, due_time DESC LIMIT 8", [row.id]).catch(() => ({ rows: [] })),
      db.query(`SELECT s.product, SUM(s.qty)::int AS units FROM stock_sales s JOIN stock_machines m ON m.id = s.machine_id
                WHERE m.location_id = $1 AND s.day > CURRENT_DATE - 30 GROUP BY s.product ORDER BY units DESC LIMIT 5`, [row.id]).catch(() => ({ rows: [] })),
    ]);
    res.json({ ...row, findings: findings.rows, problems: problems.rows, refills: refills.rows, top_products: products.rows });
  }));

  // Change who looks after a location: refiller, managers (names, main first), helpers.
  app.patch("/location-teams/:id", auth, handle("LOCATION TEAM UPDATE", async (req, res) => {
    const sets = [];
    const values = [];
    const add = (sql, value) => { values.push(value); sets.push(`${sql} = $${values.length + 1}`); };
    if (req.body?.refiller_id !== undefined) add("refiller_id", req.body.refiller_id ? Number(req.body.refiller_id) : null);
    if (req.body?.managers !== undefined) add("managers", [...new Set((Array.isArray(req.body.managers) ? req.body.managers : []).map((name) => String(name || "").trim().slice(0, 60)).filter(Boolean))].slice(0, 6));
    if (req.body?.helpers !== undefined) add("support", String(req.body.helpers || "").trim().slice(0, 200) || null);
    if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
    const { rows } = await db.query(`UPDATE audit_locations SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING name`, [req.params.id, ...values]);
    if (!rows.length) return res.status(404).json({ error: "Location not found" });
    res.locals.activity = { section: "Locations & teams", action: `Changed the team for ${rows[0].name}` };
    res.json((await teamRows()).find((item) => String(item.id) === String(req.params.id)));
  }));

  // A manager on leave: someone covers their locations until a date (alerts go to them).
  app.put("/location-teams/cover", auth, handle("LOCATION COVER", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const coverBy = String(req.body?.by || "").trim();
    const until = String(req.body?.until || "");
    if (!name) return res.status(400).json({ error: "Choose the manager" });
    const cover = await getSetting(COVER_KEY, {});
    if (!coverBy) delete cover[name];
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < istDay()) return res.status(400).json({ error: "Choose until when (today or later)" });
      if (norm(coverBy) === norm(name)) return res.status(400).json({ error: "Choose someone else to cover" });
      cover[name] = { by: coverBy, until, set_by: by(req.user) };
    }
    await setSetting(COVER_KEY, cover);
    res.locals.activity = { section: "Locations & teams", action: coverBy ? `${coverBy} covers ${name}'s locations until ${until}` : `${name} is back (cover removed)` };
    res.json({ success: true });
  }));

  // The operators-list notes: apply what the list says, or dismiss.
  app.post("/location-teams/notes/:index", auth, handle("LOCATION NOTE", async (req, res) => {
    const notes = await getSetting(NOTES_KEY, []);
    const index = Number(req.params.index);
    const note = notes[index];
    if (!note) return res.status(404).json({ error: "That note is gone. Refresh the page." });
    if (req.body?.action === "apply") {
      if (note.kind === "refiller") {
        const { rows } = await db.query("SELECT id FROM audit_refillers WHERE LOWER(name) = LOWER($1)", [note.list]);
        if (!rows.length) return res.status(400).json({ error: `There's no refiller called ${note.list} in Refill Audit. Add or rename them there first.` });
        await db.query("UPDATE audit_locations SET refiller_id = $2, updated_at = NOW() WHERE id = $1", [note.location_id, rows[0].id]);
      } else if (note.kind === "helpers") {
        await db.query("UPDATE audit_locations SET support = $2, updated_at = NOW() WHERE id = $1", [note.location_id, note.list]);
      } else if (note.kind === "missing") {
        return res.status(400).json({ error: "Add this location in Refill Audit first (or rename the existing one), then dismiss this note." });
      }
    }
    notes.splice(index, 1);
    await setSetting(NOTES_KEY, notes);
    res.json({ success: true, notes });
  }));
}
