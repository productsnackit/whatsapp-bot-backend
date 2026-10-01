/* =========================================================
    DIRECT SUPPLY · ORDER LINK (phase 4)
    Each company can get a private link (dashboard address + "/?order=<token>"). Their admin
    opens it on a phone, picks the delivery date, types quantities next to Snackit's items
    (their usual items first, with last time's quantity), adds anything else by name, and
    submits. The order lands in that delivery date like a pasted one, marked "order link".
    Submitting again replaces their link order for that date, so they can correct it while
    the date is still collecting orders. The link can be replaced (the old one stops working)
    or switched off. No login: the token in the link is the key.
========================================================= */
import crypto from "crypto";
import { saveOrderLines } from "./directSupply.js";
import { displayName } from "./supplyParse.js";
import { sendPushToUsers } from "./pushNotifications.js";

let db = null;
let onChange = () => {};
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const todayIst = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const UNITS = ["pcs", "kg", "box", "pkt", "bottle", "l", "bunch", "tray"];

export async function ensureSupplyOrderLink(database, { onChanged } = {}) {
  db = database;
  if (onChanged) onChange = onChanged;
  await db.query(`
    ALTER TABLE supply_companies
      ADD COLUMN IF NOT EXISTS order_token TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS order_link_on BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS submitted_by TEXT, ADD COLUMN IF NOT EXISTS note TEXT;
  `);
}

async function companyByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) return null;
  const { rows } = await db.query("SELECT * FROM supply_companies WHERE order_token = $1 AND order_link_on = TRUE AND active = TRUE", [token]);
  return rows[0] || null;
}

// Delivery dates still taking orders: collecting, and today or later (India time).
async function openRounds() {
  const { rows } = await db.query(
    "SELECT id, ref, delivery_date, title FROM supply_rounds WHERE status = 'Collecting' AND delivery_date >= $1::date ORDER BY delivery_date, id",
    [todayIst()]
  );
  return rows.map((round) => ({ ...round, delivery_date: plainDate(round.delivery_date) }));
}

// A few submissions per link per hour is plenty; this stops a leaked link being hammered.
const recent = new Map();
function tooMany(token) {
  const now = Date.now();
  const list = (recent.get(token) || []).filter((time) => now - time < 3600000);
  list.push(now);
  recent.set(token, list);
  return list.length > 30;
}

export function registerSupplyOrderLinkRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  };

  /* ---------- Dashboard: make, replace or switch off a company's link ---------- */
  app.post("/supply/companies/:id/order-link", auth, handle("SUPPLY ORDER LINK", async (req, res) => {
    const { rows: found } = await db.query("SELECT id, name, order_token FROM supply_companies WHERE id = $1", [req.params.id]);
    if (!found.length) return res.status(404).json({ error: "Company not found" });
    const action = req.body?.action || "get";
    let token = found[0].order_token;
    if (!token || action === "new") token = crypto.randomBytes(18).toString("base64url");
    const on = action === "off" ? false : true;
    await db.query("UPDATE supply_companies SET order_token = $2, order_link_on = $3 WHERE id = $1", [found[0].id, token, on]);
    if (action !== "get") res.locals.activity = { section: "Direct Supply", action: `${action === "new" ? "New" : action === "off" ? "Switched off" : "Switched on"} order link for ${found[0].name}` };
    res.json({ token, on });
  }));

  /* ---------- Public: the order page ---------- */
  app.get("/public/supply/order/:token", handle("PUBLIC ORDER PAGE", async (req, res) => {
    const company = await companyByToken(req.params.token);
    if (!company) return res.status(404).json({ error: "This order link isn't valid any more. Please ask Snackit for a new one." });
    const rounds = await openRounds();
    // Items: anything priced, or ordered by anyone in the last 4 months; this company's own items first.
    const { rows: items } = await db.query(
      `SELECT p.id, p.name, p.unit, p.category,
              COALESCE(cp.price, CASE WHEN p.sell_price IS NOT NULL THEN p.sell_price END) AS price,
              mine.last_qty, mine.last_unit, mine.times
       FROM supply_products p
       LEFT JOIN supply_company_prices cp ON cp.company_id = $1 AND cp.product_id = p.id AND cp.unit = p.unit
       LEFT JOIN LATERAL (
         SELECT (ARRAY_AGG(l.qty ORDER BY l.created_at DESC))[1] AS last_qty, (ARRAY_AGG(l.unit ORDER BY l.created_at DESC))[1] AS last_unit, COUNT(*)::int AS times
         FROM supply_lines l WHERE l.company_id = $1 AND l.product_id = p.id
       ) mine ON TRUE
       WHERE p.sell_price IS NOT NULL OR cp.price IS NOT NULL
          OR EXISTS (SELECT 1 FROM supply_lines l2 WHERE l2.product_id = p.id AND l2.created_at > NOW() - INTERVAL '120 days')
       ORDER BY (mine.times IS NOT NULL AND mine.times > 0) DESC, p.category NULLS LAST, p.name`,
      [company.id]
    );
    // What they already sent through the link, per open date (so they can change it).
    const { rows: mine } = await db.query(
      `SELECT o.round_id, o.note, o.submitted_by, o.created_at, json_agg(json_build_object('product_id', l.product_id, 'name', l.raw_name, 'qty', l.qty, 'unit', l.unit) ORDER BY l.id) AS lines
       FROM supply_orders o JOIN supply_lines l ON l.order_id = o.id
       WHERE o.company_id = $1 AND o.source = 'link' AND o.round_id = ANY($2) GROUP BY o.id`,
      [company.id, rounds.map((round) => round.id)]
    );
    const { rows: seller } = await db.query("SELECT value FROM app_settings WHERE key = 'supply_seller'").catch(() => ({ rows: [] }));
    let sellerName = "Snackit";
    try { sellerName = JSON.parse(seller[0]?.value || "{}").name || "Snackit"; } catch { /* default name */ }
    res.json({
      company: { name: company.name, contact_name: company.contact_name },
      seller: sellerName,
      rounds,
      items: items.map((item) => ({ ...item, price: item.price == null ? null : Number(item.price), last_qty: item.last_qty == null ? null : Number(item.last_qty), usual: Number(item.times) > 0 })),
      units: UNITS,
      sent: Object.fromEntries(mine.map((order) => [order.round_id, { note: order.note, submitted_by: order.submitted_by, at: order.created_at, lines: order.lines.map((line) => ({ ...line, qty: Number(line.qty) })) }])),
    });
  }));

  app.post("/public/supply/order/:token", handle("PUBLIC ORDER SUBMIT", async (req, res) => {
    const company = await companyByToken(req.params.token);
    if (!company) return res.status(404).json({ error: "This order link isn't valid any more. Please ask Snackit for a new one." });
    if (tooMany(req.params.token)) return res.status(429).json({ error: "Too many submissions. Please wait a while and try again." });
    const roundId = Number(req.body?.round_id);
    const round = (await openRounds()).find((item) => item.id === roundId);
    if (!round) return res.status(400).json({ error: "That delivery date is no longer taking orders. Please refresh the page." });
    const { rows: known } = await db.query("SELECT id, name, unit FROM supply_products");
    const byId = new Map(known.map((item) => [item.id, item]));
    const lines = [];
    for (const raw of (Array.isArray(req.body?.lines) ? req.body.lines : []).slice(0, 200)) {
      const amount = Number(raw.qty);
      if (!(amount > 0) || amount > 100000) continue;
      const unit = UNITS.includes(raw.unit) ? raw.unit : null;
      const item = raw.product_id ? byId.get(Number(raw.product_id)) : null;
      if (item) lines.push({ product_id: item.id, name: item.name, qty: amount, unit: unit || item.unit });
      else if (String(raw.name || "").trim()) lines.push({ name: displayName(String(raw.name).slice(0, 120)), qty: amount, unit: unit || "pcs" });
    }
    if (!lines.length) return res.status(400).json({ error: "Add a quantity for at least one item." });
    const submittedBy = String(req.body?.name || "").trim().slice(0, 80) || null;
    const note = String(req.body?.note || "").trim().slice(0, 500) || null;
    // A new submission for the same date replaces their earlier link order.
    const { rows: previous } = await db.query("DELETE FROM supply_orders WHERE company_id = $1 AND round_id = $2 AND source = 'link' RETURNING id", [company.id, round.id]);
    const { rows: order } = await db.query(
      "INSERT INTO supply_orders (round_id, company_id, source, raw_text, submitted_by, note, created_by) VALUES ($1, $2, 'link', $3, $4, $5, $6) RETURNING id",
      [round.id, company.id, note, submittedBy, note, `${submittedBy || company.name} (order link)`]
    );
    await saveOrderLines(order[0].id, round.id, company.id, lines);
    onChange();
    sendPushToUsers(db, ["admin"], {
      title: `${previous.length ? "Order updated" : "New order"} · ${company.name}`,
      body: `${lines.length} item${lines.length === 1 ? "" : "s"} for ${round.ref} (${round.delivery_date})${submittedBy ? ` from ${submittedBy}` : ""}`,
      view: "supply",
    }).catch(() => {});
    console.log(`🛒 Order link: ${company.name} ${previous.length ? "updated" : "sent"} ${lines.length} items for ${round.ref}`);
    res.status(201).json({ success: true, updated: previous.length > 0, round, items: lines.length });
  }));
}
