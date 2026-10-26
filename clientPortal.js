/* =========================================================
    COMPANY ADMINS' SHOP (separate login)
    The admins of the companies Snackit supplies get their own login (username + password, made
    on the dashboard: Direct Supply → Setup → Company logins). It opens a shop page
    (/?shop on the dashboard address): item photos, Add to cart in kg / pcs, the delivery date,
    and their past orders with where each one is. No prices are shown.
    These logins are separate from employees: their sessions live in client_sessions and only
    open /client/* routes. An order placed here is the same as one from the company's order
    link (supplyOrderLink.js) and replaces it for that date.
========================================================= */
import crypto from "crypto";
import { hashPassword, verifyPassword, generatePassword } from "./accessControl.js";
import { catalogFor, placeOrder } from "./supplyOrderLink.js";

let db = null;
const SESSION_DAYS = 60;
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const digits = (phone) => { const only = String(phone || "").replace(/\D/g, ""); return only.length === 10 ? `91${only}` : only; };
const slug = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 24);

export async function ensureClientPortal(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS supply_client_users (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      phone TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS client_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES supply_client_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`DELETE FROM client_sessions WHERE last_seen_at < NOW() - INTERVAL '${SESSION_DAYS} days'`).catch(() => {});
}

// What the dashboard shows about a login: never the password.
const publicLogin = ({ password, ...rest }) => rest;

// A few wrong passwords are fine; many in a short time locks that username for 15 minutes.
const failures = new Map();
function locked(username) {
  const list = (failures.get(username) || []).filter((time) => Date.now() - time < 15 * 60000);
  failures.set(username, list);
  return list.length >= 8;
}

