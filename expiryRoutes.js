/* =========================================================
    EXPIRY TRACKING
    Product batches with production / expiry dates, quantity and cost per
    piece, so expired stock and its write-off value can be tracked.
    Everyone can view, add and edit; only admin can delete or import.
    Excel export and import (xlsx or csv) run here with the xlsx package.
========================================================= */
import XLSX from "xlsx";

async function ensureExpiryTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS expiry_batches (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      production_date DATE,
      expiry_date DATE NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      cost_per_piece NUMERIC(12,2) NOT NULL CHECK (cost_per_piece >= 0),
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

const pad = (n) => String(n).padStart(2, "0");

// Postgres DATE arrives as local midnight: send plain "YYYY-MM-DD" so no timezone shifts the day.
function plainDate(value) {
  if (!(value instanceof Date)) return value;
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toApi(row) {
  return row && {
    ...row,
    production_date: plainDate(row.production_date),
    expiry_date: plainDate(row.expiry_date),
    cost_per_piece: Number(row.cost_per_piece),
  };
}

function todayText() {
  return plainDate(new Date());
}

// Expired on or after the expiry date, as in the original tracker.
const isExpired = (batch) => batch.expiry_date <= todayText();

// Accepts 2026-09-20, 20/09/2026, 20-09-2026, "20 Sept 2026" or an Excel date number.
function readDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return plainDate(value);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}` : null;
  }
  const text = String(value).trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) return `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  const parsed = new Date(text.replace(/Sept/i, "Sep"));
  return Number.isNaN(parsed.getTime()) ? null : plainDate(parsed);
}

function userName(user) {
  return user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee";
}

// Validates one batch; returns { values } or { error }.
function readBatch(body) {
  const code = String(body.product_code ?? "").trim().slice(0, 40);
  const name = String(body.product_name ?? "").trim().slice(0, 120);
  const production = body.production_date ? readDate(body.production_date) : null;
  const expiry = readDate(body.expiry_date);
  const quantity = Number(body.quantity);
  const cost = Number(String(body.cost_per_piece ?? "").replace(/[₹,\s]/g, ""));
  if (!code) return { error: "Product ID is required" };
  if (!name) return { error: "Product name is required" };
  if (body.production_date && !production) return { error: `Invalid production date "${body.production_date}"` };
  if (!expiry) return { error: `Missing or invalid expiry date "${body.expiry_date ?? ""}"` };
  if (production && production > expiry) return { error: "Expiry date is before the production date" };
  if (!Number.isInteger(quantity) || quantity < 0) return { error: `Quantity must be a whole number (got "${body.quantity ?? ""}")` };
  if (!Number.isFinite(cost) || cost < 0) return { error: `Invalid cost per piece "${body.cost_per_piece ?? ""}"` };
  return { values: { product_code: code, product_name: name, production_date: production, expiry_date: expiry, quantity, cost_per_piece: Math.round(cost * 100) / 100 } };
}

// Spreadsheet headers we understand, matched ignoring case, spaces and symbols.
const IMPORT_COLUMNS = {
  product_code: ["productid", "id", "productcode", "code", "sku", "skuid"],
  product_name: ["productname", "name", "product", "item"],
  production_date: ["productiondate", "mfgdate", "manufacturingdate", "manufacturedate", "mfd", "packeddate"],
  expiry_date: ["expirydate", "expdate", "expiry", "bestbefore", "usebydate"],
  quantity: ["quantity", "qty", "units", "pieces"],
  cost_per_piece: ["costperpiece", "costperpieceinr", "costperpc", "costpc", "unitcost", "cost", "rate", "price"],
};

