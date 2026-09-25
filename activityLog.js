/* =========================================================
    ACTIVITY LOG
    A record of who changed what and when: refunds, takeovers, audits,
    deletions, employee changes, logins. Every successful change made
    through the dashboard is written here automatically; routes can give a
    clearer description by setting res.locals.activity.
========================================================= */
import { hasPage } from "./accessControl.js";

let db = null;

export async function ensureActivityLog(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      actor_key TEXT, actor_name TEXT, actor_role TEXT,
      section TEXT, action TEXT NOT NULL, entity TEXT,
      details JSONB, ip TEXT
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS activity_log_actor_idx ON activity_log (actor_key)");
}

function actorOf(user) {
  if (!user) return { key: null, name: "Unknown", role: null };
  if (user.owner) return { key: "owner", name: "Owner (shared admin)", role: "Owner" };
  return { key: String(user.userId || user.id || user.username), name: user.name || user.username, role: user.roleLabel || null };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
}

export async function logActivity({ user, req, section, action, entity = null, details = null, actorName = null }) {
  if (!db) return;
  try {
    const actor = actorOf(user);
    await db.query(
      `INSERT INTO activity_log (actor_key, actor_name, actor_role, section, action, entity, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.key, actorName || actor.name, actor.role, section, action, entity, details ? JSON.stringify(details) : null, req ? clientIp(req) : null]
    );
  } catch (err) {
    console.log("ACTIVITY LOG ERROR:", err.message);
  }
}

// Passwords never go in the log, and big uploads are reduced to names and counts.
function cleanBody(body) {
  if (!body || typeof body !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (/password|token|secret/i.test(key)) continue;
    if (key === "files" && Array.isArray(value)) out.files = value.map((file) => file?.name).filter(Boolean);
    else if (["rows", "photos", "checklist", "expiry_items"].includes(key) && Array.isArray(value)) out[key] = `${value.length} item${value.length === 1 ? "" : "s"}`;
    else if (key === "data" || key === "file") out[key] = "[file]";
    else if (typeof value === "string") out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    else if (value === null || ["number", "boolean"].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.length > 20 ? `${value.length} items` : value;
    else out[key] = "[object]";
  }
  return Object.keys(out).length ? out : null;
}

const VERB = { POST: "Added", PATCH: "Updated", PUT: "Updated", DELETE: "Deleted" };

// Plain-English descriptions for the dashboard's actions: [method, pattern, section, (match, body) => text].
const DESCRIPTIONS = [
  ["POST", /^\/admin\/takeover$/, "Tickets", (m, b) => `Took over ticket #${b.ticketId || b.phone || ""}`],
  ["POST", /^\/admin\/release$/, "Tickets", (m, b) => `Handed ticket #${b.ticketId || b.phone || ""} back to the bot`],
  ["POST", /^\/admin\/send$/, "Tickets", (m, b) => `Sent a message on ticket #${b.ticketId || b.phone || ""}`],
  ["POST", /^\/admin\/tickets\/(\d+)\/send$/, "Tickets", (m, b) => `Sent ${b.files?.length ? `${b.files.length} file${b.files.length === 1 ? "" : "s"}${b.text ? " and a message" : ""}` : "a message"} on ticket #${m[1]}`],
  ["POST", /^\/admin\/tickets\/(\d+)\/messages\/\d+\/retry$/, "Tickets", (m) => `Resent a failed message on ticket #${m[1]}`],
  ["PATCH", /^\/admin\/tickets\/(\d+)$/, "Tickets", (m, b) => `Updated ticket #${m[1]} (${Object.keys(b).join(", ")})`],
  ["POST", /^\/admin\/tickets\/(\d+)\/reopen$/, "Tickets", (m) => `Reopened ticket #${m[1]}`],
  ["POST", /^\/tickets\/(\d+)\/refund-amount$/, "Tickets", (m, b) => `Set refund amount to ₹${b.refund_amount ?? ""} on ticket #${m[1]}`],
  ["POST", /^\/tickets\/(\d+)\/scan-upi$/, "Tickets", (m) => `Read the UPI screenshot on ticket #${m[1]}`],
  ["POST", /^\/ticket\/action$/, "Tickets", (m, b) => `Marked ticket #${b.id || b.ticketId || ""} as ${String(b.action || b.status || "").replace(/_/g, " ")}`],
  ["DELETE", /^\/tickets\/(\d+)$/, "Tickets", (m) => `Deleted ticket #${m[1]}`],
  ["POST", /^\/admin\/quick-replies$/, "Tickets", (m, b) => `Added quick reply "${b.title || ""}"`],
  ["DELETE", /^\/admin\/quick-replies\/(\d+)$/, "Tickets", (m) => `Deleted quick reply #${m[1]}`],
  ["POST", /^\/admin\/settings$/, "Settings", () => "Changed bot settings"],
  ["POST", /^\/admin\/paytm-setting$/, "Settings", (m, b) => `Turned Paytm verification ${b.enabled ? "on" : "off"}`],
  ["POST", /^\/audits$/, "Refill Audit", (m, b) => `Saved a refill audit for ${b.location || "a site"}`],
  ["POST", /^\/audits\/import$/, "Refill Audit", (m, b) => `Imported ${b.rows?.length ?? ""} audits`],
  ["DELETE", /^\/audits\/(\d+)$/, "Refill Audit", (m) => `Deleted audit #${m[1]}`],
  ["PATCH", /^\/audit\/capa\/(\d+)$/, "Refill Audit", (m, b) => `Updated CAPA #${m[1]}${b.status ? ` to ${b.status}` : ""}`],
  ["POST", /^\/audit\/capa\/(\d+)\/send$/, "Refill Audit", (m) => `Sent CAPA #${m[1]} to the refiller on WhatsApp`],
  [null, /^\/audit\/refillers(?:\/(\d+))?$/, "Refill Audit", (m, b, method) => `${VERB[method]} refiller ${b.name || (m[1] ? `#${m[1]}` : "")}`],
  [null, /^\/audit\/locations(?:\/(\d+))?$/, "Refill Audit", (m, b, method) => `${VERB[method]} site ${b.name || (m[1] ? `#${m[1]}` : "")}`],
  ["POST", /^\/findings$/, "Internal Audit", (m, b) => `Added finding "${b.title || ""}"`],
  ["POST", /^\/findings\/import$/, "Internal Audit", (m, b) => `Imported ${b.rows?.length ?? ""} findings`],
  ["POST", /^\/findings\/(\d+)\/follow-ups$/, "Internal Audit", (m) => `Added a follow-up to finding #${m[1]}`],
  ["PATCH", /^\/findings\/(\d+)$/, "Internal Audit", (m, b) => `Updated finding #${m[1]}${b.status ? ` (status: ${b.status})` : ""}`],
  ["DELETE", /^\/findings\/(\d+)$/, "Internal Audit", (m) => `Deleted finding #${m[1]}`],
  ["POST", /^\/expiry$/, "Expiry Tracking", (m, b) => `Added batch ${b.product_name || b.product_code || ""}`],
  ["POST", /^\/expiry\/import$/, "Expiry Tracking", () => "Imported expiry batches"],
  ["PATCH", /^\/expiry\/(\d+)$/, "Expiry Tracking", (m) => `Updated batch #${m[1]}`],
  ["DELETE", /^\/expiry\/(\d+)$/, "Expiry Tracking", (m) => `Deleted batch #${m[1]}`],
  ["POST", /^\/internal\/users$/, "Employees", (m, b) => `Added employee ${b.name || ""}`],
  ["PATCH", /^\/internal\/users\/([\d.]+)$/, "Employees", (m, b) => `Updated employee (${Object.keys(b).join(", ")})`],
  ["DELETE", /^\/internal\/users\/([\d.]+)$/, "Employees", () => "Deleted an employee"],
  ["POST", /^\/internal\/users\/([\d.]+)\/reset-password$/, "Employees", () => "Reset an employee's password"],
  ["POST", /^\/me\/password$/, "Account", () => "Changed their own password"],
  ["DELETE", /^\/internal\/chats\/([\w.-]+)$/, "Internal Chat", () => "Deleted an internal chat"],
  ["POST", /^\/operations\/import$/, "Operations", (m, b) => `Imported ${b.type || "operations"} data`],
  [null, /^\/(leads|host-sites|machines|brands|skus)(?:\/([\w-]+))?/, "Operations", (m, b, method) => `${VERB[method] || method} ${m[1].replace(/-/g, " ").replace(/s$/, "")}${m[2] ? ` #${m[2]}` : ""}${b.name ? ` "${b.name}"` : ""}`],
];

// Everyday chat actions are not "changes" and would flood the log.
const SKIP = [
  /^\/webhook/, /^\/login$/, /^\/internal\/chats\/[^/]+\/messages/, /^\/internal\/chats\/[^/]+\/read/,
  /^\/internal\/push\//, /^\/internal\/saved-replies/, /^\/internal\/direct$/, /^\/internal\/chats$/,
];

function describe(method, path, body) {
  for (const [verb, pattern, section, text] of DESCRIPTIONS) {
    if (verb && verb !== method) continue;
    const match = path.match(pattern);
    if (match) return { section, action: text(match, body || {}, method) };
  }
  return { section: "Other", action: `${method} ${path}` };
}

// Logs every successful change (anything but a read) once the response is sent.
export function activityMiddleware(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || SKIP.some((pattern) => pattern.test(req.path))) return next();
  const method = req.method;
  const path = req.path;
  const body = req.body;
  res.on("finish", () => {
    if (res.statusCode >= 400 || !req.user) return;
    const described = describe(method, path, body);
    const custom = res.locals.activity || {};
    logActivity({
      user: req.user,
      req,
      section: custom.section || described.section,
      action: custom.action || described.action,
      entity: custom.entity || null,
      details: custom.details ?? cleanBody(body),
    });
  });
  next();
}

export function registerActivityRoutes(app, { auth }) {
  app.get("/activity", auth, async (req, res) => {
    try {
      if (!hasPage(req.user, "activity")) return res.status(403).json({ error: "No access to the activity log" });
      const where = [];
      const values = [];
      // Each "?" in a condition becomes that condition's one numbered parameter.
      const add = (sql, value) => { values.push(value); where.push(sql.replaceAll("?", `$${values.length}`)); };
      if (req.query.actor) add("actor_key = ?", String(req.query.actor));
      if (req.query.section) add("section = ?", String(req.query.section));
      if (req.query.from) add("created_at >= ?::date", String(req.query.from));
      if (req.query.to) add("created_at < (?::date + INTERVAL '1 day')", String(req.query.to));
      if (req.query.q) add("(action ILIKE ? OR actor_name ILIKE ?)", `%${String(req.query.q).trim()}%`);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [rows, people, total] = await Promise.all([
        db.query(`SELECT * FROM activity_log ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, values),
        db.query("SELECT actor_key, MAX(actor_name) AS actor_name, COUNT(*)::int AS count FROM activity_log WHERE actor_key IS NOT NULL GROUP BY actor_key ORDER BY MAX(actor_name)"),
        db.query(`SELECT COUNT(*)::int AS count FROM activity_log ${whereSql}`, values),
      ]);
      res.json({ rows: rows.rows, people: people.rows, total: total.rows[0].count });
    } catch (err) {
      console.log("ACTIVITY FETCH ERROR:", err.message);
      res.status(500).json({ error: "Could not load the activity log" });
    }
  });
}
