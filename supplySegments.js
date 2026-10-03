/* =========================================================
    DIRECT SUPPLY · FRUITS AND PACKAGED
    Fruits and packaged products (dairy, snacks, drinks, pantry …) are run as two separate
    supplies, each with its own dashboard page (Direct Supply / Packaged Supply), delivery
    dates, master sheet, buyer list and DCs:
      • every item is "fruits" or "packaged" (worked out from its name, changeable in Items);
      • a company admin's one mixed message is split: each part goes to that supply's order for
        the same date;
      • a company belongs to the supplies it has ordered from (or is set to), so "not ordered
        yet" and "everyone has ordered" only count the companies of that supply;
      • orders saved before the split (mixed dates) are split once: their packaged lines move to
        a packaged delivery for the same date (dates with invoices or DCs are left as they are).
========================================================= */
import { cleanName } from "./supplyParse.js";

export const SEGMENTS = ["fruits", "packaged"];
// For WhatsApp texts (📦 is removed by sendWhatsApp, so 🥫 is used).
export const SEGMENT_LABEL = { fruits: "🍎 Fruits", packaged: "🥫 Packaged" };
let db = null;

// Fresh fruit (and the few fresh things bought with it). Anything else is packaged.
const FRUIT_WORDS = new Set(`apple apples banana bananas robusta yelakki elakki orange oranges mandarin kinnow mosambi sweet lime guava guavas
  pear pears grapes grape pomegranate anar papaya pineapple watermelon muskmelon melon mango mangoes kiwi kiwis plum plums chikoo sapota
  strawberry strawberries blueberry blueberries cherry cherries peach peaches apricot litchi lychee dragon fig figs jackfruit custard
  avocado dates coconut tender pomelo berries berry fruit fruits cut ginger lemon lemons lime limes cucumber carrot tomato beetroot`.split(/\s+/).filter(Boolean));
// Words that mean it's packaged even with a fruit word in it ("Paper Boat Mixed Fruit", "Fruit & Nut Muesli").
const PACKAGED_WORDS = /\b(juice|drink|boat|paper|tropicana|real|maaza|slice|frooti|muesli|cornflakes|kellogg|bar|bars|chips|wafers|cookies|biscuit|biscuits|cake|jam|yogurt|yoghurt|curd|milk|milkshake|shake|lassi|buttermilk|chocolate|candy|toffee|bites|nut|nuts|mix|makhana|namkeen|bhujia|protein|powder|dried|dry|ml|ltr|bottle|can|pet|tetra|pack|pkt|sachet|epigamia|nestle|amul|britannia|parle|lays|haldiram|coke|pepsi|sprite|limca|fanta|thums|thumsup|water|tea|coffee|sugar|honey)\b/i;

export function segmentOfName(name) {
  const text = String(name || "").toLowerCase();
  if (PACKAGED_WORDS.test(text)) return "packaged";
  // "Coconut Water" is packaged (above); "Tender Coconut" and "Cut Fruits" are fruit.
  const words = cleanName(text).split(" ").filter((word) => !/\d/.test(word));
  return words.some((word) => FRUIT_WORDS.has(word)) ? "fruits" : "packaged";
}

export const validSegment = (value) => (SEGMENTS.includes(value) ? value : "fruits");

/* The supply each line belongs to: its item's setting when the name is a known item (or one of
   its spellings), else worked out from the name. lines: [{ name, product_id? }] */
export async function segmentsOfLines(lines) {
  const { rows } = await db.query("SELECT id, key, aliases, segment FROM supply_products");
  const byKey = new Map();
  const byId = new Map(rows.map((row) => [row.id, row.segment]));
  for (const row of rows) {
    byKey.set(row.key, row.segment);
    for (const alias of row.aliases || []) byKey.set(alias, row.segment);
  }
  return lines.map((line) => (line.product_id && byId.get(Number(line.product_id))) || byKey.get(cleanName(line.name)) || segmentOfName(line.name));
}

// Splits lines into { fruits: [...], packaged: [...] } (only the supplies that have lines).
export async function splitBySegment(lines) {
  const segments = await segmentsOfLines(lines);
  const parts = {};
  lines.forEach((line, index) => { (parts[segments[index]] ||= []).push(line); });
  return parts;
}

// A company orders from this supply from now on (it appears in that page's "not ordered yet").
export async function addCompanySegment(companyId, segment) {
  await db.query("UPDATE supply_companies SET segments = array_append(segments, $2) WHERE id = $1 AND NOT ($2 = ANY(segments))", [companyId, validSegment(segment)]).catch(() => {});
}

export async function ensureSupplySegments(database) {
  db = database;
  await db.query(`
    ALTER TABLE supply_rounds ADD COLUMN IF NOT EXISTS segment TEXT NOT NULL DEFAULT 'fruits';
    ALTER TABLE supply_products ADD COLUMN IF NOT EXISTS segment TEXT;
    ALTER TABLE supply_companies ADD COLUMN IF NOT EXISTS segments TEXT[] NOT NULL DEFAULT '{}';
  `);
  const { rows: items } = await db.query("SELECT id, name FROM supply_products WHERE segment IS NULL");
  for (const item of items) await db.query("UPDATE supply_products SET segment = $2 WHERE id = $1", [item.id, segmentOfName(item.name)]);
}

