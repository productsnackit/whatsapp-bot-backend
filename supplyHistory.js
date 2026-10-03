/* =========================================================
    DIRECT SUPPLY · PAST ORDERS
    Orders from before the dashboard, saved once so reports, history and "last time" quantities
    include them. September 2026 fruit sheet: each date becomes a delivery date (marked
    Delivered), each row that location's order in kg. A location is added if it's missing; a
    location that already has an order on that date is left as it is. Nothing is sent to anyone.
========================================================= */
import { saveOrderLines } from "./directSupply.js";

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
