/* =========================================================
    LIVE STOCK (vending machines)
    How much is in each machine today, without refillers doing anything new:
      • sales come from the Wendor transactions report the office uploads each day (only
        completed vends count; failed / started / not started don't). Uploading a report again,
        or one that overlaps another, replaces those days, so nothing is counted twice;
      • every machine is refilled at a fixed time: the office sets its refill days and time once
        (e.g. Mon–Sat 9:00 am), and the machine counts as filled back up at each of those times.
        Refillers are not involved. A refill that didn't happen can be skipped for that day,
        and an extra one marked by hand;
      • each slot's size (how many fit) is set once by the office; until then it is estimated
        from the most ever sold from that slot between two refills (marked "estimated");
      • the office can also type an actual count for a slot (a spot check) or mark a machine as
        refilled by hand; the latest of these wins.
    Stock in a slot = (slot size at its last refill, or the last counted number) − completed
    vends from that slot since then. Products in a slot change often, so the product shown for a
    slot is the last one sold from it (an estimate). Each Wendor machine is linked to its Refill
    Schedule location by name, or by hand.
    Sales are kept per 10 minutes (day, slot, product) so "since the refill" is exact enough.
========================================================= */
import XLSX from "xlsx";
import { hasPage } from "./accessControl.js";
import { matchSite } from "./siteMatcher.js";

let db = null;
const pad = (n) => String(n).padStart(2, "0");
const IST = 330 * 60000;
const toIst = (date) => new Date(new Date(date).getTime() + IST);
const istDay = (date = new Date()) => toIst(date).toISOString().slice(0, 10);
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : String(value).slice(0, 10));
const addDays = (date, days) => { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };
// A sale's 10-minute bucket (0–143) in India time; a moment → (day, bucket) the same way.
const bucketOf = (date) => { const ist = toIst(date); return { day: ist.toISOString().slice(0, 10), bucket: ist.getUTCHours() * 6 + Math.floor(ist.getUTCMinutes() / 10) }; };
const after = (sale, mark) => sale.day > mark.day || (sale.day === mark.day && sale.bucket >= mark.bucket);
const LOW_DAYS = 1; // less than a day of stock left at the current pace

export async function ensureMachineStock(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_machines (
      id SERIAL PRIMARY KEY, wendor_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      location_id INTEGER, linked_by TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE stock_machines
      ADD COLUMN IF NOT EXISTS refill_days SMALLINT[],
      ADD COLUMN IF NOT EXISTS refill_time TEXT;
    CREATE TABLE IF NOT EXISTS stock_slots (
      machine_id INTEGER NOT NULL REFERENCES stock_machines(id) ON DELETE CASCADE,
      position TEXT NOT NULL, capacity INTEGER, capacity_by TEXT,
      PRIMARY KEY (machine_id, position)
    );
    CREATE TABLE IF NOT EXISTS stock_sales (
      day DATE NOT NULL, bucket SMALLINT NOT NULL, machine_id INTEGER NOT NULL REFERENCES stock_machines(id) ON DELETE CASCADE,
      position TEXT NOT NULL, product TEXT NOT NULL, qty INTEGER NOT NULL, amount NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (day, bucket, machine_id, position, product)
    );
    CREATE INDEX IF NOT EXISTS stock_sales_machine_idx ON stock_sales (machine_id, day);
    CREATE TABLE IF NOT EXISTS stock_marks (
      id SERIAL PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES stock_machines(id) ON DELETE CASCADE,
      position TEXT, kind TEXT NOT NULL, qty INTEGER, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), by TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_uploads (
      id SERIAL PRIMARY KEY, file_name TEXT, day_from DATE, day_to DATE, rows INTEGER, sold INTEGER, skipped INTEGER,
      machines TEXT[], uploaded_by TEXT, uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/* ---------- Reading a Wendor transactions report ---------- */
function readReport(base64) {
  const workbook = XLSX.read(Buffer.from(String(base64).replace(/^data:[^,]+,/, ""), "base64"), { type: "buffer" });
  const rows = [];
  for (const name of workbook.SheetNames) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false });
    const headerAt = sheet.findIndex((row) => row.some((cell) => /machine id/i.test(String(cell))) && row.some((cell) => /position/i.test(String(cell))));
    if (headerAt < 0) continue;
    const header = sheet[headerAt].map((cell) => String(cell).trim().toLowerCase());
    const col = (label) => header.indexOf(label);
    const at = { date: col("date"), time: col("time"), order: col("order id"), product: col("product name"), qty: col("quantity"), amount: col("amount"), position: col("position"), status: col("vend status"), comment: col("vend comment"), machine: col("machine name"), machineId: col("machine id") };
    if ([at.date, at.product, at.position, at.machineId].some((index) => index < 0)) continue;
    for (const row of sheet.slice(headerAt + 1)) rows.push(Object.fromEntries(Object.entries(at).map(([key, index]) => [key, index >= 0 ? String(row[index] ?? "").trim() : ""])));
  }
  return rows;
}

