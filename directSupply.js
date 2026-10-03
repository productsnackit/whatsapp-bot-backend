/* =========================================================
    DIRECT SUPPLY (orders → master sheet → buying → margin)
    Snackit supplies snacks, drinks and fruit straight to companies. Company admins
    send their orders on WhatsApp (text or Excel); each order is pasted or uploaded
    here against a supply round (one delivery date). The master sheet combines every
    company's order: the same item (after cleaning the name, or confirmed "same item")
    is added up, with a column per company. The stock buyer gets it on WhatsApp as a
    summary and an Excel file, or downloads it.
    Phase 2: vendors and their rates (every rate is kept with its date, so fruit prices can
    be followed), the cheapest current rate per item, purchases (what was really bought, from
    whom, at what price), selling prices (a default per item, or per company) and the margin.
    An item can have "pieces per box", so "2 box" from one company adds to pieces from another.
    Items the system isn't sure about ("Lays Clasic 52g" vs "Lays Classic 52g") are
    listed under "Check names" until someone says same item / new item; the answer is
    remembered for next time.
========================================================= */
import XLSX from "xlsx";
import { parseText, parseRows, parseOrderMessage, cleanName, displayName, matchName, normaliseUnit, UNITS } from "./supplyParse.js";

let db = null;
const userName = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee");
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const dayLabel = (date) => new Date(`${plainDate(date)}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const qtyText = (qty) => String(Math.round(Number(qty) * 1000) / 1000);

export async function ensureDirectSupply(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS supply_companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      contact_name TEXT,
      contact_phone TEXT,
      location TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'pcs',
      category TEXT,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_rounds (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE,
      delivery_date DATE NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'Collecting',
      notes TEXT,
      created_by TEXT,
      sent_at TIMESTAMPTZ,
      sent_to TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_orders (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES supply_rounds(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id),
      source TEXT NOT NULL DEFAULT 'text',
      raw_text TEXT,
      file_name TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_lines (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
      round_id INTEGER NOT NULL REFERENCES supply_rounds(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id),
      raw_name TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs',
      product_id INTEGER REFERENCES supply_products(id) ON DELETE SET NULL,
      suggestion_id INTEGER REFERENCES supply_products(id) ON DELETE SET NULL,
      problem TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS supply_lines_round_idx ON supply_lines (round_id);
    ALTER TABLE supply_products
      ADD COLUMN IF NOT EXISTS pack_size NUMERIC,
      ADD COLUMN IF NOT EXISTS sell_price NUMERIC;
    CREATE TABLE IF NOT EXISTS supply_vendors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      contact_name TEXT,
      phone TEXT,
      location TEXT,
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_prices (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES supply_products(id) ON DELETE CASCADE,
      vendor_id INTEGER NOT NULL REFERENCES supply_vendors(id) ON DELETE CASCADE,
      unit TEXT NOT NULL,
      price NUMERIC NOT NULL,
      round_id INTEGER REFERENCES supply_rounds(id) ON DELETE SET NULL,
      recorded_by TEXT,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS supply_prices_item_idx ON supply_prices (product_id, unit, recorded_at DESC);
    CREATE TABLE IF NOT EXISTS supply_purchases (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES supply_rounds(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES supply_products(id) ON DELETE SET NULL,
      vendor_id INTEGER REFERENCES supply_vendors(id) ON DELETE SET NULL,
      unit TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      notes TEXT,
      bought_by TEXT,
      bought_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_company_prices (
      company_id INTEGER NOT NULL REFERENCES supply_companies(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES supply_products(id) ON DELETE CASCADE,
      unit TEXT NOT NULL,
      price NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (company_id, product_id, unit)
    );
  `);
}

async function products() {
  const { rows } = await db.query("SELECT id, name, key, unit, category, aliases, pack_size, sell_price, hsn FROM supply_products ORDER BY name");
  return rows;
}

