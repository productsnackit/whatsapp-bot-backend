/* =========================================================
    MACHINE IDs
    Every Snackit vending machine has an ID (av00001, vv00002 …). Customers pay the machine on
    UPI, so the payment screenshot shows it in "paid to" (e.g. snackitvv0002@ybl or "Snackit
    VV00002"). Reading it tells us exactly which machine and location, which is surer than the
    few words a customer types. The list (machineList.js) is saved here on every start; each
    machine is linked to the Refill Audit location with the same name when there is one.
    "snackitvv0002", "VV 0002" and "vv00002" are the same machine (letters + number).
========================================================= */
import { MACHINE_LIST } from "./machineList.js";

let db = null;
let cache = { at: 0, rows: [] };

export const machineKey = (letters, number) => `${String(letters).toLowerCase()}${String(Number(number)).padStart(5, "0")}`;

export async function ensureMachines(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS vending_machines (
      code TEXT PRIMARY KEY,
      location TEXT NOT NULL,
      address TEXT,
      site_id INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS paid_machine TEXT").catch((err) => console.log("MACHINES TICKET COLUMN:", err.message));
  for (const [location, id, address] of MACHINE_LIST) {
    const match = String(id).match(/^([a-z]+)0*(\d+)$/i);
    if (!match) continue;
    await db.query(
      `INSERT INTO vending_machines (code, location, address) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET location = EXCLUDED.location, address = EXCLUDED.address, updated_at = NOW()`,
      [machineKey(match[1], match[2]), location, address || null]
    );
  }
  cache.at = 0;
}

export async function allMachines() {
  if (!db) return [];
  if (Date.now() - cache.at < 60000) return cache.rows;
  const { rows } = await db.query(
    `SELECT m.code, m.location, m.address, m.site_id, a.name AS site_name
     FROM vending_machines m LEFT JOIN audit_locations a ON a.id = m.site_id ORDER BY m.code`
  ).catch(() => ({ rows: [] }));
  cache = { at: Date.now(), rows };
  return rows;
}

export async function linkMachine(code, siteId) {
  await db.query("UPDATE vending_machines SET site_id = $2 WHERE code = $1", [code, siteId]);
  cache.at = 0;
}

/* Machine IDs in some text (screenshot text, a UPI ID, or what a customer typed), allowing
   the usual reading mistakes in screenshots: "VV" read as "W", "O" for 0, "I"/"l" for 1,
   "S" for 5, "B" for 8, spaces or dashes inside. After "snackit" the ID is taken as written;
   without it, only a clean ID with 4+ digits counts ("VV0046"), so random text never matches.
   Returns codes like "vv00002" in the order found. */
const DIGIT_FIX = { o: "0", d: "0", q: "0", i: "1", l: "1", "|": "1", "!": "1", s: "5", b: "8", z: "2", g: "6" };
export function machineCodesIn(text) {
  const raw = String(text || "");
  const codes = [];
  const after = /sn[a@4]\s?[ck]{1,2}\s?[i1l|!]\s?t\s*[-_.:]?\s*(a\s?v|v\s?v|w|v\s?w|w\s?v|\\\/\s?v|v\s?\\\/|u\s?v|v\s?u)\s*[-_.]?\s*([0-9oOdDqQiIlL|!sSbBzZgG]{1,6})(?![0-9a-z])/gi;
  for (const found of raw.matchAll(after)) {
    const letters = found[1].replace(/\s/g, "").toLowerCase().startsWith("a") ? "av" : "vv";
    const digits = found[2].toLowerCase().replace(/[^0-9]/g, (char) => DIGIT_FIX[char] ?? "");
    if (digits && /^\d+$/.test(digits) && /\d/.test(found[2])) codes.push(machineKey(letters, digits));
  }
  for (const found of raw.matchAll(/\b(av|vv|w)\s?-?\s?(\d{4,6})(?!\d)/gi)) {
    codes.push(machineKey(found[1].toLowerCase() === "av" ? "av" : "vv", found[2]));
  }
  return [...new Set(codes)];
}

/* The machine in some text: the first ID that is in the list, else the first ID written after
   "snackit" (shown as "not in the list"). */
export async function findMachine(text, { allowUnknown = false } = {}) {
  const machines = await allMachines();
  const byCode = new Map(machines.map((machine) => [machine.code, machine]));
  const codes = machineCodesIn(text);
  const known = codes.map((code) => byCode.get(code)).find(Boolean);
  if (known) return known;
  if (allowUnknown && codes.length && /sn[a@4]\s?[ck]{1,2}\s?[i1l|!]\s?t/i.test(String(text))) return { code: codes[0], location: null, site_id: null, unknown: true };
  return null;
}

/* Analytics: complaints per machine (machine ID read from the payment screenshot) today, this
   month and all time (India dates), with the last complaint and the most common issue.
   IDs read from screenshots that aren't in the machine list are included too. */
export function registerMachineRoutes(app, { auth }) {
  app.get("/analytics/machines", auth, async (req, res) => {
    try {
      const { rows } = await db.query(`
        WITH t AS (
          SELECT paid_machine AS code, created_at, (created_at AT TIME ZONE 'Asia/Kolkata') AS ist, main_issue,
                 LOWER(COALESCE(status, '')) AS status
          FROM tickets WHERE paid_machine IS NOT NULL
        ), today AS (SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS d)
        SELECT t.code,
               m.location, m.address,
               COUNT(*) FILTER (WHERE t.ist::date = (SELECT d FROM today))::int AS today,
               COUNT(*) FILTER (WHERE date_trunc('month', t.ist) = date_trunc('month', (SELECT d FROM today)::timestamp))::int AS month,
               COUNT(*)::int AS all_time,
               COUNT(*) FILTER (WHERE t.status IN ('refunded', 'auto_refunded'))::int AS refunded,
               MAX(t.created_at) AS last_at,
               MODE() WITHIN GROUP (ORDER BY t.main_issue) AS top_issue
        FROM t LEFT JOIN vending_machines m ON m.code = t.code
        GROUP BY t.code, m.location, m.address
        ORDER BY month DESC, all_time DESC, t.code`);
      const { rows: count } = await db.query("SELECT COUNT(*)::int AS machines FROM vending_machines");
      res.json({ machines: rows, machine_count: count[0].machines });
    } catch (err) {
      console.log("MACHINE ANALYTICS ERROR:", err.message);
      res.status(500).json({ error: "Could not load machine analytics" });
    }
  });
}