// "01/09/2026" + "12:24:46 AM" (India time) → { day, bucket }
function whenOf(date, time) {
  const d = String(date).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!d) return null;
  const year = d[3].length === 2 ? `20${d[3]}` : d[3];
  const day = `${year}-${pad(d[2])}-${pad(d[1])}`;
  const t = String(time).match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  let hour = t ? Number(t[1]) : 0;
  if (t?.[3]) hour = (hour % 12) + (/pm/i.test(t[3]) ? 12 : 0);
  const minute = t ? Number(t[2]) : 0;
  return { day, bucket: hour * 6 + Math.floor(minute / 10) };
}

export async function importReport({ base64, fileName, by }) {
  const rows = readReport(base64);
  if (!rows.length) throw new Error("This doesn't look like a Wendor transactions report (no Machine ID / Position columns).");
  const seen = new Set();
  const sales = new Map();
  const days = new Set();
  const machines = new Map();
  let skipped = 0;
  for (const row of rows) {
    const when = whenOf(row.date, row.time);
    if (!when || !row.machineId) { skipped += 1; continue; }
    days.add(when.day);
    machines.set(row.machineId, row.machine || row.machineId);
    // Only a completed vend took an item out (failed, started, not started didn't).
    const done = /^completed$/i.test(row.status) || /^vend_success$/i.test(row.comment);
    if (!done) { skipped += 1; continue; }
    if (row.order && seen.has(row.order)) continue; // the same order twice in a file
    if (row.order) seen.add(row.order);
    const qty = Math.max(1, Math.round(Number(row.qty) || 1));
    const key = `${when.day}|${when.bucket}|${row.machineId}|${row.position}|${row.product}`;
    const entry = sales.get(key) || { ...when, wendor: row.machineId, position: row.position, product: row.product.replace(/\s+/g, " "), qty: 0, amount: 0 };
    entry.qty += qty;
    entry.amount += Number(row.amount) || 0;
    sales.set(key, entry);
  }
  if (!days.size) throw new Error("No dated rows found in the report.");
  const ids = new Map();
  for (const [wendorId, name] of machines) {
    const { rows: saved } = await db.query(
      `INSERT INTO stock_machines (wendor_id, name) VALUES ($1, $2)
       ON CONFLICT (wendor_id) DO UPDATE SET name = EXCLUDED.name RETURNING id, location_id`,
      [wendorId, name]
    );
    ids.set(wendorId, saved[0].id);
    // Linked to its location (Refill Audit locations) by name, unless someone set it by hand.
    if (!saved[0].location_id) {
      const site = await matchSite(name).catch(() => null);
      if (site?.site_match === "site" && site.site_id) await db.query("UPDATE stock_machines SET location_id = $2, linked_by = 'auto' WHERE id = $1 AND location_id IS NULL", [saved[0].id, site.site_id]);
    }
  }
  const dayList = [...days].sort();
  // These days in this report replace whatever was uploaded for them before (for these machines).
  await db.query("DELETE FROM stock_sales WHERE day = ANY($1) AND machine_id = ANY($2)", [dayList, [...ids.values()]]);
  let sold = 0;
  for (const entry of sales.values()) {
    const machineId = ids.get(entry.wendor);
    await db.query(
      `INSERT INTO stock_sales (day, bucket, machine_id, position, product, qty, amount) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (day, bucket, machine_id, position, product) DO UPDATE SET qty = stock_sales.qty + EXCLUDED.qty, amount = stock_sales.amount + EXCLUDED.amount`,
      [entry.day, entry.bucket, machineId, entry.position, entry.product, entry.qty, entry.amount]
    );
    await db.query("INSERT INTO stock_slots (machine_id, position) VALUES ($1, $2) ON CONFLICT DO NOTHING", [machineId, entry.position]);
    sold += entry.qty;
  }
  const { rows: upload } = await db.query(
    "INSERT INTO stock_uploads (file_name, day_from, day_to, rows, sold, skipped, machines, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, file_name, day_from::text, day_to::text, rows, sold, skipped, machines, uploaded_by, uploaded_at",
    [fileName || null, dayList[0], dayList[dayList.length - 1], rows.length, sold, skipped, [...machines.values()], by]
  );
  return { ...upload[0], days: dayList.length };
}

