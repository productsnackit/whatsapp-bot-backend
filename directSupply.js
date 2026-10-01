/* =========================================================
    DIRECT SUPPLY (phase 1: orders → master sheet)
    Snackit supplies snacks, drinks and fruit straight to companies. Company admins
    send their orders on WhatsApp (text or Excel); each order is pasted or uploaded
    here against a supply round (one delivery date). The master sheet combines every
    company's order: the same item (after cleaning the name, or confirmed "same item")
    is added up, with a column per company. The stock buyer gets it on WhatsApp as a
    summary and an Excel file, or downloads it.
    Items the system isn't sure about ("Lays Clasic 52g" vs "Lays Classic 52g") are
    listed under "Check names" until someone says same item / new item; the answer is
    remembered for next time.
========================================================= */
import XLSX from "xlsx";
import { parseText, parseRows, parseOrderMessage, cleanName, displayName, matchName, normaliseUnit, UNITS } from "./supplyParse.js";
import { storeDashboardFile, sendStoredFile } from "./ticketChat.js";
import { sendWhatsAppPayload } from "./whatsapp.js";
import { refillerWindowOpen } from "./whatsappOutbox.js";

let db = null;
const userName = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee");
const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};
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
  `);
}

async function products() {
  const { rows } = await db.query("SELECT id, name, key, unit, category, aliases FROM supply_products ORDER BY name");
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
function readOrder({ text, file }) {
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
async function masterOf(roundId) {
  const { rows: lines } = await db.query(
    `SELECT l.*, p.name AS product_name, p.category, s.name AS suggestion_name, c.name AS company_name
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
    const itemKey = line.product_id ? `p${line.product_id}` : `n${cleanName(line.raw_name)}`;
    const key = `${itemKey}|${line.unit}`;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        product_id: line.product_id,
        name: line.product_name || displayName(line.raw_name),
        category: line.category || "",
        unit: line.unit,
        total: 0,
        by_company: {},
        to_check: false,
        spellings: new Set(),
      });
    }
    const row = rows.get(key);
    row.total += Number(line.qty);
    row.by_company[line.company_id] = (row.by_company[line.company_id] || 0) + Number(line.qty);
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

