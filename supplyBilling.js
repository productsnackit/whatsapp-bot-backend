/* =========================================================
    DIRECT SUPPLY · DELIVERY & BILLING (phase 3)
    For every company in a delivery round:
      • packing list: their order, with the quantity actually packed/delivered
        (defaults to what they ordered; boxes count as pieces where pieces-per-box is set);
      • delivery: Pending → Packed → Out for delivery → Delivered, with a photo as proof
        and who received it;
      • invoice: made from what was delivered at that company's prices (company price, else
        the item's default; missing prices are filled in on the draft), optional GST %, a
        number (INV-0001) and a snapshot of the lines so later price changes don't alter it;
      • payments against the invoice (UPI / bank / cash / cheque); the invoice becomes
        Part paid or Paid, and the Accounts view shows what each company still owes.
    Snackit's own details for the invoice header are kept in app_settings (supply_seller).
========================================================= */
import { storeDashboardFile } from "./ticketChat.js";

let db = null;
const userName = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee");
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
export const DELIVERY_STEPS = ["Pending", "Packed", "Out for delivery", "Delivered"];
const METHODS = ["UPI", "Bank transfer", "Cash", "Cheque", "Other"];

export async function ensureSupplyBilling(database) {
  db = database;
  await db.query(`
    ALTER TABLE supply_lines ADD COLUMN IF NOT EXISTS delivered_qty NUMERIC;
    ALTER TABLE supply_companies
      ADD COLUMN IF NOT EXISTS billing_name TEXT,
      ADD COLUMN IF NOT EXISTS address TEXT,
      ADD COLUMN IF NOT EXISTS gstin TEXT,
      ADD COLUMN IF NOT EXISTS payment_days INTEGER;
    CREATE TABLE IF NOT EXISTS supply_deliveries (
      round_id INTEGER NOT NULL REFERENCES supply_rounds(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'Pending',
      packed_at TIMESTAMPTZ,
      packed_by TEXT,
      out_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      delivered_by TEXT,
      received_by TEXT,
      proof_url TEXT,
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (round_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS supply_invoices (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE,
      round_id INTEGER REFERENCES supply_rounds(id) ON DELETE SET NULL,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id),
      invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date DATE,
      lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal NUMERIC NOT NULL DEFAULT 0,
      gst_percent NUMERIC NOT NULL DEFAULT 0,
      gst_amount NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      paid NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Unpaid',
      notes TEXT,
      cancelled_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS supply_payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES supply_invoices(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
      method TEXT NOT NULL DEFAULT 'UPI',
      reference TEXT,
      recorded_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

const invoiceOut = (row) => row && {
  ...row,
  invoice_date: plainDate(row.invoice_date),
  due_date: plainDate(row.due_date),
  subtotal: Number(row.subtotal), gst_percent: Number(row.gst_percent), gst_amount: Number(row.gst_amount),
  total: Number(row.total), paid: Number(row.paid), balance: round2(Number(row.total) - Number(row.paid)),
};

// A company's lines in a round, with the quantity delivered and its price (company, else default).
async function companyLines(roundId, companyId) {
  const { rows } = await db.query(
    `SELECT l.id, l.raw_name, l.qty, l.unit, l.delivered_qty, l.product_id,
            p.name AS product_name, p.unit AS product_unit, p.pack_size, p.sell_price, cp.price AS company_price
     FROM supply_lines l
     LEFT JOIN supply_products p ON p.id = l.product_id
     LEFT JOIN supply_company_prices cp ON cp.company_id = l.company_id AND cp.product_id = l.product_id
       AND cp.unit = CASE WHEN l.unit = 'box' AND p.pack_size > 0 AND p.unit <> 'box' THEN p.unit ELSE l.unit END
     WHERE l.round_id = $1 AND l.company_id = $2 ORDER BY COALESCE(p.name, l.raw_name)`,
    [roundId, companyId]
  );
  return rows.map((line) => {
    const perBox = Number(line.pack_size) || 0;
    const boxed = line.unit === "box" && perBox > 0 && line.product_unit && line.product_unit !== "box";
    const unit = boxed ? line.product_unit : line.unit;
    const ordered = boxed ? Number(line.qty) * perBox : Number(line.qty);
    const delivered = line.delivered_qty != null ? Number(line.delivered_qty) : ordered;
    const price = line.company_price != null ? Number(line.company_price)
      : line.sell_price != null && line.product_unit === unit ? Number(line.sell_price) : null;
    return {
      line_id: line.id, product_id: line.product_id, name: line.product_name || line.raw_name, unit,
      ordered, delivered, changed: line.delivered_qty != null, boxes: boxed ? Number(line.qty) : 0, price,
    };
  });
}

async function seller() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'supply_seller'").catch(() => ({ rows: [] }));
  try {
    return JSON.parse(rows[0]?.value || "{}");
  } catch {
    return {};
  }
}

async function refreshInvoice(invoiceId) {
  const { rows } = await db.query(
    `UPDATE supply_invoices i SET paid = COALESCE((SELECT SUM(amount) FROM supply_payments p WHERE p.invoice_id = i.id), 0)
     WHERE i.id = $1 RETURNING *`,
    [invoiceId]
  );
  const invoice = rows[0];
  if (!invoice) return null;
  const status = invoice.cancelled_at ? "Cancelled" : Number(invoice.paid) <= 0 ? "Unpaid" : Number(invoice.paid) + 0.005 >= Number(invoice.total) ? "Paid" : "Part paid";
  const updated = await db.query("UPDATE supply_invoices SET status = $2 WHERE id = $1 RETURNING *", [invoiceId, status]);
  return invoiceOut(updated.rows[0]);
}

export function registerSupplyBillingRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  /* ---------- Delivery per company ---------- */
  // Every company in the round: delivery status, packing list (with prices) and its invoice.
  app.get("/supply/rounds/:id/delivery", auth, handle("SUPPLY DELIVERY", async (req, res) => {
    const roundId = Number(req.params.id);
    const { rows: companies } = await db.query(
      `SELECT DISTINCT c.id, c.name, c.contact_name, c.contact_phone, c.location, c.billing_name, c.address, c.gstin, c.payment_days
       FROM supply_lines l JOIN supply_companies c ON c.id = l.company_id WHERE l.round_id = $1 ORDER BY c.name`,
      [roundId]
    );
    const [deliveries, invoices] = await Promise.all([
      db.query("SELECT * FROM supply_deliveries WHERE round_id = $1", [roundId]),
      db.query("SELECT * FROM supply_invoices WHERE round_id = $1 AND cancelled_at IS NULL ORDER BY id", [roundId]),
    ]);
    const result = [];
    for (const company of companies) {
      const lines = await companyLines(roundId, company.id);
      result.push({
        company,
        delivery: deliveries.rows.find((row) => row.company_id === company.id) || { status: "Pending" },
        lines,
        missing_prices: lines.filter((line) => line.delivered > 0 && line.price == null).map((line) => line.name),
        invoice: invoiceOut(invoices.rows.find((row) => row.company_id === company.id)) || null,
      });
    }
    res.json({ companies: result, steps: DELIVERY_STEPS, seller: await seller() });
  }));

  // Quantity actually packed / delivered for one order line (empty = as ordered).
  app.patch("/supply/lines/:id/delivered", auth, handle("SUPPLY DELIVERED QTY", async (req, res) => {
    const value = req.body?.delivered_qty;
    if (value !== "" && value != null && !(Number(value) >= 0)) return res.status(400).json({ error: "Enter a quantity" });
    // Saved in the line's own unit: a box line with pieces per box is given in pieces, so convert back.
    const { rows } = await db.query(
      "SELECT l.unit, p.unit AS product_unit, p.pack_size FROM supply_lines l LEFT JOIN supply_products p ON p.id = l.product_id WHERE l.id = $1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const line = rows[0];
    const perBox = Number(line.pack_size) || 0;
    const boxed = line.unit === "box" && perBox > 0 && line.product_unit && line.product_unit !== "box";
    const stored = value === "" || value == null ? null : boxed ? Number(value) / perBox : Number(value);
    await db.query("UPDATE supply_lines SET delivered_qty = $2 WHERE id = $1", [req.params.id, stored]);
    res.json({ success: true });
  }));

  // Move a company's delivery along; a photo (base64) can be attached as proof.
  app.post("/supply/rounds/:id/delivery/:companyId", auth, handle("SUPPLY DELIVERY UPDATE", async (req, res) => {
    const roundId = Number(req.params.id);
    const companyId = Number(req.params.companyId);
    const by = userName(req.user);
    const status = req.body?.status;
    if (status && !DELIVERY_STEPS.includes(status)) return res.status(400).json({ error: "Invalid status" });
    let proofUrl;
    if (req.body?.photo?.data) {
      try {
        proofUrl = (await storeDashboardFile({ name: req.body.photo.name || "delivery.jpg", type: req.body.photo.type || "image/jpeg", data: req.body.photo.data })).url;
      } catch (err) {
        return res.status(400).json({ error: err.message || "Could not upload the photo" });
      }
    }
    await db.query(
      `INSERT INTO supply_deliveries (round_id, company_id, status) VALUES ($1, $2, COALESCE($3, 'Pending'))
       ON CONFLICT (round_id, company_id) DO NOTHING`,
      [roundId, companyId, status || null]
    );
    await db.query(
      `UPDATE supply_deliveries SET
         status = COALESCE($3, status),
         packed_at = CASE WHEN $3 = 'Packed' THEN NOW() ELSE packed_at END,
         packed_by = CASE WHEN $3 = 'Packed' THEN $4 ELSE packed_by END,
         out_at = CASE WHEN $3 = 'Out for delivery' THEN NOW() ELSE out_at END,
         delivered_at = CASE WHEN $3 = 'Delivered' THEN NOW() ELSE delivered_at END,
         delivered_by = CASE WHEN $3 = 'Delivered' THEN $4 ELSE delivered_by END,
         received_by = COALESCE($5, received_by),
         proof_url = COALESCE($6, proof_url),
         notes = COALESCE($7, notes),
         updated_at = NOW()
       WHERE round_id = $1 AND company_id = $2`,
      [roundId, companyId, status || null, by, req.body?.received_by ?? null, proofUrl ?? null, req.body?.notes ?? null]
    );
    // When every company is delivered, the round is too.
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT l.company_id)::int AS companies,
              COUNT(DISTINCT d.company_id) FILTER (WHERE d.status = 'Delivered')::int AS delivered
       FROM supply_lines l LEFT JOIN supply_deliveries d ON d.round_id = l.round_id AND d.company_id = l.company_id WHERE l.round_id = $1`,
      [roundId]
    );
    if (rows[0].companies && rows[0].companies === rows[0].delivered) await db.query("UPDATE supply_rounds SET status = 'Delivered', updated_at = NOW() WHERE id = $1", [roundId]);
    if (status) res.locals.activity = { section: "Direct Supply", action: `Delivery for company #${companyId} → ${status}` };
    res.json({ success: true });
  }));

  /* ---------- Invoices ---------- */
  // Creates the invoice from what was delivered. prices: { [line_id]: price } fills missing ones
  // (and, with save_prices, becomes that company's price for next time).
  app.post("/supply/rounds/:id/invoices", auth, handle("SUPPLY INVOICE", async (req, res) => {
    const roundId = Number(req.params.id);
    const companyId = Number(req.body?.company_id);
    const { rows: existing } = await db.query("SELECT ref FROM supply_invoices WHERE round_id = $1 AND company_id = $2 AND cancelled_at IS NULL", [roundId, companyId]);
    if (existing.length) return res.status(400).json({ error: `This delivery already has invoice ${existing[0].ref}. Cancel it first to make a new one.` });
    const given = req.body?.prices || {};
    const lines = (await companyLines(roundId, companyId)).filter((line) => line.delivered > 0);
    if (!lines.length) return res.status(400).json({ error: "Nothing delivered to invoice" });
    const missing = [];
    const items = lines.map((line) => {
      const typed = given[line.line_id];
      const price = typed !== undefined && typed !== "" ? Number(typed) : line.price;
      if (price == null || !(price >= 0)) missing.push(line.name);
      return { name: line.name, qty: line.delivered, unit: line.unit, price, amount: round2(line.delivered * (price || 0)), product_id: line.product_id, line_id: line.line_id };
    });
    if (missing.length) return res.status(400).json({ error: `Add a price for: ${missing.join(", ")}`, missing });
    if (req.body?.save_prices) {
      for (const item of items) {
        if (given[item.line_id] === undefined || given[item.line_id] === "" || !item.product_id) continue;
        await db.query(
          `INSERT INTO supply_company_prices (company_id, product_id, unit, price) VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, product_id, unit) DO UPDATE SET price = EXCLUDED.price, updated_at = NOW()`,
          [companyId, item.product_id, item.unit, item.price]
        );
      }
    }
    const subtotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
    const gstPercent = Math.max(0, Number(req.body?.gst_percent) || 0);
    const gstAmount = round2((subtotal * gstPercent) / 100);
    const { rows: company } = await db.query("SELECT payment_days FROM supply_companies WHERE id = $1", [companyId]);
    const days = Number(req.body?.payment_days ?? company[0]?.payment_days ?? 7) || 0;
    const { rows } = await db.query(
      `INSERT INTO supply_invoices (round_id, company_id, invoice_date, due_date, lines, subtotal, gst_percent, gst_amount, total, notes, created_by)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + $3::int, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [roundId, companyId, days, JSON.stringify(items), subtotal, gstPercent, gstAmount, round2(subtotal + gstAmount), req.body?.notes || null, userName(req.user)]
    );
    await db.query("UPDATE supply_invoices SET ref = 'INV-' || LPAD(id::text, 4, '0') WHERE id = $1", [rows[0].id]);
    const invoice = await refreshInvoice(rows[0].id);
    res.locals.activity = { section: "Direct Supply", action: `Created invoice ${invoice.ref} (₹${invoice.total})` };
    res.status(201).json(invoice);
  }));

  app.get("/supply/invoices/:id", auth, handle("SUPPLY INVOICE READ", async (req, res) => {
    const { rows } = await db.query(
      `SELECT i.*, c.name AS company_name, c.billing_name, c.address, c.gstin, c.contact_name, c.contact_phone, r.ref AS round_ref, r.delivery_date
       FROM supply_invoices i JOIN supply_companies c ON c.id = i.company_id LEFT JOIN supply_rounds r ON r.id = i.round_id WHERE i.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const { rows: payments } = await db.query("SELECT * FROM supply_payments WHERE invoice_id = $1 ORDER BY paid_on, id", [req.params.id]);
    res.json({
      invoice: { ...invoiceOut(rows[0]), delivery_date: plainDate(rows[0].delivery_date) },
      payments: payments.map((payment) => ({ ...payment, amount: Number(payment.amount), paid_on: plainDate(payment.paid_on) })),
      seller: await seller(),
    });
  }));

  app.post("/supply/invoices/:id/cancel", auth, handle("SUPPLY INVOICE CANCEL", async (req, res) => {
    const { rows } = await db.query("UPDATE supply_invoices SET cancelled_at = NOW(), status = 'Cancelled' WHERE id = $1 AND cancelled_at IS NULL RETURNING ref", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found or already cancelled" });
    res.locals.activity = { section: "Direct Supply", action: `Cancelled invoice ${rows[0].ref}` };
    res.json({ success: true });
  }));

  /* ---------- Payments ---------- */
  app.post("/supply/invoices/:id/payments", auth, handle("SUPPLY PAYMENT", async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!(amount > 0)) return res.status(400).json({ error: "Enter the amount received" });
    const method = METHODS.includes(req.body?.method) ? req.body.method : "UPI";
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.paid_on || "")) ? req.body.paid_on : plainDate(new Date());
    const { rows } = await db.query("SELECT ref, cancelled_at FROM supply_invoices WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Invoice not found" });
    if (rows[0].cancelled_at) return res.status(400).json({ error: "This invoice is cancelled" });
    await db.query(
      "INSERT INTO supply_payments (invoice_id, amount, paid_on, method, reference, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.params.id, amount, paidOn, method, String(req.body?.reference || "").slice(0, 120) || null, userName(req.user)]
    );
    const invoice = await refreshInvoice(req.params.id);
    res.locals.activity = { section: "Direct Supply", action: `Payment ₹${amount} (${method}) for ${rows[0].ref}` };
    res.status(201).json(invoice);
  }));

  app.delete("/supply/payments/:id", auth, handle("SUPPLY PAYMENT DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM supply_payments WHERE id = $1 RETURNING invoice_id", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(await refreshInvoice(rows[0].invoice_id));
  }));

  /* ---------- Accounts: what each company owes ---------- */
  app.get("/supply/accounts", auth, handle("SUPPLY ACCOUNTS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT i.*, c.name AS company_name, r.ref AS round_ref, r.delivery_date
       FROM supply_invoices i JOIN supply_companies c ON c.id = i.company_id LEFT JOIN supply_rounds r ON r.id = i.round_id
       WHERE i.cancelled_at IS NULL ORDER BY i.invoice_date DESC, i.id DESC LIMIT 1000`
    );
    const invoices = rows.map((row) => ({ ...invoiceOut(row), delivery_date: plainDate(row.delivery_date) }));
    const today = plainDate(new Date());
    const companies = new Map();
    for (const invoice of invoices) {
      if (!companies.has(invoice.company_id)) companies.set(invoice.company_id, { company_id: invoice.company_id, name: invoice.company_name, billed: 0, received: 0, outstanding: 0, overdue: 0, open_invoices: 0, oldest_due: null });
      const entry = companies.get(invoice.company_id);
      entry.billed += invoice.total;
      entry.received += invoice.paid;
      if (invoice.balance > 0.005) {
        entry.outstanding += invoice.balance;
        entry.open_invoices += 1;
        if (invoice.due_date && invoice.due_date < today) entry.overdue += invoice.balance;
        if (!entry.oldest_due || invoice.due_date < entry.oldest_due) entry.oldest_due = invoice.due_date;
      }
    }
    const summary = [...companies.values()].map((entry) => ({ ...entry, billed: round2(entry.billed), received: round2(entry.received), outstanding: round2(entry.outstanding), overdue: round2(entry.overdue) }))
      .sort((a, b) => b.outstanding - a.outstanding);
    const totals = summary.reduce((sum, entry) => ({ billed: sum.billed + entry.billed, received: sum.received + entry.received, outstanding: sum.outstanding + entry.outstanding, overdue: sum.overdue + entry.overdue }), { billed: 0, received: 0, outstanding: 0, overdue: 0 });
    res.json({ invoices, companies: summary, totals, today });
  }));

  /* ---------- Settings: Snackit's details on invoices, and companies' billing details ---------- */
  app.get("/supply/seller", auth, handle("SUPPLY SELLER", async (req, res) => res.json(await seller())));
  app.put("/supply/seller", auth, handle("SUPPLY SELLER SAVE", async (req, res) => {
    const keys = ["name", "address", "gstin", "phone", "email", "upi", "bank", "terms"];
    const value = Object.fromEntries(keys.map((key) => [key, String(req.body?.[key] || "").slice(0, 600)]));
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_seller', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(value)]
    );
    res.json(value);
  }));
}