/* ---------- Working out the stock ---------- */
// Everything needed for one machine (or all): slots, sales, refills, counts.
async function loadMachines(machineId = null) {
  const where = machineId ? "WHERE m.id = $1" : "";
  const { rows: machines } = await db.query(
    `SELECT m.*, l.name AS location_name FROM stock_machines m LEFT JOIN audit_locations l ON l.id = m.location_id ${where} ORDER BY m.name`,
    machineId ? [machineId] : []
  );
  const ids = machines.map((machine) => machine.id);
  const [slots, sales, marks] = await Promise.all([
    db.query("SELECT * FROM stock_slots WHERE machine_id = ANY($1)", [ids]),
    db.query("SELECT day::text AS day, bucket, machine_id, position, product, qty, amount FROM stock_sales WHERE machine_id = ANY($1) ORDER BY day, bucket", [ids]),
    db.query("SELECT * FROM stock_marks WHERE machine_id = ANY($1) ORDER BY at", [ids]),
  ]);
  return { machines, slots: slots.rows, sales: sales.rows.map((sale) => ({ ...sale, day: plainDate(sale.day) })), marks: marks.rows };
}

// "09:00" on a given India day → that moment.
const atIst = (day, time) => new Date(`${day}T${time}:00+05:30`);
const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday

/* Every fixed refill time from the first sales day (at most 120 days back) up to now, except days
   marked as skipped. */
function scheduledRefills(machine, skips, firstDay) {
  const days = machine.refill_days || [];
  if (!days.length || !/^\d{2}:\d{2}$/.test(machine.refill_time || "")) return [];
  const skipped = new Set(skips.map((mark) => istDay(mark.at)));
  const now = new Date();
  const today = istDay(now);
  let day = firstDay && firstDay > addDays(today, -120) ? addDays(firstDay, -1) : addDays(today, -120);
  const out = [];
  for (; day <= today; day = addDays(day, 1)) {
    if (!days.includes(weekdayOf(day)) || skipped.has(day)) continue;
    const at = atIst(day, machine.refill_time);
    if (at <= now) out.push({ at, source: "schedule" });
  }
  return out;
}

function nextRefill(machine) {
  const days = machine.refill_days || [];
  if (!days.length || !/^\d{2}:\d{2}$/.test(machine.refill_time || "")) return null;
  const now = new Date();
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = addDays(istDay(now), offset);
    const at = atIst(day, machine.refill_time);
    if (days.includes(weekdayOf(day)) && at > now) return at;
  }
  return null;
}