// A new item from an order line (its cleaned name is the key).
async function createProduct(name, unit) {
  const key = cleanName(name);
  const { rows } = await db.query(
    `INSERT INTO supply_products (name, key, unit) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
    [displayName(name), key, unit || "pcs"]
  );
  return rows[0].id;
}

// Reads one order: lines from pasted text or an Excel/CSV file ({ name, data: base64 }).
export function readOrder({ text, file }) {
  if (file?.data) {
    const buffer = Buffer.from(String(file.data).replace(/^data:[^,]+,/, ""), "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const lines = [];
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
      lines.push(...parseRows(rows));
    }
    return lines;
  }
  return parseText(text);
}

// Each line with what it matches: a known item, a likely one ("same item?") or a new item.
async function withMatches(lines) {
  const known = await products();
  const byId = new Map(known.map((product) => [product.id, product]));
  return lines.map((line) => {
    const match = matchName(line.name, known);
    return {
      ...line,
      product_id: match.product_id || null,
      product_name: match.product_id ? byId.get(match.product_id)?.name : null,
      suggestion_id: match.suggestion_id || null,
      suggestion_name: match.suggestion_id ? byId.get(match.suggestion_id)?.name : null,
    };
  });
}

/* The master sheet: every line of the round, combined by item and unit.
   Lines still waiting for "same item?" are combined under their own name and marked. */
export async function masterOf(roundId) {
  const { rows: lines } = await db.query(
    `SELECT l.*, p.name AS product_name, p.category, p.unit AS product_unit, p.pack_size, s.name AS suggestion_name, c.name AS company_name
     FROM supply_lines l
     JOIN supply_companies c ON c.id = l.company_id
     LEFT JOIN supply_products p ON p.id = l.product_id
     LEFT JOIN supply_products s ON s.id = l.suggestion_id
     WHERE l.round_id = $1 ORDER BY l.id`,
    [roundId]
  );
  const companies = [...new Map(lines.map((line) => [line.company_id, { id: line.company_id, name: line.company_name }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = new Map();
  for (const line of lines) {
    // "2 box" of an item with pieces per box set (and counted in pieces) adds to the pieces.
    const perBox = Number(line.pack_size) || 0;
    const boxed = line.unit === "box" && perBox > 0 && line.product_unit && line.product_unit !== "box";
    const unit = boxed ? line.product_unit : line.unit;
    const amount = boxed ? Number(line.qty) * perBox : Number(line.qty);
    const itemKey = line.product_id ? `p${line.product_id}` : `n${cleanName(line.raw_name)}`;
    const key = `${itemKey}|${unit}`;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        product_id: line.product_id,
        name: line.product_name || displayName(line.raw_name),
        category: line.category || "",
        unit,
        total: 0,
        from_boxes: 0,
        by_company: {},
        to_check: false,
        spellings: new Set(),
      });
    }
    const row = rows.get(key);
    row.total += amount;
    if (boxed) row.from_boxes += Number(line.qty);
    row.by_company[line.company_id] = (row.by_company[line.company_id] || 0) + amount;
    row.spellings.add(line.raw_name);
    if (!line.product_id) row.to_check = true;
  }
  const master = [...rows.values()]
    .map(({ spellings, ...row }) => ({ ...row, total: Number(qtyText(row.total)), spellings: [...spellings] }))
    .sort((a, b) => (a.category || "~").localeCompare(b.category || "~") || a.name.localeCompare(b.name));
  const checks = lines.filter((line) => !line.product_id).map((line) => ({
    id: line.id, raw_name: line.raw_name, qty: Number(line.qty), unit: line.unit, company_name: line.company_name,
    suggestion_id: line.suggestion_id, suggestion_name: line.suggestion_name,
  }));
  const problems = lines.filter((line) => line.problem || Number(line.qty) <= 0).map((line) => ({ id: line.id, raw_name: line.raw_name, company_name: line.company_name, problem: line.problem || "Quantity missing" }));
  return { companies, master, checks, problems, line_count: lines.length };
}

/* Buying for a round, per master-sheet item: the latest rate from each vendor (cheapest first),
   what was bought, what is still short, the selling value (company price, else the item's
   default price) and the margin. Cost is what was spent, plus the best rate for anything short. */
export async function buyingOf(roundId, sheet) {
  const ids = sheet.master.filter((row) => row.product_id).map((row) => row.product_id);
  const [quotes, purchases, companyPrices, items] = await Promise.all([
    db.query(
      `SELECT DISTINCT ON (q.product_id, q.unit, q.vendor_id) q.product_id, q.unit, q.vendor_id, q.price, q.recorded_at, v.name AS vendor_name
       FROM supply_prices q JOIN supply_vendors v ON v.id = q.vendor_id
       WHERE q.product_id = ANY($1) ORDER BY q.product_id, q.unit, q.vendor_id, q.recorded_at DESC`,
      [ids]
    ),
    db.query(
      `SELECT pu.*, v.name AS vendor_name FROM supply_purchases pu LEFT JOIN supply_vendors v ON v.id = pu.vendor_id
       WHERE pu.round_id = $1 ORDER BY pu.bought_at`,
      [roundId]
    ),
    db.query("SELECT * FROM supply_company_prices WHERE product_id = ANY($1)", [ids]),
    db.query("SELECT id, unit, sell_price FROM supply_products WHERE id = ANY($1)", [ids]),
  ]);
  const itemById = new Map(items.rows.map((item) => [item.id, item]));
  const totals = { estimate: 0, spent: 0, cost: 0, selling: 0, priced_items: 0, items: 0, missing_rates: 0, missing_prices: 0, short_items: 0 };
  const rows = sheet.master.map((row) => {
    const rates = quotes.rows.filter((quote) => quote.product_id === row.product_id && quote.unit === row.unit)
      .map((quote) => ({ vendor_id: quote.vendor_id, vendor_name: quote.vendor_name, price: Number(quote.price), recorded_at: quote.recorded_at }))
      .sort((a, b) => a.price - b.price);
    const bought = purchases.rows.filter((item) => item.product_id === row.product_id && item.unit === row.unit)
      .map((item) => ({ id: item.id, vendor_id: item.vendor_id, vendor_name: item.vendor_name, qty: Number(item.qty), price: Number(item.price), bought_by: item.bought_by, bought_at: item.bought_at, notes: item.notes }));
    const boughtQty = bought.reduce((sum, item) => sum + item.qty, 0);
    const spent = bought.reduce((sum, item) => sum + item.qty * item.price, 0);
    const best = rates[0] || null;
    const short = Math.max(0, row.total - boughtQty);
    const estimate = best ? row.total * best.price : null;
    const cost = spent + (short > 0 && best ? short * best.price : 0);
    const item = itemById.get(row.product_id);
    let selling = 0;
    let pricedAll = row.product_id != null;
    for (const [companyId, amount] of Object.entries(row.by_company)) {
      const special = companyPrices.rows.find((price) => price.company_id === Number(companyId) && price.product_id === row.product_id && price.unit === row.unit);
      const price = special ? Number(special.price) : item && item.unit === row.unit && item.sell_price != null ? Number(item.sell_price) : null;
      if (price == null) pricedAll = false;
      else selling += amount * price;
    }
    const costKnown = boughtQty > 0 || best != null;
    totals.items += 1;
    if (estimate != null) totals.estimate += estimate;
    totals.spent += spent;
    if (costKnown) totals.cost += cost;
    if (pricedAll) { totals.selling += selling; totals.priced_items += 1; }
    if (!best && !boughtQty) totals.missing_rates += 1;
    if (!pricedAll) totals.missing_prices += 1;
    if (short > 0 && row.total > 0) totals.short_items += 1;
    return {
      key: row.key, product_id: row.product_id, name: row.name, unit: row.unit, need: row.total,
      rates, best, estimate, bought, bought_qty: Number(qtyText(boughtQty)), spent, short: Number(qtyText(short)),
      cost: costKnown ? cost : null, selling: pricedAll ? selling : null,
      margin: pricedAll && costKnown ? selling - cost : null,
    };
  });
  const comparable = rows.filter((row) => row.margin != null);
  totals.margin = comparable.reduce((sum, row) => sum + row.margin, 0);
  totals.margin_selling = comparable.reduce((sum, row) => sum + row.selling, 0);
  totals.margin_percent = totals.margin_selling ? Math.round((totals.margin / totals.margin_selling) * 1000) / 10 : null;
  return { rows, totals };
}

export function masterWorkbook(round, sheet, buying = null) {
  const bestOf = (row) => buying?.rows.find((item) => item.key === row.key)?.best || null;
  const header = ["Item", "Unit", "Total", ...sheet.companies.map((company) => company.name), "Best rate (₹)", "Vendor"];
  const rows = sheet.master.map((row) => [
    row.name + (row.to_check ? " (check name)" : ""), row.unit, row.total,
    ...sheet.companies.map((company) => (row.by_company[company.id] ? Number(qtyText(row.by_company[company.id])) : "")),
    bestOf(row)?.price ?? "", bestOf(row)?.vendor_name ?? "",
  ]);
  const title = `Snackit Direct Supply · ${round.ref} · Delivery ${dayLabel(round.delivery_date)}${round.title ? ` · ${round.title}` : ""}`;
  const worksheet = XLSX.utils.aoa_to_sheet([[title], [], header, ...rows]);
  worksheet["!cols"] = [{ wch: 36 }, { wch: 8 }, { wch: 9 }, ...sheet.companies.map(() => ({ wch: 16 })), { wch: 12 }, { wch: 20 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Master sheet");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/* Saves an order's lines. A line with product_id (picked from the item list) is that item; a
   typed name is matched like a pasted order, and a name nobody has seen (not close to a known
   item) becomes a new item, so the same spelling from another company combines straight away. */
export async function saveOrderLines(orderId, roundId, companyId, lines) {
  let created = 0;
  const typed = await withMatches(lines.filter((line) => !line.product_id));
  const picked = lines.filter((line) => line.product_id).map((line) => ({ ...line, suggestion_id: null }));
  for (const line of [...picked, ...typed]) {
    let productId = line.product_id;
    if (!productId && !line.suggestion_id) {
      productId = await createProduct(line.name, line.unit);
      created += 1;
    }
    await db.query(
      `INSERT INTO supply_lines (order_id, round_id, company_id, raw_name, qty, unit, product_id, suggestion_id, problem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orderId, roundId, companyId, line.name, line.qty, line.unit, productId, productId ? null : line.suggestion_id, line.qty > 0 ? null : "Quantity missing"]
    );
  }
  await db.query("UPDATE supply_rounds SET updated_at = NOW() WHERE id = $1", [roundId]);
  return created;
}

