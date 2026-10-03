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

/* The machine named in some text (screenshot text, a UPI ID, or what a customer typed).
   Only IDs that are in the list count, so a random "vv12" never matches. */
export async function findMachine(text) {
  const machines = await allMachines();
  if (!machines.length) return null;
  const byCode = new Map(machines.map((machine) => [machine.code, machine]));
  // "snackit" right before the ID (as in the UPI name / ID), or an ID with 4+ digits ("VV0046").
  const patterns = [/snack\s*it\s*(av|vv)\s?-?\s?(\d{1,6})(?!\d)/gi, /\b(av|vv)\s?-?\s?(\d{4,6})(?!\d)/gi];
  for (const pattern of patterns) {
    for (const found of String(text || "").matchAll(pattern)) {
      const machine = byCode.get(machineKey(found[1], found[2]));
      if (machine) return machine;
    }
  }
  return null;
}
