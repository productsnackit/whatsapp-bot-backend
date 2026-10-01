/* =========================================================
    DIRECT SUPPLY · REPORTS (phase 4)
    For deliveries in a period (by delivery date):
      sales  = invoiced amount before GST (only invoiced deliveries count as sales),
      cost   = cost of what was sold: quantity × the price paid for that item in that delivery,
               else the average paid in the period, else the latest vendor rate (estimated);
               items with no price information are left out of profit and named,
      profit = sales − cost; "bought" = everything spent on stock in those deliveries;
    plus money received in the period, what is outstanding now, a month-by-month view
    (last 6 months), and the same split by company and by item.
    Rate history per item feeds the price-trend chart.
========================================================= */
let db = null;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const key = (productId, unit) => `${productId}|${unit}`;

export function initSupplyReports(database) {
  db = database;
}

async function periodFigures(from, to) {
  const { rows: rounds } = await db.query("SELECT id, delivery_date FROM supply_rounds WHERE delivery_date BETWEEN $1 AND $2", [from, to]);
  const roundIds = rounds.map((round) => round.id);
  const [invoices, purchases] = await Promise.all([
    db.query(
      `SELECT i.id, i.round_id, i.company_id, i.subtotal, i.lines, c.name AS company_name
       FROM supply_invoices i JOIN supply_companies c ON c.id = i.company_id
       WHERE i.cancelled_at IS NULL AND i.round_id = ANY($1)`,
      [roundIds]
    ),
    db.query(
      `SELECT pu.round_id, pu.product_id, pu.unit, pu.qty, pu.price, p.name
       FROM supply_purchases pu LEFT JOIN supply_products p ON p.id = pu.product_id WHERE pu.round_id = ANY($1)`,
      [roundIds]
    ),
  ]);
  // Latest rate from each vendor up to the end of the period; the cheapest is the estimate.
  const productIds = [...new Set(invoices.rows.flatMap((invoice) => (invoice.lines || []).map((line) => line.product_id)).filter(Boolean))];
  const { rows: latest } = await db.query(
    `SELECT DISTINCT ON (product_id, unit, vendor_id) product_id, unit, price FROM supply_prices
     WHERE product_id = ANY($1) AND recorded_at::date <= $2 ORDER BY product_id, unit, vendor_id, recorded_at DESC`,
    [productIds, to]
  );
  const rate = new Map();
  for (const row of latest) {
    const rateKey = key(row.product_id, row.unit);
    rate.set(rateKey, Math.min(rate.get(rateKey) ?? Infinity, Number(row.price)));
  }

  // Average price paid per item: per delivery, and over the whole period.
  const perRound = new Map();
  const perPeriod = new Map();
  let bought = 0;
  for (const item of purchases.rows) {
    bought += Number(item.qty) * Number(item.price);
    for (const [map, mapKey] of [[perRound, `${item.round_id}|${key(item.product_id, item.unit)}`], [perPeriod, key(item.product_id, item.unit)]]) {
      const entry = map.get(mapKey) || { qty: 0, spent: 0 };
      entry.qty += Number(item.qty);
      entry.spent += Number(item.qty) * Number(item.price);
      map.set(mapKey, entry);
    }
  }
  const avg = (entry) => (entry && entry.qty > 0 ? entry.spent / entry.qty : null);
  // Cost of one unit sold: paid for this delivery, else paid in the period, else the latest rate (estimated).
  const unitCost = (roundId, productId, unit) => {
    const lineKey = key(productId, unit);
    const paid = avg(perRound.get(`${roundId}|${lineKey}`)) ?? avg(perPeriod.get(lineKey));
    if (paid != null) return { cost: paid, estimated: false };
    return rate.has(lineKey) ? { cost: rate.get(lineKey), estimated: true } : null;
  };

  const totals = { sales: 0, costed_sales: 0, cost: 0, estimated_cost: 0, uncosted_sales: 0 };
  const uncostedItems = new Set();
  const companies = new Map();
  const items = new Map();
  for (const invoice of invoices.rows) {
    const company = companies.get(invoice.company_id) || { company_id: invoice.company_id, name: invoice.company_name, sales: 0, costed_sales: 0, cost: 0, invoices: 0 };
    company.invoices += 1;
    for (const line of invoice.lines || []) {
      const amount = Number(line.amount);
      const lineKey = key(line.product_id, line.unit);
      const item = items.get(lineKey) || { product_id: line.product_id, name: line.name, unit: line.unit, qty: 0, sales: 0, costed_sales: 0, cost: 0, estimated: false };
      item.qty += Number(line.qty);
      item.sales += amount;
      company.sales += amount;
      totals.sales += amount;
      const found = line.product_id ? unitCost(invoice.round_id, line.product_id, line.unit) : null;
      if (!found) {
        totals.uncosted_sales += amount;
        uncostedItems.add(line.name);
      } else {
        const cost = Number(line.qty) * found.cost;
        for (const target of [item, company]) { target.cost += cost; target.costed_sales += amount; }
        totals.cost += cost;
        totals.costed_sales += amount;
        if (found.estimated) { totals.estimated_cost += cost; item.estimated = true; }
      }
      items.set(lineKey, item);
    }
    companies.set(invoice.company_id, company);
  }
  // What was bought per item (shown next to what was sold).
  for (const [lineKey, entry] of perPeriod) {
    const [productId, unit] = lineKey.split("|");
    const name = purchases.rows.find((row) => String(row.product_id) === productId && row.unit === unit)?.name || "Item";
    const item = items.get(lineKey) || { product_id: Number(productId), name, unit, qty: 0, sales: 0, costed_sales: 0, cost: 0, estimated: false };
    item.bought_qty = entry.qty;
    item.bought = entry.spent;
    items.set(lineKey, item);
  }
  const profitOf = (entry) => (entry.costed_sales ? round2(entry.costed_sales - entry.cost) : null);
  return {
    rounds: rounds.length,
    invoiced_rounds: new Set(invoices.rows.map((invoice) => invoice.round_id)).size,
    sales: round2(totals.sales),
    cost: round2(totals.cost),
    estimated_cost: round2(totals.estimated_cost),
    uncosted_sales: round2(totals.uncosted_sales),
    uncosted_items: [...uncostedItems],
    profit: round2(totals.costed_sales - totals.cost),
    margin_percent: totals.costed_sales ? round2(((totals.costed_sales - totals.cost) / totals.costed_sales) * 100) : null,
    bought: round2(bought),
    companies: [...companies.values()].map((entry) => ({ ...entry, sales: round2(entry.sales), cost: round2(entry.cost), profit: profitOf(entry) })).sort((a, b) => b.sales - a.sales),
    items: [...items.values()].map((entry) => ({
      ...entry, qty: round2(entry.qty), sales: round2(entry.sales), cost: round2(entry.cost),
      bought_qty: round2(entry.bought_qty || 0), bought: round2(entry.bought || 0),
      avg_sell: entry.qty ? round2(entry.sales / entry.qty) : null,
      avg_buy: entry.bought_qty ? round2(entry.bought / entry.bought_qty) : null,
      profit: profitOf(entry),
    })).sort((a, b) => b.sales - a.sales || b.bought - a.bought),
  };
}