export async function roundById(id) {
  const { rows } = await db.query("SELECT * FROM supply_rounds WHERE id = $1", [id]);
  return rows[0] ? { ...rows[0], delivery_date: plainDate(rows[0].delivery_date) } : null;
}

export function registerDirectSupplyRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: err.message?.startsWith("Unsupported file") ? "That file couldn't be read. Upload an Excel (.xlsx/.xls) or CSV file." : "Server error" });
    }
  };

  // Everything the page needs to start: companies, items and the supply rounds.
  app.get("/supply/overview", auth, handle("SUPPLY OVERVIEW", async (req, res) => {
    const [companies, items, rounds, vendors] = await Promise.all([
      db.query("SELECT * FROM supply_companies ORDER BY active DESC, name"),
      products(),
      db.query(`SELECT r.*, COUNT(DISTINCT o.company_id)::int AS company_count, COUNT(l.id)::int AS line_count
                FROM supply_rounds r LEFT JOIN supply_orders o ON o.round_id = r.id LEFT JOIN supply_lines l ON l.order_id = o.id
                GROUP BY r.id ORDER BY r.delivery_date DESC, r.id DESC LIMIT 200`),
      db.query("SELECT * FROM supply_vendors ORDER BY active DESC, name"),
    ]);
    const { rows: buyer } = await db.query("SELECT value FROM app_settings WHERE key = 'supply_buyer_id'").catch(() => ({ rows: [] }));
    res.json({
      companies: companies.rows,
      vendors: vendors.rows,
      products: items.map((item) => ({ ...item, pack_size: item.pack_size == null ? null : Number(item.pack_size), sell_price: item.sell_price == null ? null : Number(item.sell_price) })),
      rounds: rounds.rows.map((round) => ({ ...round, delivery_date: plainDate(round.delivery_date) })),
      units: UNITS,
      buyer_id: buyer[0]?.value || null,
    });
  }));

  // Who buys the stock: gets the master sheet, and orders that arrive on WhatsApp are forwarded to them.
  app.put("/supply/buyer", auth, handle("SUPPLY BUYER", async (req, res) => {
    const buyer = (global.internalUsers || []).find((user) => String(user.id) === String(req.body?.buyer_id));
    if (!buyer) return res.status(400).json({ error: "Choose who buys the stock" });
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_buyer_id', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(buyer.id)]
    );
    res.json({ success: true });
  }));

  /* ---------- Companies ---------- */
  app.post("/supply/companies", auth, handle("SUPPLY COMPANY", async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "Company name is required" });
    const { rows } = await db.query(
      `INSERT INTO supply_companies (name, contact_name, contact_phone, location) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [name, req.body?.contact_name || null, req.body?.contact_phone || null, req.body?.location || null]
    );
    if (!rows.length) return res.status(400).json({ error: `${name} is already in the list` });
    res.locals.activity = { section: "Direct Supply", action: `Added company ${name}` };
    res.status(201).json(rows[0]);
  }));

  app.patch("/supply/companies/:id", auth, handle("SUPPLY COMPANY UPDATE", async (req, res) => {
    const fields = ["name", "contact_name", "contact_phone", "location", "active", "billing_name", "address", "gstin", "payment_days", "contact_no", "state", "ship_to"].filter((key) => req.body?.[key] !== undefined);
    if (fields.includes("payment_days")) req.body.payment_days = req.body.payment_days === "" || req.body.payment_days == null ? null : Math.max(0, Math.round(Number(req.body.payment_days)) || 0);
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    const { rows } = await db.query(
      `UPDATE supply_companies SET ${fields.map((key, index) => `${key} = $${index + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [req.params.id, ...fields.map((key) => req.body[key])]
    );
    if (!rows.length) return res.status(404).json({ error: "Company not found" });
    res.json(rows[0]);
  }));

  /* ---------- Supply rounds (one per delivery date) ---------- */
  app.post("/supply/rounds", auth, handle("SUPPLY ROUND", async (req, res) => {
    const date = String(req.body?.delivery_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Choose the delivery date" });
    const { rows } = await db.query(
      "INSERT INTO supply_rounds (delivery_date, title, created_by) VALUES ($1, $2, $3) RETURNING id",
      [date, String(req.body?.title || "").trim().slice(0, 120) || null, userName(req.user)]
    );
    await db.query("UPDATE supply_rounds SET ref = 'DS-' || LPAD(id::text, 4, '0') WHERE id = $1", [rows[0].id]);
    res.locals.activity = { section: "Direct Supply", action: `Started supply round for ${dayLabel(date)}` };
    res.status(201).json(await roundById(rows[0].id));
  }));

  app.patch("/supply/rounds/:id", auth, handle("SUPPLY ROUND UPDATE", async (req, res) => {
    const fields = ["title", "status", "notes", "delivery_date"].filter((key) => req.body?.[key] !== undefined);
    if (req.body?.status && !["Collecting", "Sent to buyer", "Bought", "Delivered"].includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    await db.query(
      `UPDATE supply_rounds SET ${fields.map((key, index) => `${key} = $${index + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`,
      [req.params.id, ...fields.map((key) => req.body[key] || null)]
    );
    res.json(await roundById(req.params.id));
  }));

  app.delete("/supply/rounds/:id", auth, handle("SUPPLY ROUND DELETE", async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only an admin can delete a supply round" });
    const { rows } = await db.query("DELETE FROM supply_rounds WHERE id = $1 RETURNING ref", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.locals.activity = { section: "Direct Supply", action: `Deleted supply round ${rows[0].ref}` };
    res.json({ success: true });
  }));

  // A round with its orders, the master sheet and the names to check.
  app.get("/supply/rounds/:id", auth, handle("SUPPLY ROUND READ", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const { rows: orders } = await db.query(
      `SELECT o.*, c.name AS company_name,
         COALESCE(json_agg(json_build_object('id', l.id, 'raw_name', l.raw_name, 'qty', l.qty, 'unit', l.unit, 'product_id', l.product_id,
           'suggestion_id', l.suggestion_id, 'problem', l.problem) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM supply_orders o JOIN supply_companies c ON c.id = o.company_id LEFT JOIN supply_lines l ON l.order_id = o.id
       WHERE o.round_id = $1 GROUP BY o.id, c.name ORDER BY c.name, o.id`,
      [round.id]
    );
    const sheet = await masterOf(round.id);
    res.json({ round, orders, ...sheet, buying: await buyingOf(round.id, sheet) });
  }));

  /* ---------- Orders ---------- */
  /* Preview: what was read from the text or file, and what each line matches. Nothing is saved.
     A pasted message can hold several companies ("AERO / - Apple 6 kg / CRED One / …"): each
     becomes a group, matched to a saved company by name. The date and title are read too. */
  app.post("/supply/parse", auth, handle("SUPPLY PARSE", async (req, res) => {
    const empty = "No items found. Paste one item per line (e.g. \"Lays Classic 52g - 20\") or upload the Excel sheet.";
    if (req.body?.file?.data) {
      const lines = readOrder({ file: req.body.file });
      if (!lines.length) return res.status(400).json({ error: empty });
      const matched = await withMatches(lines);
      return res.json({ lines: matched, groups: [{ heading: null, company_id: null, lines: matched }], date: null, title: null });
    }
    const message = parseOrderMessage(req.body?.text);
    if (!message.groups.length) return res.status(400).json({ error: empty });
    const { rows: companies } = await db.query("SELECT id, name FROM supply_companies");
    const key = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const groups = [];
    for (const group of message.groups) {
      const company = group.heading ? companies.find((item) => key(item.name) === key(group.heading)) : null;
      groups.push({ heading: group.heading ? group.heading.trim() : null, company_id: company?.id || null, company_name: company?.name || null, lines: await withMatches(group.lines) });
    }
    res.json({ lines: groups.flatMap((group) => group.lines), groups, date: message.date, title: message.title });
  }));

  // Saves one company's order (the previewed lines, possibly edited).
  app.post("/supply/rounds/:id/orders", auth, handle("SUPPLY ORDER", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Supply round not found" });
    const companyId = Number(req.body?.company_id);
    const { rows: company } = await db.query("SELECT id, name FROM supply_companies WHERE id = $1", [companyId]);
    if (!company.length) return res.status(400).json({ error: "Choose the company" });
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
      .map((line) => ({ name: displayName(line.name), qty: Number(line.qty) || 0, unit: UNITS.includes(line.unit) ? line.unit : normaliseUnit(line.unit, 1).unit }))
      .filter((line) => line.name);
    if (!lines.length) return res.status(400).json({ error: "The order has no items" });
    const { rows: order } = await db.query(
      "INSERT INTO supply_orders (round_id, company_id, source, raw_text, file_name, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [round.id, companyId, req.body?.source === "file" ? "file" : "text", String(req.body?.raw_text || "").slice(0, 20000) || null, req.body?.file_name || null, userName(req.user)]
    );
    const created = await saveOrderLines(order[0].id, round.id, companyId, lines);
    res.locals.activity = { section: "Direct Supply", action: `Added ${company[0].name}'s order (${lines.length} items) to ${round.ref}` };
    res.status(201).json({ order_id: order[0].id, new_items: created });
  }));

  app.delete("/supply/orders/:id", auth, handle("SUPPLY ORDER DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM supply_orders WHERE id = $1 RETURNING round_id", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  }));

  app.patch("/supply/lines/:id", auth, handle("SUPPLY LINE", async (req, res) => {
    const qty = req.body?.qty !== undefined ? Number(req.body.qty) : undefined;
    if (qty !== undefined && !(qty >= 0)) return res.status(400).json({ error: "Enter a quantity" });
    const unit = req.body?.unit !== undefined ? (UNITS.includes(req.body.unit) ? req.body.unit : null) : undefined;
    if (unit === null) return res.status(400).json({ error: "Choose a unit" });
    await db.query(
      `UPDATE supply_lines SET qty = COALESCE($2, qty), unit = COALESCE($3, unit),
         problem = CASE WHEN COALESCE($2, qty) > 0 THEN NULL ELSE 'Quantity missing' END WHERE id = $1`,
      [req.params.id, qty ?? null, unit ?? null]
    );
    res.json({ success: true });
  }));

  app.delete("/supply/lines/:id", auth, handle("SUPPLY LINE DELETE", async (req, res) => {
    await db.query("DELETE FROM supply_lines WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  }));

  /* "Check names": a line is the same as a known item ({ product_id }: its spelling is
     remembered for next time) or a new item ({ new: true }). Every line in the round with
     the same spelling is settled at once. */
  app.post("/supply/lines/:id/resolve", auth, handle("SUPPLY RESOLVE", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM supply_lines WHERE id = $1", [req.params.id]);
    const line = rows[0];
    if (!line) return res.status(404).json({ error: "Not found" });
    const key = cleanName(line.raw_name);
    let productId = Number(req.body?.product_id) || null;
    if (req.body?.new) productId = await createProduct(line.raw_name, line.unit);
    else if (productId) {
      await db.query("UPDATE supply_products SET aliases = array_append(aliases, $2) WHERE id = $1 AND NOT ($2 = ANY(aliases)) AND key <> $2", [productId, key]);
    } else return res.status(400).json({ error: "Choose the item, or mark it as a new item" });
    const { rows: same } = await db.query("SELECT id, raw_name FROM supply_lines WHERE round_id = $1 AND product_id IS NULL", [line.round_id]);
    const ids = same.filter((item) => cleanName(item.raw_name) === key).map((item) => item.id);
    await db.query("UPDATE supply_lines SET product_id = $2, suggestion_id = NULL WHERE id = ANY($1)", [ids, productId]);
    res.json({ success: true, settled: ids.length });
  }));

  /* ---------- Items ---------- */
  app.patch("/supply/products/:id", auth, handle("SUPPLY PRODUCT", async (req, res) => {
    const fields = ["name", "unit", "category", "pack_size", "sell_price", "hsn"].filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    for (const key of ["pack_size", "sell_price"]) {
      if (fields.includes(key) && req.body[key] !== "" && req.body[key] !== null && !(Number(req.body[key]) >= 0)) return res.status(400).json({ error: "Enter a number" });
    }
    const values = fields.map((key) => (key === "name" ? displayName(req.body.name)
      : ["pack_size", "sell_price"].includes(key) ? (req.body[key] === "" || req.body[key] === null ? null : Number(req.body[key]))
        : String(req.body[key] || "").trim() || null));
    const { rows } = await db.query(
      `UPDATE supply_products SET ${fields.map((key, index) => `${key} = $${index + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  }));

  // Two items that are really one: every order line and spelling moves to the item kept.
  app.post("/supply/products/merge", auth, handle("SUPPLY MERGE", async (req, res) => {
    const from = Number(req.body?.from_id);
    const into = Number(req.body?.into_id);
    if (!from || !into || from === into) return res.status(400).json({ error: "Choose two different items" });
    const { rows } = await db.query("SELECT * FROM supply_products WHERE id = ANY($1)", [[from, into]]);
    const old = rows.find((row) => row.id === from);
    if (!old || !rows.find((row) => row.id === into)) return res.status(404).json({ error: "Item not found" });
    await db.query("UPDATE supply_lines SET product_id = $2 WHERE product_id = $1", [from, into]);
    await db.query("UPDATE supply_lines SET suggestion_id = $2 WHERE suggestion_id = $1", [from, into]);
    await db.query(
      "UPDATE supply_products SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))) WHERE id = $1",
      [into, [old.key, ...(old.aliases || [])]]
    );
    await db.query("DELETE FROM supply_products WHERE id = $1", [from]);
    res.locals.activity = { section: "Direct Supply", action: `Merged item "${old.name}" into another` };
    res.json({ success: true });
  }));

  /* ---------- Vendors, rates, purchases, selling prices (phase 2) ---------- */
  app.get("/supply/vendors", auth, handle("SUPPLY VENDORS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT v.*, COUNT(DISTINCT q.product_id)::int AS rated_items, MAX(q.recorded_at) AS last_rate_at
       FROM supply_vendors v LEFT JOIN supply_prices q ON q.vendor_id = v.id GROUP BY v.id ORDER BY v.active DESC, v.name`
    );
    res.json(rows);
  }));

  app.post("/supply/vendors", auth, handle("SUPPLY VENDOR", async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "Vendor name is required" });
    const { rows } = await db.query(
      "INSERT INTO supply_vendors (name, contact_name, phone, location, notes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING RETURNING *",
      [name, req.body?.contact_name || null, req.body?.phone || null, req.body?.location || null, req.body?.notes || null]
    );
    if (!rows.length) return res.status(400).json({ error: `${name} is already in the list` });
    res.locals.activity = { section: "Direct Supply", action: `Added vendor ${name}` };
    res.status(201).json(rows[0]);
  }));

  app.patch("/supply/vendors/:id", auth, handle("SUPPLY VENDOR UPDATE", async (req, res) => {
    const fields = ["name", "contact_name", "phone", "location", "notes", "active"].filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    const { rows } = await db.query(
      `UPDATE supply_vendors SET ${fields.map((key, index) => `${key} = $${index + 2}`).join(", ")} WHERE id = $1 RETURNING *`,
      [req.params.id, ...fields.map((key) => req.body[key])]
    );
    if (!rows.length) return res.status(404).json({ error: "Vendor not found" });
    res.json(rows[0]);
  }));

  // A vendor's rate for an item (per unit). Every rate is kept, so the history shows price changes.
  app.post("/supply/prices", auth, handle("SUPPLY RATE", async (req, res) => {
    const price = Number(req.body?.price);
    if (!(price >= 0) || req.body?.price === "" || req.body?.price == null) return res.status(400).json({ error: "Enter the rate" });
    if (!req.body?.product_id || !req.body?.vendor_id) return res.status(400).json({ error: "Choose the item and the vendor" });
    const unit = UNITS.includes(req.body?.unit) ? req.body.unit : "pcs";
    await db.query(
      "INSERT INTO supply_prices (product_id, vendor_id, unit, price, round_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.body.product_id, req.body.vendor_id, unit, price, req.body?.round_id || null, userName(req.user)]
    );
    res.status(201).json({ success: true });
  }));

  app.get("/supply/products/:id/prices", auth, handle("SUPPLY RATE HISTORY", async (req, res) => {
    const { rows } = await db.query(
      `SELECT q.id, q.unit, q.price, q.recorded_at, q.recorded_by, v.name AS vendor_name
       FROM supply_prices q JOIN supply_vendors v ON v.id = q.vendor_id WHERE q.product_id = $1 ORDER BY q.recorded_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows.map((row) => ({ ...row, price: Number(row.price) })));
  }));

  // What was really bought for a round. The price paid also goes into the vendor's rates.
  app.post("/supply/rounds/:id/purchases", auth, handle("SUPPLY PURCHASE", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const qty = Number(req.body?.qty);
    const price = Number(req.body?.price);
    if (!(qty > 0)) return res.status(400).json({ error: "Enter the quantity bought" });
    if (!(price >= 0) || req.body?.price === "" || req.body?.price == null) return res.status(400).json({ error: "Enter the price paid per unit" });
    if (!req.body?.product_id || !req.body?.vendor_id) return res.status(400).json({ error: "Choose the item and the vendor" });
    const unit = UNITS.includes(req.body?.unit) ? req.body.unit : "pcs";
    const by = userName(req.user);
    await db.query(
      "INSERT INTO supply_purchases (round_id, product_id, vendor_id, unit, qty, price, notes, bought_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [round.id, req.body.product_id, req.body.vendor_id, unit, qty, price, String(req.body?.notes || "").slice(0, 300) || null, by]
    );
    await db.query(
      "INSERT INTO supply_prices (product_id, vendor_id, unit, price, round_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.body.product_id, req.body.vendor_id, unit, price, round.id, by]
    );
    await db.query("UPDATE supply_rounds SET updated_at = NOW() WHERE id = $1", [round.id]);
    res.locals.activity = { section: "Direct Supply", action: `Recorded purchase for ${round.ref}: ${qty} ${unit} at ₹${price}` };
    res.status(201).json({ success: true });
  }));

  app.delete("/supply/purchases/:id", auth, handle("SUPPLY PURCHASE DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM supply_purchases WHERE id = $1 RETURNING id", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  }));

  // Selling prices: each item's default, and any company that pays differently.
  app.get("/supply/selling-prices", auth, handle("SUPPLY SELLING", async (req, res) => {
    const [items, special] = await Promise.all([
      db.query("SELECT id, name, unit, category, sell_price FROM supply_products ORDER BY category NULLS LAST, name"),
      db.query("SELECT company_id, product_id, unit, price FROM supply_company_prices"),
    ]);
    res.json({ items: items.rows.map((item) => ({ ...item, sell_price: item.sell_price == null ? null : Number(item.sell_price) })), company_prices: special.rows.map((row) => ({ ...row, price: Number(row.price) })) });
  }));

  app.put("/supply/company-prices", auth, handle("SUPPLY COMPANY PRICE", async (req, res) => {
    const { company_id: companyId, product_id: productId } = req.body || {};
    const unit = UNITS.includes(req.body?.unit) ? req.body.unit : "pcs";
    if (!companyId || !productId) return res.status(400).json({ error: "Choose the company and item" });
    if (req.body?.price === "" || req.body?.price == null) {
      await db.query("DELETE FROM supply_company_prices WHERE company_id = $1 AND product_id = $2 AND unit = $3", [companyId, productId, unit]);
      return res.json({ success: true });
    }
    const price = Number(req.body.price);
    if (!(price >= 0)) return res.status(400).json({ error: "Enter a number" });
    await db.query(
      `INSERT INTO supply_company_prices (company_id, product_id, unit, price) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, product_id, unit) DO UPDATE SET price = EXCLUDED.price, updated_at = NOW()`,
      [companyId, productId, unit, price]
    );
    res.json({ success: true });
  }));

  /* ---------- Master sheet out ---------- */
  app.get("/supply/rounds/:id/master.xlsx", auth, handle("SUPPLY EXCEL", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const sheet = await masterOf(round.id);
    const buffer = masterWorkbook(round, sheet, await buyingOf(round.id, sheet));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Snackit-${round.ref}-master-${round.delivery_date}.xlsx"`);
    res.send(buffer);
  }));

  // Sending the master sheet to the buyer: see supplyBuyer.js.
}