// The company admin's session: Bearer token → { user, company }.
async function clientAuth(req, res, next) {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!/^c-[a-f0-9]{48}$/.test(token)) return res.status(401).json({ error: "Please log in again." });
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.username, u.phone, u.company_id, c.name AS company_name, c.contact_name, c.active AS company_active
       FROM client_sessions s JOIN supply_client_users u ON u.id = s.user_id JOIN supply_companies c ON c.id = u.company_id
       WHERE s.token = $1 AND u.active = TRUE AND s.last_seen_at > NOW() - INTERVAL '${SESSION_DAYS} days'`,
      [token]
    );
    const user = rows[0];
    if (!user || !user.company_active) return res.status(401).json({ error: "Please log in again." });
    db.query("UPDATE client_sessions SET last_seen_at = NOW() WHERE token = $1", [token]).catch(() => {});
    req.client = { user, company: { id: user.company_id, name: user.company_name, contact_name: user.contact_name }, token };
    next();
  } catch (err) {
    console.log("CLIENT AUTH ERROR:", err.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}

// Where each of their orders is: placed → being prepared → out for delivery → delivered.
function stageOf(round, delivery) {
  if (delivery?.status === "Delivered" || round.buyer_status === "Delivered") return "Delivered";
  if (round.buyer_status === "Out for delivery" || delivery?.out_at) return "Out for delivery";
  if (round.status === "Collecting") return "Order placed";
  return "Being prepared";
}
const STAGES = ["Order placed", "Being prepared", "Out for delivery", "Delivered"];

export function registerClientPortalRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  };
  const by = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Admin");

  /* ---------- Dashboard (Direct Supply page): make and manage the logins ---------- */
  app.get("/supply/client-users", auth, handle("CLIENT USERS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.*, c.name AS company_name FROM supply_client_users u JOIN supply_companies c ON c.id = u.company_id ORDER BY c.name, u.name`
    );
    res.json(rows.map(publicLogin));
  }));

  app.post("/supply/client-users", auth, handle("CLIENT USER CREATE", async (req, res) => {
    const companyId = Number(req.body?.company_id);
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "Enter the admin's name" });
    const { rows: company } = await db.query("SELECT id, name FROM supply_companies WHERE id = $1", [companyId]);
    if (!company.length) return res.status(400).json({ error: "Choose the company" });
    const base = `${slug(company[0].name).split(".")[0] || "company"}.${slug(name).split(".")[0] || "admin"}`;
    let username = base;
    for (let n = 2; (await db.query("SELECT 1 FROM supply_client_users WHERE username = $1", [username])).rows.length; n += 1) username = `${base}${n}`;
    const password = generatePassword();
    const { rows } = await db.query(
      "INSERT INTO supply_client_users (company_id, name, username, password, phone, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [companyId, name, username, hashPassword(password), digits(req.body?.phone) || null, by(req.user)]
    );
    res.locals.activity = { section: "Direct Supply", action: `Made a shop login for ${name} (${company[0].name}): ${username}` };
    res.status(201).json({ login: { ...publicLogin(rows[0]), company_name: company[0].name }, credentials: { username, password } });
  }));

  app.patch("/supply/client-users/:id", auth, handle("CLIENT USER UPDATE", async (req, res) => {
    const sets = [];
    const values = [];
    const add = (column, value) => { values.push(value); sets.push(`${column} = $${values.length + 1}`); };
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "Name can't be empty" });
      add("name", name);
    }
    if (req.body?.phone !== undefined) add("phone", digits(req.body.phone) || null);
    if (req.body?.active !== undefined) add("active", Boolean(req.body.active));
    if (req.body?.username !== undefined) {
      const username = String(req.body.username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
      if (username.length < 3) return res.status(400).json({ error: "Username needs at least 3 letters or numbers" });
      const { rows: taken } = await db.query("SELECT 1 FROM supply_client_users WHERE username = $1 AND id <> $2", [username, req.params.id]);
      if (taken.length) return res.status(400).json({ error: "That username is already taken" });
      add("username", username);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to change" });
    const { rows } = await db.query(`UPDATE supply_client_users SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, [req.params.id, ...values]);
    if (!rows.length) return res.status(404).json({ error: "Login not found" });
    if (req.body?.active === false) await db.query("DELETE FROM client_sessions WHERE user_id = $1", [req.params.id]);
    res.json(publicLogin(rows[0]));
  }));

  app.post("/supply/client-users/:id/reset-password", auth, handle("CLIENT USER RESET", async (req, res) => {
    const password = generatePassword();
    const { rows } = await db.query("UPDATE supply_client_users SET password = $2 WHERE id = $1 RETURNING username, name", [req.params.id, hashPassword(password)]);
    if (!rows.length) return res.status(404).json({ error: "Login not found" });
    await db.query("DELETE FROM client_sessions WHERE user_id = $1", [req.params.id]);
    res.locals.activity = { section: "Direct Supply", action: `Reset the shop password for ${rows[0].name} (${rows[0].username})` };
    res.json({ credentials: { username: rows[0].username, password } });
  }));

  app.delete("/supply/client-users/:id", auth, handle("CLIENT USER DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM supply_client_users WHERE id = $1 RETURNING name, username", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Login not found" });
    res.locals.activity = { section: "Direct Supply", action: `Deleted the shop login ${rows[0].username} (${rows[0].name})` };
    res.json({ success: true });
  }));

  /* ---------- The company admin's own shop ---------- */
  app.post("/client/login", handle("CLIENT LOGIN", async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase().slice(0, 60);
    const password = String(req.body?.password || "");
    if (!username || !password) return res.status(400).json({ error: "Enter your username and password" });
    if (locked(username)) return res.status(429).json({ error: "Too many wrong tries. Please wait 15 minutes and try again." });
    const { rows } = await db.query(
      `SELECT u.*, c.name AS company_name, c.active AS company_active FROM supply_client_users u JOIN supply_companies c ON c.id = u.company_id WHERE u.username = $1`,
      [username]
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password)) {
      failures.set(username, [...(failures.get(username) || []), Date.now()]);
      return res.status(401).json({ error: "Wrong username or password" });
    }
    if (!user.active || !user.company_active) return res.status(403).json({ error: "This login is switched off. Please contact Snackit." });
    failures.delete(username);
    const token = `c-${crypto.randomBytes(24).toString("hex")}`;
    await db.query("INSERT INTO client_sessions (token, user_id) VALUES ($1, $2)", [token, user.id]);
    await db.query("UPDATE supply_client_users SET last_login_at = NOW() WHERE id = $1", [user.id]);
    console.log(`🛒 Shop login: ${user.username} (${user.company_name})`);
    res.json({ token, name: user.name, company: user.company_name });
  }));

  app.post("/client/logout", clientAuth, handle("CLIENT LOGOUT", async (req, res) => {
    await db.query("DELETE FROM client_sessions WHERE token = $1", [req.client.token]);
    res.json({ success: true });
  }));

  app.post("/client/password", clientAuth, handle("CLIENT PASSWORD", async (req, res) => {
    const { rows } = await db.query("SELECT password FROM supply_client_users WHERE id = $1", [req.client.user.id]);
    if (!verifyPassword(String(req.body?.current || ""), rows[0]?.password)) return res.status(400).json({ error: "Your current password is wrong" });
    const next = String(req.body?.next || "");
    if (next.length < 8) return res.status(400).json({ error: "The new password needs at least 8 characters" });
    await db.query("UPDATE supply_client_users SET password = $2 WHERE id = $1", [req.client.user.id, hashPassword(next)]);
    await db.query("DELETE FROM client_sessions WHERE user_id = $1 AND token <> $2", [req.client.user.id, req.client.token]);
    res.json({ success: true });
  }));

  app.get("/client/shop", clientAuth, handle("CLIENT SHOP", async (req, res) => {
    const catalog = await catalogFor(req.client.company);
    res.json({ ...catalog, me: { name: req.client.user.name, username: req.client.user.username } });
  }));

  app.post("/client/orders", clientAuth, handle("CLIENT ORDER", async (req, res) => {
    const result = await placeOrder(req.client.company, { ...req.body, name: req.client.user.name }, "shop login");
    res.status(result.status).json(result.json);
  }));

  // Their orders (every way they ordered: login, link, WhatsApp, added by Snackit), newest first.
  app.get("/client/orders", clientAuth, handle("CLIENT ORDERS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT r.id AS round_id, r.delivery_date, r.status, r.buyer_status, d.status AS delivery_status, d.out_at, d.delivered_at,
              o.submitted_by, o.created_at, o.source,
              json_agg(json_build_object('product_id', l.product_id, 'name', COALESCE(p.name, l.raw_name), 'qty', COALESCE(l.delivered_qty, l.qty), 'unit', l.unit, 'image_url', p.image_url) ORDER BY l.id) AS lines
       FROM supply_orders o
       JOIN supply_rounds r ON r.id = o.round_id
       JOIN supply_lines l ON l.order_id = o.id
       LEFT JOIN supply_products p ON p.id = l.product_id
       LEFT JOIN supply_deliveries d ON d.round_id = r.id AND d.company_id = o.company_id
       WHERE o.company_id = $1
       GROUP BY r.id, d.status, d.out_at, d.delivered_at, o.id
       ORDER BY r.delivery_date DESC, o.created_at DESC
       LIMIT 300`,
      [req.client.company.id]
    );
    // One card per delivery date (fruits and packaged together); the least advanced stage shows.
    const byDate = new Map();
    for (const row of rows) {
      const date = plainDate(row.delivery_date);
      const stage = stageOf(row, row.delivery_status ? { status: row.delivery_status, out_at: row.out_at } : null);
      const entry = byDate.get(date) || { delivery_date: date, stage, placed_at: row.created_at, placed_by: row.submitted_by, delivered_at: null, lines: [] };
      if (STAGES.indexOf(stage) < STAGES.indexOf(entry.stage)) entry.stage = stage;
      if (row.delivered_at && (!entry.delivered_at || row.delivered_at > entry.delivered_at)) entry.delivered_at = row.delivered_at;
      if (row.created_at < entry.placed_at) entry.placed_at = row.created_at;
      entry.placed_by = entry.placed_by || row.submitted_by;
      entry.lines.push(...row.lines.map((line) => ({ ...line, qty: Number(line.qty) })));
      byDate.set(date, entry);
    }
    res.json({ orders: [...byDate.values()].slice(0, 40), stages: STAGES });
  }));
}
