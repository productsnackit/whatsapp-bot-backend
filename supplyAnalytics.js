/* =========================================================
    SUPPLY ANALYTICS
    Direct Supply (fruits) and Packaged Supply on one page, for a period of delivery dates
    (India dates), for both supplies or one: delivery dates, orders, companies, quantities,
    order value (quantity × the company's price, else the item's selling price), what the buyer
    spent, margin (only items with both a price and a purchase), invoices and payments, deliveries,
    how long the buyer took, and the same by day, by company and by item.
========================================================= */
let db = null;
const round2 = (value) => Math.round(Number(value) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : String(value).slice(0, 10));
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const addDays = (date, days) => { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };

export function initSupplyAnalytics(database) {
  db = database;
}

export function registerSupplyAnalyticsRoutes(app, { auth }) {
  app.get("/analytics/supply", auth, async (req, res) => {
    try {
      const today = istToday();
      const to = isDate(req.query.to) ? req.query.to : today;
      let from = isDate(req.query.from) ? req.query.from : null;
      if (!from) {
        if (req.query.all) {
          const { rows } = await db.query("SELECT MIN(delivery_date) AS first FROM supply_rounds");
          from = rows[0].first ? plainDate(rows[0].first) : to;
        } else from = addDays(to, -29);
      }
      const segment = ["fruits", "packaged"].includes(req.query.segment) ? req.query.segment : null;
      const { rows: rounds } = await db.query(
        `SELECT id, delivery_date, segment, status, sent_at, buyer_steps FROM supply_rounds
         WHERE delivery_date BETWEEN $1 AND $2 ${segment ? "AND segment = $3" : ""} ORDER BY delivery_date`,
        segment ? [from, to, segment] : [from, to]
      );
      const ids = rounds.map((round) => round.id);
      const roundById = new Map(rounds.map((round) => [round.id, { ...round, date: plainDate(round.delivery_date) }]));
      const [lines, purchases, invoices, deliveries, orders] = await Promise.all([
        db.query(
          `SELECT l.round_id, l.company_id, c.name AS company, l.product_id, COALESCE(p.name, l.raw_name) AS item, l.qty, l.unit,
                  p.unit AS product_unit, p.pack_size, p.sell_price, cp.price AS company_price
           FROM supply_lines l JOIN supply_companies c ON c.id = l.company_id
           LEFT JOIN supply_products p ON p.id = l.product_id
           LEFT JOIN supply_company_prices cp ON cp.company_id = l.company_id AND cp.product_id = l.product_id
             AND cp.unit = CASE WHEN l.unit = 'box' AND p.pack_size > 0 AND p.unit <> 'box' THEN p.unit ELSE l.unit END
           WHERE l.round_id = ANY($1)`,
          [ids]
        ),
        db.query("SELECT round_id, product_id, unit, qty, price FROM supply_purchases WHERE round_id = ANY($1)", [ids]),
        db.query("SELECT round_id, company_id, total, paid FROM supply_invoices WHERE cancelled_at IS NULL AND round_id = ANY($1)", [ids]).catch(() => ({ rows: [] })),
        db.query("SELECT round_id, company_id, status FROM supply_deliveries WHERE round_id = ANY($1)", [ids]).catch(() => ({ rows: [] })),
        db.query("SELECT round_id, company_id FROM supply_orders WHERE round_id = ANY($1)", [ids]),
      ]);

      const blank = () => ({ dates: 0, orders: 0, companies: new Set(), qty: {}, selling: 0, priced: 0, unpriced: 0, spent: 0, billed: 0, paid: 0, delivered: 0, deliveries: 0 });
      const totals = blank();
      const bySegment = { fruits: blank(), packaged: blank() };
      const daily = new Map();
      const companies = new Map();
      const items = new Map();
      const dayOf = (date) => {
        if (!daily.has(date)) daily.set(date, { date, fruits: 0, packaged: 0, fruits_orders: 0, packaged_orders: 0, spent: 0 });
        return daily.get(date);
      };
      const companyOf = (id, name) => {
        if (!companies.has(id)) companies.set(id, { id, name, segments: new Set(), dates: new Set(), orders: 0, qty: {}, selling: 0, billed: 0, paid: 0 });
        return companies.get(id);
      };
      for (const round of roundById.values()) {
        totals.dates += 1;
        bySegment[round.segment].dates += 1;
        dayOf(round.date);
      }
      for (const order of orders.rows) {
        const round = roundById.get(order.round_id);
        for (const target of [totals, bySegment[round.segment]]) { target.orders += 1; target.companies.add(order.company_id); }
        dayOf(round.date)[`${round.segment}_orders`] += 1;
      }
      // Each line: quantity (boxes counted in pieces when the item has pieces per box) and its value.
      const valueKey = new Map(); // round|product|unit → selling value, to compare with what was spent
      for (const line of lines.rows) {
        const round = roundById.get(line.round_id);
        const perBox = Number(line.pack_size) || 0;
        const boxed = line.unit === "box" && perBox > 0 && line.product_unit && line.product_unit !== "box";
        const unit = boxed ? line.product_unit : line.unit;
        const qty = boxed ? Number(line.qty) * perBox : Number(line.qty);
        const price = line.company_price != null ? Number(line.company_price) : line.sell_price != null && line.product_unit === unit ? Number(line.sell_price) : null;
        const value = price != null ? qty * price : 0;
        const company = companyOf(line.company_id, line.company);
        company.segments.add(round.segment);
        company.dates.add(round.date);
        company.qty[unit] = (company.qty[unit] || 0) + qty;
        company.selling += value;
        const itemKey = `${line.product_id || line.item}|${unit}`;
        const item = items.get(itemKey) || { name: line.item, unit, segment: round.segment, qty: 0, selling: 0, priced_qty: 0, spent: 0, bought: 0, companies: new Set() };
        item.qty += qty;
        item.selling += value;
        if (price != null) item.priced_qty += qty;
        item.companies.add(line.company_id);
        items.set(itemKey, item);
        for (const target of [totals, bySegment[round.segment]]) {
          target.qty[unit] = (target.qty[unit] || 0) + qty;
          target.selling += value;
          if (price != null) target.priced += 1; else target.unpriced += 1;
        }
        dayOf(round.date)[round.segment] += value;
        if (price != null) {
          const vKey = `${line.round_id}|${line.product_id}|${unit}`;
          const entry = valueKey.get(vKey) || { value: 0, qty: 0 };
          entry.value += value;
          entry.qty += qty;
          valueKey.set(vKey, entry);
        }
      }
      for (const order of orders.rows) companyOf(order.company_id, companies.get(order.company_id)?.name || "").orders += 1;
      let marginSelling = 0;
      let marginSpent = 0;
      const pricedPurchases = new Map(); // round|product|unit → spent
      for (const purchase of purchases.rows) {
        const round = roundById.get(purchase.round_id);
        const spent = Number(purchase.qty) * Number(purchase.price);
        for (const target of [totals, bySegment[round.segment]]) target.spent += spent;
        dayOf(round.date).spent += spent;
        const item = items.get(`${purchase.product_id}|${purchase.unit}`);
        if (item) { item.spent += spent; item.bought += Number(purchase.qty); }
        const vKey = `${purchase.round_id}|${purchase.product_id}|${purchase.unit}`;
        const entry = pricedPurchases.get(vKey) || { spent: 0, qty: 0 };
        entry.spent += spent;
        entry.qty += Number(purchase.qty);
        pricedPurchases.set(vKey, entry);
      }
      // Margin on what was bought: its quantity at the price it sells for, against what was paid
      // (only items with both a selling price and a purchase).
      for (const [vKey, bought] of pricedPurchases) {
        const sold = valueKey.get(vKey);
        if (!sold?.qty || !bought.qty) continue;
        const matched = Math.min(sold.qty, bought.qty);
        marginSelling += matched * (sold.value / sold.qty);
        marginSpent += matched * (bought.spent / bought.qty);
      }
      for (const invoice of invoices.rows) {
        const round = roundById.get(invoice.round_id);
        for (const target of [totals, bySegment[round.segment]]) { target.billed += Number(invoice.total); target.paid += Number(invoice.paid); }
        const company = companies.get(invoice.company_id);
        if (company) { company.billed += Number(invoice.total); company.paid += Number(invoice.paid); }
      }
      for (const delivery of deliveries.rows) {
        const round = roundById.get(delivery.round_id);
        for (const target of [totals, bySegment[round.segment]]) {
          target.deliveries += 1;
          if (delivery.status === "Delivered") target.delivered += 1;
        }
      }
      // How long the buyer took from getting the list to having the goods.
      const buyerHours = rounds
        .map((round) => (round.sent_at && round.buyer_steps?.["Goods received"] ? (new Date(round.buyer_steps["Goods received"]) - new Date(round.sent_at)) / 3600000 : null))
        .filter((hours) => hours != null && hours >= 0);

      const finish = (entry) => ({
        dates: entry.dates, orders: entry.orders, companies: entry.companies.size,
        qty: Object.fromEntries(Object.entries(entry.qty).map(([unit, value]) => [unit, round2(value)])),
        selling: round2(entry.selling), unpriced_lines: entry.unpriced, spent: round2(entry.spent),
        billed: round2(entry.billed), paid: round2(entry.paid), outstanding: round2(entry.billed - entry.paid),
        delivered: entry.delivered, deliveries: entry.deliveries,
      });
      res.json({
        range: { from, to },
        segment: segment || "all",
        totals: {
          ...finish(totals),
          margin: marginSelling ? round2(marginSelling - marginSpent) : null,
          margin_percent: marginSelling ? round2(((marginSelling - marginSpent) / marginSelling) * 100) : null,
          buyer_hours: buyerHours.length ? round2(buyerHours.reduce((sum, hours) => sum + hours, 0) / buyerHours.length) : null,
        },
        by_segment: { fruits: finish(bySegment.fruits), packaged: finish(bySegment.packaged) },
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({ ...day, fruits: round2(day.fruits), packaged: round2(day.packaged), spent: round2(day.spent) })),
        companies: [...companies.values()].map((company) => ({
          name: company.name, segments: [...company.segments], dates: company.dates.size, orders: company.orders,
          qty: Object.fromEntries(Object.entries(company.qty).map(([unit, value]) => [unit, round2(value)])),
          selling: round2(company.selling), billed: round2(company.billed), outstanding: round2(company.billed - company.paid),
        })).sort((a, b) => b.selling - a.selling || b.orders - a.orders),
        items: [...items.values()].map((item) => ({
          name: item.name, unit: item.unit, segment: item.segment, qty: round2(item.qty), companies: item.companies.size,
          selling: round2(item.selling), spent: round2(item.spent), bought: round2(item.bought),
          avg_sell: item.priced_qty ? round2(item.selling / item.priced_qty) : null,
          avg_buy: item.bought ? round2(item.spent / item.bought) : null,
        })).sort((a, b) => b.selling - a.selling || b.qty - a.qty),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.log("SUPPLY ANALYTICS ERROR:", err.message);
      res.status(500).json({ error: "Could not load supply analytics" });
    }
  });
}