function masterWorkbook(round, sheet) {
  const header = ["Item", "Unit", "Total", ...sheet.companies.map((company) => company.name)];
  const rows = sheet.master.map((row) => [
    row.name + (row.to_check ? " (check name)" : ""), row.unit, row.total,
    ...sheet.companies.map((company) => (row.by_company[company.id] ? Number(qtyText(row.by_company[company.id])) : "")),
  ]);
  const title = `Snackit Direct Supply · ${round.ref} · Delivery ${dayLabel(round.delivery_date)}${round.title ? ` · ${round.title}` : ""}`;
  const worksheet = XLSX.utils.aoa_to_sheet([[title], [], header, ...rows]);
  worksheet["!cols"] = [{ wch: 36 }, { wch: 8 }, { wch: 9 }, ...sheet.companies.map(() => ({ wch: 16 }))];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Master sheet");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function roundById(id) {
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
    const [companies, items, rounds] = await Promise.all([
      db.query("SELECT * FROM supply_companies ORDER BY active DESC, name"),
      products(),
      db.query(`SELECT r.*, COUNT(DISTINCT o.company_id)::int AS company_count, COUNT(l.id)::int AS line_count
                FROM supply_rounds r LEFT JOIN supply_orders o ON o.round_id = r.id LEFT JOIN supply_lines l ON l.order_id = o.id
                GROUP BY r.id ORDER BY r.delivery_date DESC, r.id DESC LIMIT 200`),
    ]);
    const { rows: buyer } = await db.query("SELECT value FROM app_settings WHERE key = 'supply_buyer_id'").catch(() => ({ rows: [] }));
    res.json({
      companies: companies.rows,
      products: items,
      rounds: rounds.rows.map((round) => ({ ...round, delivery_date: plainDate(round.delivery_date) })),
      units: UNITS,
      buyer_id: buyer[0]?.value || null,
    });
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
    const fields = ["name", "contact_name", "contact_phone", "location", "active"].filter((key) => req.body?.[key] !== undefined);
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
    res.json({ round, orders, ...(await masterOf(round.id)) });
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
    let created = 0;
    for (const line of await withMatches(lines)) {
      let productId = line.product_id;
      // A name nobody has seen, and not close to a known item: it becomes a new item, so the
      // same spelling from another company combines straight away.
      if (!productId && !line.suggestion_id) {
        productId = await createProduct(line.name, line.unit);
        created += 1;
      }
      await db.query(
        `INSERT INTO supply_lines (order_id, round_id, company_id, raw_name, qty, unit, product_id, suggestion_id, problem)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [order[0].id, round.id, companyId, line.name, line.qty, line.unit, productId, productId ? null : line.suggestion_id, line.qty > 0 ? null : "Quantity missing"]
      );
    }
    await db.query("UPDATE supply_rounds SET updated_at = NOW() WHERE id = $1", [round.id]);
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
    const fields = ["name", "unit", "category"].filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    const values = fields.map((key) => (key === "name" ? displayName(req.body.name) : String(req.body[key] || "").trim() || null));
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

  /* ---------- Master sheet out ---------- */
  app.get("/supply/rounds/:id/master.xlsx", auth, handle("SUPPLY EXCEL", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const buffer = masterWorkbook(round, await masterOf(round.id));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Snackit-${round.ref}-master-${round.delivery_date}.xlsx"`);
    res.send(buffer);
  }));

  // To the stock buyer's WhatsApp: a summary and the Excel file. WhatsApp only allows this within
  // 24 hours of their last message to the Snackit number, so outside that it says so.
  app.post("/supply/rounds/:id/send", auth, handle("SUPPLY SEND", async (req, res) => {
    const round = await roundById(req.params.id);
    if (!round) return res.status(404).json({ error: "Not found" });
    const buyer = (global.internalUsers || []).find((user) => String(user.id) === String(req.body?.buyer_id));
    if (!buyer) return res.status(400).json({ error: "Choose who buys the stock" });
    if (!buyer.phone) return res.status(400).json({ error: `${buyer.name} has no WhatsApp number. Add it in Employees & Access.` });
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_buyer_id', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(buyer.id)]
    );
    const to = phoneDigits(buyer.phone);
    if (!(await refillerWindowOpen(to))) {
      return res.status(409).json({ error: `${buyer.name} hasn't messaged the Snackit WhatsApp number in the last 24 hours, so WhatsApp won't deliver it. Ask them to send "hi", then try again, or download the Excel and share it.` });
    }
    const sheet = await masterOf(round.id);
    if (!sheet.master.length) return res.status(400).json({ error: "There are no orders in this round yet" });
    const toBuy = sheet.master.filter((row) => row.total > 0);
    const lines = toBuy.slice(0, 60).map((row) => `• ${row.name}: *${row.total} ${row.unit}*${row.to_check ? " (check name)" : ""}`);
    const body = [
      `🛒 *Stock to buy · ${round.ref}*`,
      `Delivery: ${dayLabel(round.delivery_date)}${round.title ? ` · ${round.title}` : ""}`,
      `${sheet.companies.length} compan${sheet.companies.length === 1 ? "y" : "ies"}: ${sheet.companies.map((company) => company.name).join(", ")}`,
      "",
      ...lines,
      toBuy.length > 60 ? `…and ${toBuy.length - 60} more in the Excel file.` : "",
      "",
      "Full sheet with each company's quantity is attached.",
    ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").slice(0, 4000);
    const text = await sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body } });
    if (!text.ok) return res.status(502).json({ error: text.error || "WhatsApp didn't accept the message" });
    const file = await storeDashboardFile({
      name: `Snackit-${round.ref}-master-${round.delivery_date}.xlsx`,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: masterWorkbook(round, sheet).toString("base64"),
    });
    const document = await sendStoredFile(to, file, `${round.ref} master sheet`);
    await db.query(
      "UPDATE supply_rounds SET sent_at = NOW(), sent_to = $2, status = CASE WHEN status = 'Collecting' THEN 'Sent to buyer' ELSE status END, updated_at = NOW() WHERE id = $1",
      [round.id, buyer.name]
    );
    res.locals.activity = { section: "Direct Supply", action: `Sent ${round.ref} master sheet to ${buyer.name}` };
    res.json({ success: true, file_sent: Boolean(document.ok), round: await roundById(round.id) });
  }));
}