/* Once, after the past orders are saved: packaged lines in mixed (fruits) dates move to a
   packaged delivery for the same date; then each company gets the supplies it has ordered from. */
export async function splitExistingRounds() {
  const { rows: done } = await db.query("SELECT 1 FROM app_settings WHERE key = 'supply_segments_v1'");
  if (!done.length) {
    const { rows: rounds } = await db.query(
      `SELECT r.* FROM supply_rounds r WHERE r.segment = 'fruits'
         AND NOT EXISTS (SELECT 1 FROM supply_invoices i WHERE i.round_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM supply_challans c WHERE c.round_id = r.id)`
    ).catch(() => ({ rows: [] }));
    let moved = 0;
    for (const round of rounds) {
      const { rows: lines } = await db.query(
        `SELECT l.id, l.order_id, l.raw_name, l.product_id, p.segment FROM supply_lines l
         LEFT JOIN supply_products p ON p.id = l.product_id WHERE l.round_id = $1`,
        [round.id]
      );
      const packaged = lines.filter((line) => (line.segment || segmentOfName(line.raw_name)) === "packaged");
      if (!packaged.length) continue;
      const { rows: existing } = await db.query("SELECT id FROM supply_rounds WHERE delivery_date = $1 AND segment = 'packaged' ORDER BY id LIMIT 1", [round.delivery_date]);
      let target = existing[0]?.id;
      if (!target) {
        const { rows } = await db.query(
          `INSERT INTO supply_rounds (delivery_date, title, status, created_by, segment, buyer_status, buyer_steps, sent_at, sent_to)
           VALUES ($1, $2, $3, $4, 'packaged', $5, $6, $7, $8) RETURNING id`,
          [round.delivery_date, /^fruits?$/i.test(round.title || "") ? "Packaged" : round.title, round.status, round.created_by, round.buyer_status, round.buyer_steps || {}, round.sent_at, round.sent_to]
        );
        target = rows[0].id;
        await db.query("UPDATE supply_rounds SET ref = 'PS-' || LPAD(id::text, 4, '0') WHERE id = $1", [target]);
      }
      const byOrder = new Map();
      for (const line of packaged) (byOrder.get(line.order_id) || byOrder.set(line.order_id, []).get(line.order_id)).push(line.id);
      for (const [orderId, lineIds] of byOrder) {
        const total = lines.filter((line) => line.order_id === orderId).length;
        if (total === lineIds.length) {
          await db.query("UPDATE supply_orders SET round_id = $2 WHERE id = $1", [orderId, target]);
          await db.query("UPDATE supply_lines SET round_id = $2 WHERE order_id = $1", [orderId, target]);
        } else {
          const { rows: copy } = await db.query(
            `INSERT INTO supply_orders (round_id, company_id, source, raw_text, file_name, created_by, submitted_by, note, created_at)
             SELECT $2, company_id, source, raw_text, file_name, created_by, submitted_by, note, created_at FROM supply_orders WHERE id = $1 RETURNING id`,
            [orderId, target]
          );
          await db.query("UPDATE supply_lines SET order_id = $2, round_id = $3 WHERE id = ANY($1)", [lineIds, copy[0].id, target]);
        }
      }
      // What was bought for those items, and the deliveries, go with them.
      await db.query(
        `UPDATE supply_purchases pu SET round_id = $2 FROM supply_products p
         WHERE pu.round_id = $1 AND p.id = pu.product_id AND p.segment = 'packaged'`,
        [round.id, target]
      );
      await db.query(
        `INSERT INTO supply_deliveries (round_id, company_id, status, delivered_at, received_by)
         SELECT $2, d.company_id, d.status, d.delivered_at, d.received_by FROM supply_deliveries d
         WHERE d.round_id = $1 AND d.company_id IN (SELECT company_id FROM supply_orders WHERE round_id = $2)
         ON CONFLICT (round_id, company_id) DO NOTHING`,
        [round.id, target]
      ).catch(() => {});
      await db.query(
        `DELETE FROM supply_deliveries d WHERE d.round_id = $1
         AND NOT EXISTS (SELECT 1 FROM supply_orders o WHERE o.round_id = $1 AND o.company_id = d.company_id)`,
        [round.id]
      ).catch(() => {});
      // A date left with no orders at all (it was all packaged) is removed.
      const { rows: left } = await db.query("SELECT 1 FROM supply_orders WHERE round_id = $1 LIMIT 1", [round.id]);
      if (!left.length) await db.query("DELETE FROM supply_rounds WHERE id = $1", [round.id]);
      moved += packaged.length;
    }
    await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_segments_v1', $1, NOW()) ON CONFLICT (key) DO NOTHING", [String(moved)]);
    if (moved) console.log(`📦 Packaged Supply: moved ${moved} packaged line(s) out of fruit dates`);
  }
  // Each company belongs to the supplies it has ordered from.
  await db.query(`
    UPDATE supply_companies c SET segments = ARRAY(
      SELECT DISTINCT s FROM unnest(c.segments || ARRAY(SELECT DISTINCT r.segment FROM supply_orders o JOIN supply_rounds r ON r.id = o.round_id WHERE o.company_id = c.id)) AS s
    )`).catch((err) => console.log("SUPPLY COMPANY SEGMENTS:", err.message));
}