export function registerExpiryRoutes(app, { db, auth }) {
  ensureExpiryTable(db).catch((err) => console.log("EXPIRY TABLE ERROR:", err.message));

  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };
  const adminOnly = (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only admin can do this" });
    next();
  };

  app.get("/expiry", auth, handle("EXPIRY LIST", async (req, res) => {
    const result = await db.query("SELECT * FROM expiry_batches ORDER BY expiry_date ASC, id ASC LIMIT 5000");
    res.json(result.rows.map(toApi));
  }));

  app.post("/expiry", auth, handle("EXPIRY CREATE", async (req, res) => {
    const { values, error } = readBatch(req.body || {});
    if (error) return res.status(400).json({ error });
    const result = await db.query(
      `INSERT INTO expiry_batches (product_code, product_name, production_date, expiry_date, quantity, cost_per_piece, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [values.product_code, values.product_name, values.production_date, values.expiry_date, values.quantity, values.cost_per_piece, userName(req.user)]
    );
    res.status(201).json(toApi(result.rows[0]));
  }));

  app.patch("/expiry/:id", auth, handle("EXPIRY UPDATE", async (req, res) => {
    const { values, error } = readBatch(req.body || {});
    if (error) return res.status(400).json({ error });
    const result = await db.query(
      `UPDATE expiry_batches SET product_code=$1, product_name=$2, production_date=$3, expiry_date=$4, quantity=$5, cost_per_piece=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [values.product_code, values.product_name, values.production_date, values.expiry_date, values.quantity, values.cost_per_piece, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Batch not found" });
    res.json(toApi(result.rows[0]));
  }));

  app.delete("/expiry/:id", auth, adminOnly, handle("EXPIRY DELETE", async (req, res) => {
    await db.query("DELETE FROM expiry_batches WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  }));

  // Excel report: every batch with status and write-off, then a totals row.
  app.get("/expiry/export.xlsx", auth, handle("EXPIRY EXPORT", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM expiry_batches ORDER BY expiry_date ASC, id ASC");
    const batches = rows.map(toApi);
    const sheetRows = batches.map((batch) => {
      const total = Math.round(batch.quantity * batch.cost_per_piece * 100) / 100;
      const expired = isExpired(batch);
      return {
        "Product ID": batch.product_code,
        "Product Name": batch.product_name,
        "Production Date": batch.production_date || "",
        "Expiry Date": batch.expiry_date,
        Quantity: batch.quantity,
        "Cost Per Piece (INR)": batch.cost_per_piece,
        "Total Cost (INR)": total,
        Status: expired ? "Expired" : "Active",
        "Expired Loss (INR)": expired ? total : 0,
      };
    });
    const sum = (key) => Math.round(sheetRows.reduce((acc, row) => acc + row[key], 0) * 100) / 100;
    const totals = { "Product ID": "TOTALS", Quantity: sum("Quantity"), "Total Cost (INR)": sum("Total Cost (INR)"), "Expired Loss (INR)": sum("Expired Loss (INR)") };
    sheetRows.push({}, totals);

    const sheet = XLSX.utils.json_to_sheet(sheetRows, {
      header: ["Product ID", "Product Name", "Production Date", "Expiry Date", "Quantity", "Cost Per Piece (INR)", "Total Cost (INR)", "Status", "Expired Loss (INR)"],
    });
    sheet["!cols"] = [14, 24, 16, 14, 10, 20, 18, 10, 20].map((wch) => ({ wch }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Expiry Tracking");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Snackit_Expiry_Tracking_${todayText()}.xlsx"`);
    res.send(buffer);
  }));

  // Import an Excel (.xlsx/.xls) or CSV file sent as base64. Exact repeats of an existing batch are skipped.
  app.post("/expiry/import", auth, adminOnly, handle("EXPIRY IMPORT", async (req, res) => {
    const data = String(req.body?.file || "");
    if (!data) return res.status(400).json({ error: "No file received" });
    let sheetRows;
    try {
      const book = XLSX.read(Buffer.from(data, "base64"), { type: "buffer", cellDates: true });
      sheetRows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: "" });
    } catch {
      return res.status(400).json({ error: "Could not read that file. Use .xlsx, .xls or .csv." });
    }
    const [header = [], ...lines] = sheetRows;
    const keys = header.map((cell) => {
      const name = String(cell).toLowerCase().replace(/[^a-z]/g, "");
      return Object.keys(IMPORT_COLUMNS).find((key) => IMPORT_COLUMNS[key].includes(name)) || null;
    });
    const missing = ["product_name", "expiry_date", "quantity", "cost_per_piece"].filter((key) => !keys.includes(key));
    if (missing.length) {
      return res.status(400).json({ error: `The first row needs these columns: Product Name, Expiry Date, Quantity, Cost Per Piece. Missing: ${missing.join(", ").replace(/_/g, " ")}` });
    }

    const by = `${userName(req.user)} (import)`;
    let inserted = 0;
    let skipped = 0;
    const errors = [];
    for (const [index, cells] of lines.slice(0, 5000).entries()) {
      const line = index + 2;
      const row = Object.fromEntries(keys.map((key, i) => [key, cells[i]]).filter(([key]) => key));
      if (!Object.values(row).some((value) => String(value ?? "").trim())) continue; // blank line
      if (String(row.product_code || "").trim().toUpperCase() === "TOTALS") continue; // Export's totals row
      if (!String(row.product_code ?? "").trim()) row.product_code = String(row.product_name || "").trim().slice(0, 40);
      const { values, error } = readBatch(row);
      if (error) { errors.push(`Line ${line}: ${error}`); continue; }
      const duplicate = await db.query(
        `SELECT 1 FROM expiry_batches WHERE product_code=$1 AND lower(product_name)=lower($2) AND expiry_date=$3
           AND quantity=$4 AND cost_per_piece=$5 AND production_date IS NOT DISTINCT FROM $6::date`,
        [values.product_code, values.product_name, values.expiry_date, values.quantity, values.cost_per_piece, values.production_date]
      );
      if (duplicate.rows.length) { skipped += 1; continue; }
      await db.query(
        `INSERT INTO expiry_batches (product_code, product_name, production_date, expiry_date, quantity, cost_per_piece, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [values.product_code, values.product_name, values.production_date, values.expiry_date, values.quantity, values.cost_per_piece, by]
      );
      inserted += 1;
    }
    res.json({ inserted, skipped, errors });
  }));
}
