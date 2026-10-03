/* =========================================================
    DIRECT SUPPLY · PAST ORDERS
    Orders from before the dashboard, saved once so reports, history and "last time" quantities
    include them. September 2026 fruit sheet: each date becomes a delivery date (marked
    Delivered), each row that location's order in kg. A location is added if it's missing; a
    location that already has an order on that date is left as it is. Nothing is sent to anyone.
========================================================= */
import { saveOrderLines } from "./directSupply.js";
import { SEPT_2026_ORDERS, SEPT_2026_COMPANY_PRICES, SEPT_2026_SELL_PRICES } from "./supplyHistoryData.js";

const FRUITS = ["Apple", "Robusta Banana", "Yellow Banana", "Guava", "Pears", "Orange", "Red Grapes"];
// date, location, then kg in the order of FRUITS
const SEPT_2026 = [
  ["2026-09-05", "Fivetron", 10, 6, 6, 0, 0, 0, 0], ["2026-09-05", "Solera", 20, 15, 0, 0, 0, 0, 0],
  ["2026-09-07", "Anthropic", 2, 2, 0, 0, 0, 0, 0], ["2026-09-07", "Fleek", 3, 0, 3, 0, 0, 3, 0],
  ["2026-09-10", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-12", "Solera", 20, 15, 0, 0, 0, 0, 0], ["2026-09-12", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-16", "Anthropic", 2, 0, 0, 2, 0, 0, 0], ["2026-09-16", "Fleek", 3, 0, 3, 0, 0, 3, 0],
  ["2026-09-17", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-19", "Solera", 20, 15, 0, 0, 0, 0, 0], ["2026-09-19", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-21", "Anthropic", 0, 2, 0, 0, 0, 2, 0], ["2026-09-21", "Fleek", 3, 0, 3, 0, 0, 3, 0],
  ["2026-09-23", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-26", "Solera", 20, 15, 0, 0, 0, 0, 0], ["2026-09-26", "Fivetron", 5, 3, 3, 0, 0, 0, 0],
  ["2026-09-28", "Fleek", 3, 0, 3, 0, 0, 3, 0], ["2026-09-28", "Anthropic", 0, 0, 0, 2, 0, 0, 2],
  ["2026-09-30", "Fivetron", 5, 3, 3, 0, 0, 0, 0], ["2026-09-30", "Anthropic", 0, 2, 0, 0, 0, 2, 0],
];

const key = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function savePastOrders(db) {
  const { rows: done } = await db.query("SELECT 1 FROM app_settings WHERE key = 'supply_history_sept2026'");
  if (done.length) return;
  const companies = new Map((await db.query("SELECT id, name FROM supply_companies")).rows.map((row) => [key(row.name), row.id]));
  const rounds = new Map();
  let saved = 0;
  for (const [date, location, ...amounts] of SEPT_2026) {
    let companyId = companies.get(key(location));
    if (!companyId) {
      const { rows } = await db.query("INSERT INTO supply_companies (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [location]);
      companyId = rows[0].id;
      companies.set(key(location), companyId);
    }
    if (!rounds.has(date)) {
      const { rows: existing } = await db.query("SELECT id FROM supply_rounds WHERE delivery_date = $1 ORDER BY id LIMIT 1", [date]);
      let roundId = existing[0]?.id;
      if (!roundId) {
        const { rows } = await db.query("INSERT INTO supply_rounds (delivery_date, title, status, created_by) VALUES ($1, 'Fruits', 'Delivered', 'Imported (Sept 2026 sheet)') RETURNING id", [date]);
        roundId = rows[0].id;
        await db.query("UPDATE supply_rounds SET ref = 'DS-' || LPAD(id::text, 4, '0') WHERE id = $1", [roundId]);
      }
      rounds.set(date, roundId);
    }
    const roundId = rounds.get(date);
    const { rows: already } = await db.query("SELECT 1 FROM supply_orders WHERE round_id = $1 AND company_id = $2", [roundId, companyId]);
    if (already.length) continue;
    const lines = FRUITS.map((name, index) => ({ name, qty: amounts[index], unit: "kg" })).filter((line) => line.qty > 0);
    if (!lines.length) continue;
    const { rows: order } = await db.query(
      "INSERT INTO supply_orders (round_id, company_id, source, file_name, created_by) VALUES ($1, $2, 'file', 'Sept 2026 fruit sheet', 'Imported') RETURNING id",
      [roundId, companyId]
    );
    await saveOrderLines(order[0].id, roundId, companyId, lines);
    // Delivered in full, as the sheet records.
    await db.query(
      `INSERT INTO supply_deliveries (round_id, company_id, status, delivered_at) VALUES ($1, $2, 'Delivered', $3::date + TIME '12:00')
       ON CONFLICT (round_id, company_id) DO NOTHING`,
      [roundId, companyId, date]
    ).catch(() => {});
    saved += 1;
  }
  await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_history_sept2026', $1, NOW()) ON CONFLICT (key) DO NOTHING", [String(saved)]);
  console.log(`🍎 Direct Supply: saved ${saved} past orders from the Sept 2026 fruit sheet`);
}

/* The rest of the September 2026 workbook (Cred Fruits, Yogurts, Uipath Fruits, Uipath cities),
   saved once. Each sheet's order for a company and date is its own order (so a company's fruits
   and yogurts on the same day are both kept); amounts paid on Zepto/Swiggy/Blinkit become
   purchases from that app; Uipath's per kg rates become Uipath's selling prices; yogurt MRPs
   become the yogurts' selling price when none is set. */

export async function saveSept2026Workbook(db) {
  const { rows: done } = await db.query("SELECT 1 FROM app_settings WHERE key = 'supply_history_sept2026_workbook'");
  if (done.length) return;
  const companies = new Map((await db.query("SELECT id, name FROM supply_companies")).rows.map((row) => [key(row.name), row.id]));
  const companyId = async (name) => {
    if (companies.has(key(name))) return companies.get(key(name));
    const { rows } = await db.query("INSERT INTO supply_companies (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [name]);
    companies.set(key(name), rows[0].id);
    return rows[0].id;
  };
  const vendors = new Map();
  const vendorId = async (name) => {
    if (vendors.has(name)) return vendors.get(name);
    const { rows } = await db.query("INSERT INTO supply_vendors (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id", [name]);
    vendors.set(name, rows[0].id);
    return rows[0].id;
  };
  const rounds = new Map();
  const roundId = async (date) => {
    if (rounds.has(date)) return rounds.get(date);
    const { rows: existing } = await db.query("SELECT id FROM supply_rounds WHERE delivery_date = $1 ORDER BY id LIMIT 1", [date]);
    let id = existing[0]?.id;
    if (!id) {
      const { rows } = await db.query("INSERT INTO supply_rounds (delivery_date, title, status, created_by) VALUES ($1, 'Sept 2026', 'Delivered', 'Imported (Sept 2026 workbook)') RETURNING id", [date]);
      id = rows[0].id;
      await db.query("UPDATE supply_rounds SET ref = 'DS-' || LPAD(id::text, 4, '0') WHERE id = $1", [id]);
    }
    rounds.set(date, id);
    return id;
  };
  const productOf = new Map(); // item name → product id (as matched when the order was saved)
  let saved = 0;
  let purchases = 0;
  for (const order of SEPT_2026_ORDERS) {
    const company = await companyId(order.company);
    const round = await roundId(order.date);
    const fileName = `Sept 2026 workbook · ${order.sheet}`;
    const { rows: already } = await db.query("SELECT 1 FROM supply_orders WHERE round_id = $1 AND company_id = $2 AND file_name = $3", [round, company, fileName]);
    if (already.length) continue;
    const dc = [...new Set(order.lines.map((line) => line[4]).filter(Boolean))].join(", ");
    const { rows: created } = await db.query(
      "INSERT INTO supply_orders (round_id, company_id, source, file_name, raw_text, created_by) VALUES ($1, $2, 'file', $3, $4, 'Imported') RETURNING id",
      [round, company, fileName, dc ? `DC ${dc}` : null]
    );
    await saveOrderLines(created[0].id, round, company, order.lines.map(([name, qty, unit]) => ({ name, qty, unit })));
    const { rows: lines } = await db.query("SELECT raw_name, product_id, unit FROM supply_lines WHERE order_id = $1", [created[0].id]);
    for (const line of lines) if (line.product_id) productOf.set(key(line.raw_name), line.product_id);
    // Bought on a quick-commerce app: the amount paid is the purchase.
    for (const [name, qty, unit, amount] of order.lines) {
      const productId = productOf.get(key(name));
      if (!amount || !productId) continue;
      await db.query(
        "INSERT INTO supply_purchases (round_id, product_id, vendor_id, unit, qty, price, notes, bought_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Imported')",
        [round, productId, await vendorId(order.vendor || "Online order"), unit, qty, Math.round((amount / qty) * 100) / 100, `${order.company} · paid ₹${amount}`]
      );
      purchases += 1;
    }
    await db.query(
      `INSERT INTO supply_deliveries (round_id, company_id, status, delivered_at) VALUES ($1, $2, 'Delivered', $3::date + TIME '12:00')
       ON CONFLICT (round_id, company_id) DO NOTHING`,
      [round, company, order.date]
    ).catch(() => {});
    saved += 1;
  }
  for (const [name, unit, price] of SEPT_2026_SELL_PRICES) {
    const productId = productOf.get(key(name));
    if (productId) await db.query("UPDATE supply_products SET sell_price = $3 WHERE id = $1 AND unit = $2 AND sell_price IS NULL", [productId, unit, price]);
  }
  for (const [company, name, unit, price] of SEPT_2026_COMPANY_PRICES) {
    const productId = productOf.get(key(name));
    if (productId) {
      await db.query("INSERT INTO supply_company_prices (company_id, product_id, unit, price) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [await companyId(company), productId, unit, price]);
    }
  }
  await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_history_sept2026_workbook', $1, NOW()) ON CONFLICT (key) DO NOTHING", [`${saved} orders, ${purchases} purchases`]);
  console.log(`📦 Direct Supply: saved ${saved} orders and ${purchases} purchases from the Sept 2026 workbook`);
}