export function registerSupplyReportRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };

  app.get("/supply/reports", auth, handle("SUPPLY REPORTS", async (req, res) => {
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10); // India date
    const to = isDate(req.query.to) ? req.query.to : today;
    const from = isDate(req.query.from) ? req.query.from : `${to.slice(0, 7)}-01`;
    const figures = await periodFigures(from, to);
    const [received, outstanding] = await Promise.all([
      db.query("SELECT COALESCE(SUM(p.amount), 0) AS amount FROM supply_payments p JOIN supply_invoices i ON i.id = p.invoice_id WHERE i.cancelled_at IS NULL AND p.paid_on BETWEEN $1 AND $2", [from, to]),
      db.query("SELECT COALESCE(SUM(total - paid), 0) AS amount FROM supply_invoices WHERE cancelled_at IS NULL AND total - paid > 0.005"),
    ]);
    // Six months up to the end of the period, by delivery date.
    const months = [];
    const end = new Date(`${to}T00:00:00`);
    for (let back = 5; back >= 0; back -= 1) {
      const first = new Date(end.getFullYear(), end.getMonth() - back, 1);
      const last = new Date(end.getFullYear(), end.getMonth() - back + 1, 0);
      const month = await periodFigures(plainDate(first), plainDate(last));
      months.push({ month: plainDate(first).slice(0, 7), label: first.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }), sales: month.sales, cost: month.cost, profit: month.profit, rounds: month.rounds });
    }
    res.json({
      from, to,
      ...figures,
      received: round2(received.rows[0].amount),
      outstanding: round2(outstanding.rows[0].amount),
      months,
    });
  }));

  // Every rate recorded for an item in the period, oldest first, for the price-trend chart.
  app.get("/supply/reports/prices", auth, handle("SUPPLY PRICE TREND", async (req, res) => {
    const productId = Number(req.query.product_id);
    if (!productId) return res.status(400).json({ error: "Choose an item" });
    const from = isDate(req.query.from) ? req.query.from : "2000-01-01";
    const to = isDate(req.query.to) ? req.query.to : "2999-12-31";
    const { rows } = await db.query(
      `SELECT q.price, q.unit, q.recorded_at, v.id AS vendor_id, v.name AS vendor_name
       FROM supply_prices q JOIN supply_vendors v ON v.id = q.vendor_id
       WHERE q.product_id = $1 AND q.recorded_at::date BETWEEN $2 AND $3 ORDER BY q.recorded_at`,
      [productId, from, to]
    );
    res.json(rows.map((row) => ({ ...row, price: Number(row.price) })));
  }));
}