function stockOf(data, machine, today = istDay()) {
  const sales = data.sales.filter((sale) => sale.machine_id === machine.id);
  const lastData = sales.length ? sales[sales.length - 1] : null;
  // Refills of the whole machine: its fixed refill times (minus skipped days) and refills marked by hand.
  const refillTimes = [
    ...scheduledRefills(machine, data.marks.filter((mark) => mark.machine_id === machine.id && mark.kind === "skip"), sales[0]?.day),
    ...data.marks.filter((mark) => mark.machine_id === machine.id && mark.kind === "refill").map((mark) => ({ at: mark.at, source: "manual", by: mark.by })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const lastRefill = refillTimes[refillTimes.length - 1] || null;
  const positions = [...new Set([...data.slots.filter((slot) => slot.machine_id === machine.id).map((slot) => slot.position), ...sales.map((sale) => sale.position)])]
    .sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));
  const dataDays = [...new Set(sales.map((sale) => sale.day))].sort();
  const recentDays = dataDays.filter((day) => day > addDays(dataDays[dataDays.length - 1] || today, -7));
  const yesterday = dataDays[dataDays.length - 1] || null;

  const slots = positions.map((position) => {
    const slotSales = sales.filter((sale) => sale.position === position);
    const slot = data.slots.find((item) => item.machine_id === machine.id && item.position === position) || {};
    // Slot size: set by the office, else the most sold between two refills (at least the most sold in a day).
    let estimate = 0;
    for (let index = 0; index < refillTimes.length; index += 1) {
      const from = bucketOf(refillTimes[index].at);
      const to = refillTimes[index + 1] ? bucketOf(refillTimes[index + 1].at) : null;
      const soldBetween = slotSales.filter((sale) => after(sale, from) && (!to || !after(sale, to))).reduce((sum, sale) => sum + sale.qty, 0);
      if (to) estimate = Math.max(estimate, soldBetween);
    }
    const byDay = new Map();
    for (const sale of slotSales) byDay.set(sale.day, (byDay.get(sale.day) || 0) + sale.qty);
    estimate = Math.max(estimate, ...byDay.values(), 0);
    const capacity = slot.capacity ?? (estimate || null);
    // Where the count starts: the last refill (slot full) or the last counted number, whichever is later.
    const counts = data.marks.filter((mark) => mark.machine_id === machine.id && mark.kind === "count" && mark.position === position);
    const lastCount = counts[counts.length - 1] || null;
    let start = null;
    if (lastRefill && (!lastCount || new Date(lastRefill.at) >= new Date(lastCount.at))) start = { at: lastRefill.at, level: capacity, from: lastRefill.source === "schedule" ? "refill time" : "refill (by hand)" };
    else if (lastCount) start = { at: lastCount.at, level: lastCount.qty, from: "count" };
    const since = start ? slotSales.filter((sale) => after(sale, bucketOf(start.at))) : [];
    const soldSince = since.reduce((sum, sale) => sum + sale.qty, 0);
    const raw = start?.level != null ? start.level - soldSince : null;
    const recentSold = slotSales.filter((sale) => recentDays.includes(sale.day)).reduce((sum, sale) => sum + sale.qty, 0);
    const perDay = recentDays.length ? recentSold / recentDays.length : 0;
    const inMachine = raw == null ? null : Math.max(0, raw);
    const lastSale = slotSales[slotSales.length - 1] || null;
    const status = inMachine == null ? "unknown" : inMachine === 0 ? "empty" : (perDay && inMachine / perDay < LOW_DAYS) || inMachine <= 2 ? "low" : "ok";
    return {
      position,
      product: lastSale?.product || null, // last product sold from this slot (products in a slot change)
      products: [...new Set(slotSales.filter((sale) => recentDays.includes(sale.day)).map((sale) => sale.product))],
      capacity, capacity_set: slot.capacity != null, capacity_estimated: slot.capacity == null && capacity != null,
      start, sold_since: soldSince, in_machine: inMachine,
      oversold: raw != null && raw < 0 ? -raw : 0, // sold more than the slot size: the size is probably too small
      sold_yesterday: yesterday ? byDay.get(yesterday) || 0 : 0,
      per_day: Math.round(perDay * 10) / 10,
      days_left: inMachine != null && perDay ? Math.round((inMachine / perDay) * 10) / 10 : null,
      bring: capacity != null && inMachine != null ? Math.max(0, capacity - inMachine) : null,
      last_sale_day: lastSale?.day || null,
      status,
    };
  });

  // Days with no uploaded sales since the last refill: the stock shown is too high for those.
  const fromDay = lastRefill ? istDay(lastRefill.at) : dataDays[0];
  const missing = [];
  if (fromDay && yesterday) for (let day = fromDay; day <= yesterday; day = addDays(day, 1)) if (!dataDays.includes(day)) missing.push(day);
  const known = slots.filter((slot) => slot.in_machine != null);
  return {
    id: machine.id, wendor_id: machine.wendor_id, name: machine.name, active: machine.active,
    location_id: machine.location_id, location_name: machine.location_name,
    refill_days: machine.refill_days || null, refill_time: machine.refill_time || null,
    next_refill: nextRefill(machine), skips: data.marks.filter((mark) => mark.machine_id === machine.id && mark.kind === "skip").slice(-10).reverse().map((mark) => ({ id: mark.id, day: istDay(mark.at), by: mark.by })),
    last_refill: lastRefill, refills: refillTimes.slice(-10).reverse(), all_refills: refillTimes,
    data_to: lastData ? lastData.day : null,
    data_until: lastData ? `${lastData.day} ${pad(Math.floor(lastData.bucket / 6))}:${pad((lastData.bucket % 6) * 10)}` : null,
    missing_days: missing,
    slots,
    totals: {
      in_machine: known.reduce((sum, slot) => sum + slot.in_machine, 0),
      capacity: known.reduce((sum, slot) => sum + (slot.capacity || 0), 0),
      empty: slots.filter((slot) => slot.status === "empty").length,
      low: slots.filter((slot) => slot.status === "low").length,
      unknown: slots.filter((slot) => slot.status === "unknown").length,
      sold_yesterday: slots.reduce((sum, slot) => sum + slot.sold_yesterday, 0),
      per_day: Math.round(slots.reduce((sum, slot) => sum + slot.per_day, 0) * 10) / 10,
      bring: slots.reduce((sum, slot) => sum + (slot.bring || 0), 0),
      estimated_sizes: slots.filter((slot) => slot.capacity_estimated).length,
    },
  };
}

