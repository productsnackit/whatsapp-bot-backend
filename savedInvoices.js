/* =========================================================
    SAVED INVOICES (the Invoices page, invoiceDashboard.html)
    Every invoice downloaded, printed or saved there is kept here: the filled-in form and its
    rows (not the PDF, and not the logo / stamp, which stay in each browser), one per invoice
    number. The page lists them by invoice date; opening one fills the form again.
    Admin Settings → "Saved invoices" deletes them after N days (0 = keep forever, the default).
========================================================= */
let db = null;
const RETENTION_KEY = "invoice_retention_days";

export async function ensureSavedInvoices(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS saved_invoices (
      id SERIAL PRIMARY KEY, inv_no TEXT NOT NULL, inv_key TEXT NOT NULL UNIQUE, client TEXT, inv_date DATE,
      total NUMERIC, rows_count INTEGER, data JSONB NOT NULL,
      created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS saved_invoices_date_idx ON saved_invoices (inv_date DESC);
  `);
}

async function retentionDays() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [RETENTION_KEY]).catch(() => ({ rows: [] }));
  const days = Number(rows[0]?.value);
  return Number.isFinite(days) && days > 0 ? Math.round(days) : 0;
}

// Runs with the photo clean-up (every 6 hours): invoices saved longer ago than the setting go.
export async function cleanOldInvoices() {
  if (!db) return 0;
  const days = await retentionDays();
  if (!days) return 0;
  const { rowCount } = await db.query("DELETE FROM saved_invoices WHERE updated_at < NOW() - ($1 * INTERVAL '1 day')", [days]);
  if (rowCount) console.log(`🧾 Deleted ${rowCount} saved invoice(s) older than ${days} days`);
  return rowCount;
}

const who = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Staff");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : value ? String(value).slice(0, 10) : null);
const view = (row) => row && ({ ...row, inv_date: plainDate(row.inv_date), total: row.total == null ? null : Number(row.total) });

export function registerSavedInvoiceRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { console.log(`${label} ERROR:`, err.message); res.status(500).json({ error: "Could not do that. Please try again." }); }
  };
  const adminOnly = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: "Admin access required" }));

  // The list (newest invoice date first), without the form data.
  app.get("/invoicing/saved", auth, handle("INVOICES LIST", async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, inv_no, client, inv_date, total, rows_count, created_by, created_at, updated_by, updated_at
       FROM saved_invoices ORDER BY inv_date DESC NULLS LAST, updated_at DESC LIMIT 2000`
    );
    res.json({ invoices: rows.map(view), retention_days: await retentionDays() });
  }));

  app.get("/invoicing/saved/:id", auth, handle("INVOICE OPEN", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM saved_invoices WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "That invoice is no longer saved" });
    res.json(view(rows[0]));
  }));

  // Save (or update) by invoice number: { inv_no, client, inv_date, total, data: { fields, rows } }.
  app.post("/invoicing/saved", auth, handle("INVOICE SAVE", async (req, res) => {
    const invNo = String(req.body?.inv_no || "").trim().slice(0, 60);
    if (!invNo) return res.status(400).json({ error: "Type the invoice number first" });
    const data = req.body?.data;
    if (!data || typeof data !== "object") return res.status(400).json({ error: "Nothing to save" });
    const text = JSON.stringify(data);
    if (text.length > 2_000_000) return res.status(400).json({ error: "This invoice is too big to save" });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.inv_date || "")) ? req.body.inv_date : null;
    const total = Number(req.body?.total);
    const by = who(req.user);
    const { rows } = await db.query(
      `INSERT INTO saved_invoices (inv_no, inv_key, client, inv_date, total, rows_count, data, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
       ON CONFLICT (inv_key) DO UPDATE SET inv_no = EXCLUDED.inv_no, client = EXCLUDED.client, inv_date = EXCLUDED.inv_date,
         total = EXCLUDED.total, rows_count = EXCLUDED.rows_count, data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING id, inv_no, client, inv_date, total, rows_count, created_by, created_at, updated_by, updated_at, (xmax <> 0) AS updated`,
      [invNo, invNo.toUpperCase().replace(/\s+/g, ""), String(req.body?.client || "").slice(0, 200), date, Number.isFinite(total) ? total : null,
        Array.isArray(data.rows) ? data.rows.length : 0, text, by]
    );
    res.locals.activity = { section: "Invoices", action: `${rows[0].updated ? "Updated" : "Saved"} invoice ${invNo}${req.body?.client ? ` for ${req.body.client}` : ""}` };
    res.json(view(rows[0]));
  }));

  app.delete("/invoicing/saved/:id", auth, handle("INVOICE DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM saved_invoices WHERE id = $1 RETURNING inv_no", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Already deleted" });
    res.locals.activity = { section: "Invoices", action: `Deleted saved invoice ${rows[0].inv_no}` };
    res.json({ success: true });
  }));

  // Admin Settings: days to keep saved invoices (0 = keep forever).
  app.get("/admin/invoice-retention", auth, adminOnly, handle("INVOICE RETENTION", async (req, res) => {
    const { rows } = await db.query("SELECT COUNT(*)::int AS count, MIN(updated_at) AS oldest FROM saved_invoices");
    res.json({ days: await retentionDays(), saved: rows[0].count, oldest: rows[0].oldest });
  }));
  app.put("/admin/invoice-retention", auth, adminOnly, handle("INVOICE RETENTION SAVE", async (req, res) => {
    const days = Math.round(Number(req.body?.days));
    if (!(days >= 0 && days <= 3650)) return res.status(400).json({ error: "Enter 0 to 3650 days (0 = keep forever)" });
    await db.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [RETENTION_KEY, String(days)]);
    res.locals.activity = { section: "Admin Settings", action: days ? `Saved invoices: delete after ${days} days` : "Saved invoices: keep forever" };
    res.json({ days });
  }));
  app.post("/admin/invoice-retention/run", auth, adminOnly, handle("INVOICE RETENTION RUN", async (req, res) => {
    res.json({ deleted: await cleanOldInvoices() });
  }));
}