// Day by day for one machine (last 30 days): sold, refills, sales value, units at day end.
function historyOf(data, machine, stock) {
  const sales = data.sales.filter((sale) => sale.machine_id === machine.id);
  const days = [...new Set(sales.map((sale) => sale.day))].sort().slice(-30);
  return days.map((day) => {
    const ofDay = sales.filter((sale) => sale.day === day);
    return {
      day,
      sold: ofDay.reduce((sum, sale) => sum + sale.qty, 0),
      value: Math.round(ofDay.reduce((sum, sale) => sum + Number(sale.amount), 0)),
      refills: stock.all_refills.filter((refill) => istDay(refill.at) === day).length,
      top: Object.entries(ofDay.reduce((map, sale) => ({ ...map, [sale.product]: (map[sale.product] || 0) + sale.qty }), {})).sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }).reverse();
}

export function registerMachineStockRoutes(app, { auth }) {
  const guard = (req, res, next) => (hasPage(req.user, "refills") ? next() : res.status(403).json({ error: "No access to Live Stock" }));
  const who = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Staff");
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { console.log(`${label} ERROR:`, err.message); res.status(err.message?.length < 160 ? 400 : 500).json({ error: err.message || "Server error" }); }
  };

  app.post("/stock/upload", auth, guard, handle("STOCK UPLOAD", async (req, res) => {
    const result = await importReport({ base64: req.body?.file?.data, fileName: req.body?.file?.name, by: who(req.user) });
    res.locals.activity = { section: "Refills", action: `Uploaded Wendor sales ${result.day_from === result.day_to ? plainDate(result.day_from) : `${plainDate(result.day_from)} to ${plainDate(result.day_to)}`} (${result.sold} items sold)` };
    res.json(result);
  }));

  app.get("/stock/overview", auth, guard, handle("STOCK OVERVIEW", async (req, res) => {
    const data = await loadMachines();
    const machines = data.machines.map((machine) => stockOf(data, machine));
    const { rows: uploads } = await db.query("SELECT id, file_name, day_from::text, day_to::text, rows, sold, skipped, machines, uploaded_by, uploaded_at FROM stock_uploads ORDER BY uploaded_at DESC LIMIT 10");
    const { rows: locations } = await db.query("SELECT id, name FROM audit_locations ORDER BY name").catch(() => ({ rows: [] }));
    // Everything running out, across machines (most urgent first).
    const alerts = machines.filter((machine) => machine.active).flatMap((machine) => machine.slots.filter((slot) => ["empty", "low"].includes(slot.status)).map((slot) => ({ machine_id: machine.id, machine: machine.name, location: machine.location_name, ...slot })))
      .sort((a, b) => (a.in_machine - b.in_machine) || ((a.days_left ?? 99) - (b.days_left ?? 99)));
    res.json({ machines: machines.map(({ slots, refills, all_refills, ...rest }) => rest), alerts, uploads, locations, today: istDay() });
  }));

  app.get("/stock/machines/:id", auth, guard, handle("STOCK MACHINE", async (req, res) => {
    const data = await loadMachines(Number(req.params.id));
    const machine = data.machines[0];
    if (!machine) return res.status(404).json({ error: "Machine not found" });
    const stock = stockOf(data, machine);
    const { all_refills, ...rest } = stock;
    res.json({ ...rest, history: historyOf(data, machine, stock) });
  }));

  // The machine's fixed refill days (0 = Sunday … 6 = Saturday) and time ("09:00").
  app.put("/stock/machines/:id/refill-time", auth, guard, handle("STOCK REFILL TIME", async (req, res) => {
    const days = (Array.isArray(req.body?.days) ? req.body.days : []).map(Number).filter((day) => day >= 0 && day <= 6);
    const time = String(req.body?.time || "");
    if (!days.length) return res.status(400).json({ error: "Choose the refill days" });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: "Choose the refill time" });
    const { rowCount } = await db.query("UPDATE stock_machines SET refill_days = $2, refill_time = $3 WHERE id = $1", [req.params.id, [...new Set(days)].sort(), time]);
    if (!rowCount) return res.status(404).json({ error: "Machine not found" });
    res.locals.activity = { section: "Refills", action: `Set refill time for machine ${req.params.id}` };
    res.json({ success: true });
  }));

  // Optional: which client location / site the machine is at (shown with it).
  app.patch("/stock/machines/:id", auth, guard, handle("STOCK MACHINE UPDATE", async (req, res) => {
    const fields = [];
    const values = [req.params.id];
    if (req.body?.location_id !== undefined) { values.push(Number(req.body.location_id) || null); fields.push(`location_id = $${values.length}`, "linked_by = 'manual'"); }
    if (req.body?.active !== undefined) { values.push(Boolean(req.body.active)); fields.push(`active = $${values.length}`); }
    if (!fields.length) return res.status(400).json({ error: "Nothing to change" });
    const { rowCount } = await db.query(`UPDATE stock_machines SET ${fields.join(", ")} WHERE id = $1`, values);
    if (!rowCount) return res.status(404).json({ error: "Machine not found" });
    res.json({ success: true });
  }));

  // How many fit in a slot (blank = estimate from sales again).
  app.put("/stock/machines/:id/slots/:position", auth, guard, handle("STOCK SLOT", async (req, res) => {
    const value = req.body?.capacity === "" || req.body?.capacity == null ? null : Math.round(Number(req.body.capacity));
    if (value != null && !(value >= 0 && value <= 1000)) return res.status(400).json({ error: "Enter how many fit (0–1000)" });
    await db.query(
      `INSERT INTO stock_slots (machine_id, position, capacity, capacity_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (machine_id, position) DO UPDATE SET capacity = EXCLUDED.capacity, capacity_by = EXCLUDED.capacity_by`,
      [req.params.id, req.params.position, value, who(req.user)]
    );
    res.json({ success: true });
  }));

  // A spot check (actual number in a slot now), an extra refill (whole machine full now), or a skipped refill day.
  app.post("/stock/machines/:id/marks", auth, guard, handle("STOCK MARK", async (req, res) => {
    const kind = ["count", "refill", "skip"].includes(req.body?.kind) ? req.body.kind : null;
    if (!kind) return res.status(400).json({ error: "Choose count, refill or skip" });
    // A fixed refill that didn't happen that day ("day": 2026-10-05).
    if (kind === "skip") {
      const day = String(req.body?.day || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "Choose the day" });
      await db.query("INSERT INTO stock_marks (machine_id, kind, at, by, note) VALUES ($1, 'skip', $2, $3, $4)", [req.params.id, new Date(`${day}T12:00:00+05:30`), who(req.user), String(req.body?.note || "").slice(0, 200) || null]);
      return res.json({ success: true });
    }
    const at = req.body?.at && !Number.isNaN(Date.parse(req.body.at)) ? new Date(req.body.at) : new Date();
    if (at > new Date(Date.now() + 5 * 60000)) return res.status(400).json({ error: "That time is in the future" });
    if (kind === "count") {
      const qty = Math.round(Number(req.body?.qty));
      if (!(qty >= 0) || !req.body?.position) return res.status(400).json({ error: "Enter the slot and how many are in it" });
      await db.query("INSERT INTO stock_marks (machine_id, position, kind, qty, at, by, note) VALUES ($1, $2, 'count', $3, $4, $5, $6)", [req.params.id, String(req.body.position), qty, at, who(req.user), String(req.body?.note || "").slice(0, 200) || null]);
    } else {
      await db.query("INSERT INTO stock_marks (machine_id, kind, at, by, note) VALUES ($1, 'refill', $2, $3, $4)", [req.params.id, at, who(req.user), String(req.body?.note || "").slice(0, 200) || null]);
    }
    res.json({ success: true });
  }));

  app.delete("/stock/marks/:id", auth, guard, handle("STOCK MARK DELETE", async (req, res) => {
    const { rowCount } = await db.query("DELETE FROM stock_marks WHERE id = $1", [req.params.id]);
    res.json({ success: rowCount > 0 });
  }));
}
