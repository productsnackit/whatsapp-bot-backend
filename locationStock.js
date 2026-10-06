/* =========================================================
    LOCATION STOCK (Live Stock)
    How much of each product is at each client location (the Refill Audit locations):
      • warehouse data (an Excel: location, item, quantity) sets the stock — a count;
      • delivery challans add to it. DCs are sent as PDF (or photo) to the Snackit WhatsApp
        number from the numbers set in Live Stock → Settings, or uploaded on the page; each is
        read (DC number, date, Bill To / Ship To, items and quantities). The same DC number again
        replaces the earlier one. A DC whose location isn't clear waits in the DC inbox; once a
        DC's party is assigned to a location it is remembered;
      • Wendor sales (the reports uploaded on the page, see machineStock.js) take away what the
        machines at that location sold (machines are linked to their location).
    Stock of an item at a location = last count (or 0) + DC quantities since then − sales since
    then. Product names differ between warehouse, DCs and Wendor; one item list links them
    (same cleaned name or a remembered spelling), and two items can be merged.
========================================================= */
import XLSX from "xlsx";
import { hasPage } from "./accessControl.js";
import { matchSite, normaliseText } from "./siteMatcher.js";
import { cleanName, displayName, likeness } from "./supplyParse.js";
import { storeIncomingMedia } from "./ticketChat.js";
import { sendWhatsApp } from "./whatsapp.js";
import { noteInbound } from "./whatsappOutbox.js";
import { sendPushToUsers } from "./pushNotifications.js";

let db = null;
let onChange = () => {};
const IST = 330 * 60000;
const istDay = (date = new Date()) => new Date(new Date(date).getTime() + IST).toISOString().slice(0, 10);
const addDays = (date, days) => { const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + days); return day.toISOString().slice(0, 10); };
const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const round = (value) => Math.round(Number(value) * 1000) / 1000;
// The DC's Unit column. Pack sizes in names (32g, 500gm, 200ml) are never quantities.
const UNIT_WORDS = "nos|no|pcs|pc|piece|pieces|kg|kgs|box|boxes|pkt|pkts|packet|packets|ltr|ltrs|bottle|bottles|tray|trays|bunch|units?|ea|dozen|doz";

export async function ensureLocationStock(database, { onChanged } = {}) {
  db = database;
  if (onChanged) onChange = onChanged;
  await db.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, aliases TEXT[] NOT NULL DEFAULT '{}',
      unit TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stock_moves (
      id SERIAL PRIMARY KEY, location_id INTEGER NOT NULL, item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, qty NUMERIC NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ref TEXT, raw_name TEXT, by TEXT
    );
    CREATE INDEX IF NOT EXISTS stock_moves_loc_idx ON stock_moves (location_id, item_id, at);
    CREATE TABLE IF NOT EXISTS stock_dcs (
      id SERIAL PRIMARY KEY, ref TEXT, location_id INTEGER, party TEXT, ship_to TEXT, dc_date DATE, dc_at TIMESTAMPTZ,
      lines JSONB NOT NULL DEFAULT '[]', units NUMERIC NOT NULL DEFAULT 0, file_url TEXT, from_phone TEXT, source TEXT,
      status TEXT NOT NULL DEFAULT 'unassigned', problem TEXT, by TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS stock_dcs_ref_idx ON stock_dcs (ref) WHERE ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS stock_party_links (party_key TEXT PRIMARY KEY, location_id INTEGER NOT NULL);
  `);
}

/* ---------- Items: one list for warehouse, DC and Wendor names ---------- */
let itemCache = { at: 0, rows: [] };
async function items() {
  if (Date.now() - itemCache.at < 30000) return itemCache.rows;
  const { rows } = await db.query("SELECT id, name, key, aliases, unit FROM stock_items ORDER BY name");
  itemCache = { at: Date.now(), rows };
  return rows;
}
// The item for a name: same cleaned name or a remembered spelling; else a new item.
export async function itemFor(name, unit = null) {
  const key = cleanName(name);
  if (!key) return null;
  const list = await items();
  const found = list.find((item) => item.key === key || (item.aliases || []).includes(key));
  if (found) return found.id;
  const { rows } = await db.query(
    "INSERT INTO stock_items (name, key, unit) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id",
    [displayName(name).slice(0, 160), key, unit]
  );
  itemCache.at = 0;
  return rows[0].id;
}

/* ---------- Locations ---------- */
async function locations() {
  const { rows } = await db.query("SELECT id, name, machine_code FROM audit_locations ORDER BY name").catch(() => ({ rows: [] }));
  return rows;
}
const partyKey = (text) => normaliseText(text).replace(/\b(pvt|private|ltd|limited|india|technologies|technology|solutions)\b/g, "").replace(/\s+/g, " ").trim();
// A DC's location: a remembered party, else the Ship To / Bill To text matched to a location.
async function locationForParty(...texts) {
  for (const text of texts.filter(Boolean)) {
    const { rows } = await db.query("SELECT location_id FROM stock_party_links WHERE party_key = $1", [partyKey(text)]);
    if (rows[0]) return rows[0].location_id;
  }
  const list = await locations();
  for (const text of texts.filter(Boolean)) {
    const exact = list.find((location) => partyKey(location.name) === partyKey(text));
    if (exact) return exact.id;
    const site = await matchSite(text).catch(() => null);
    if (site?.site_match === "site" && site.site_id) return site.site_id;
  }
  return null;
}

/* ---------- Reading a delivery challan ---------- */
// From the DC's text (PDF text, or a photo read by OCR): number, date, Bill To, Ship To, items.
export function parseDcText(text) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const after = (label) => {
    const index = lines.findIndex((line) => new RegExp(`^${label}\\b`, "i").test(line));
    if (index < 0) return null;
    const rest = lines[index].replace(new RegExp(`^${label}\\s*:?\\s*`, "i"), "").trim();
    return rest && !/^(ship to|bill to)$/i.test(rest) ? rest : lines[index + 1] || null;
  };
  const ref = (raw.match(/\b([A-Z]{2,6}\d{5,12})\b/) || [])[1] || (raw.match(/(?:invoice|challan|dc)\s*no\.?\s*[:\n ]\s*([A-Z0-9/-]{4,20})/i) || [])[1] || null;
  const date = raw.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})(?:,?\s*(\d{1,2}):(\d{2})\s*([AP]M))?/i);
  let dcAt = null;
  if (date) {
    let hour = date[4] ? Number(date[4]) % 12 + (/pm/i.test(date[6]) ? 12 : 0) : 12;
    dcAt = new Date(`${date[3]}-${date[2]}-${date[1]}T${String(hour).padStart(2, "0")}:${date[5] || "00"}:00+05:30`);
    if (Number.isNaN(dcAt.getTime())) dcAt = null;
  }
  let party = after("Bill To");
  if (party && /^(ship to)$/i.test(party)) party = null;
  let shipTo = after("Ship To");
  if (shipTo && /^#|item name/i.test(shipTo)) shipTo = null;
  // Items: rows numbered 1, 2, 3… each ending with "<quantity> <unit>"; a long name can wrap.
  const start = raw.search(/item\s*name/i);
  const end = raw.search(/\n\s*total\b/i);
  const body = raw.slice(start >= 0 ? start : 0, end > start ? end : undefined).replace(/item\s*name.*?\n/i, "\n").replace(/\s+/g, " ");
  const rows = [];
  let cursor = 0;
  const qtyUnit = new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORDS})\\b`, "i");
  for (let number = 1; number <= 400; number += 1) {
    const startAt = body.slice(cursor).search(new RegExp(`(?:^|\\s)${number}\\s+(?=\\S)`));
    if (startAt < 0) break;
    const rest = body.slice(cursor + startAt).replace(new RegExp(`^\\s*${number}\\s+`), "");
    // The quantity is the first "<number> <unit>" in the row (pack sizes like 32g never match).
    const found = rest.match(qtyUnit);
    if (!found) break;
    const before = rest.slice(0, found.index);
    const afterUnit = rest.slice(found.index + found[0].length);
    // A long name can wrap onto a line after the quantity: those words belong to the name.
    const nextAt = afterUnit.search(new RegExp(`(?:^|\\s)${number + 1}\\s+(?=\\S)`));
    const wrapped = (nextAt >= 0 ? afterUnit.slice(0, nextAt) : afterUnit).trim();
    const name = `${before.replace(/(\s+\d{2}\/\d{2}\/\d{4}){1,2}\s*$/, "").replace(/\s+\d{4,8}$/, "").replace(/(\s+\d{2}\/\d{2}\/\d{4}){1,2}\s*$/, "").trim()} ${wrapped}`.replace(/\s+/g, " ").trim();
    const unit = found[2].toLowerCase();
    rows.push({ name, qty: Number(found[1]) * (/^(dozen|doz)$/.test(unit) ? 12 : 1), unit: /^(kg|kgs)$/.test(unit) ? "kg" : "pcs" });
    cursor = cursor + startAt + (body.slice(cursor + startAt).length - afterUnit.length) + (nextAt >= 0 ? nextAt : afterUnit.length);
  }
  return { ref, dc_at: dcAt, party, ship_to: shipTo, lines: rows };
}

// PDF text line by line, keeping table cells apart (cells on one line are joined with spaces
// by their position on the page, so "21069099" and "12" never run together). A broken PDF
// gives an error, never a crash.
export async function pdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let number = 1; number <= Math.min(doc.numPages, 10); number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const lines = [];
      for (const item of content.items) {
        const text = String(item.str || "");
        if (!text.trim()) continue;
        const [x, y] = [item.transform[4], item.transform[5]];
        let line = lines.find((entry) => Math.abs(entry.y - y) < 3);
        if (!line) { line = { y, cells: [] }; lines.push(line); }
        line.cells.push({ x, text });
      }
      pages.push(lines.sort((a, b) => b.y - a.y).map((line) => line.cells.sort((a, b) => a.x - b.x).map((cell) => cell.text.trim()).join("  ")).join("\n"));
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return pages.join("\n");
}
async function imageText(buffer) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try { return (await worker.recognize(buffer)).data.text; } finally { await worker.terminate().catch(() => {}); }
}

/* Saves a DC: its lines become stock at its location (or it waits in the inbox). The same DC
   number again replaces the earlier one. Returns the saved DC. */
async function saveDc({ parsed, fileUrl, fromPhone, source, by, locationId = null }) {
  const location = locationId || await locationForParty(parsed.ship_to, parsed.party);
  const lines = [];
  for (const line of parsed.lines) lines.push({ ...line, item_id: await itemFor(line.name, line.unit) });
  const units = lines.reduce((sum, line) => sum + line.qty, 0);
  const problem = !lines.length ? "No items could be read" : !location ? "Location not clear" : null;
  const status = problem ? (lines.length ? "unassigned" : "unreadable") : "added";
  let dc;
  if (parsed.ref) {
    const { rows: old } = await db.query("SELECT id FROM stock_dcs WHERE ref = $1", [parsed.ref]);
    if (old[0]) {
      await db.query("DELETE FROM stock_moves WHERE kind = 'dc' AND ref = $1", [parsed.ref]);
      const { rows } = await db.query(
        `UPDATE stock_dcs SET location_id = $2, party = $3, ship_to = $4, dc_date = $5, dc_at = $6, lines = $7, units = $8, file_url = COALESCE($9, file_url),
           from_phone = COALESCE($10, from_phone), source = $11, status = $12, problem = $13, by = $14, created_at = NOW() WHERE id = $1 RETURNING *`,
        [old[0].id, location, parsed.party, parsed.ship_to, parsed.dc_at ? istDay(parsed.dc_at) : null, parsed.dc_at, JSON.stringify(lines), units, fileUrl, fromPhone, source, status, problem, by]
      );
      dc = { ...rows[0], replaced: true };
    }
  }
  if (!dc) {
    const { rows } = await db.query(
      `INSERT INTO stock_dcs (ref, location_id, party, ship_to, dc_date, dc_at, lines, units, file_url, from_phone, source, status, problem, by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [parsed.ref, location, parsed.party, parsed.ship_to, parsed.dc_at ? istDay(parsed.dc_at) : null, parsed.dc_at, JSON.stringify(lines), units, fileUrl, fromPhone, source, status, problem, by]
    );
    dc = rows[0];
  }
  if (status === "added") await addDcMoves(dc);
  onChange();
  return dc;
}

async function addDcMoves(dc) {
  await db.query("DELETE FROM stock_moves WHERE kind = 'dc' AND ref = $1", [dc.ref || `dc-${dc.id}`]);
  for (const line of dc.lines || []) {
    if (!line.item_id || !(line.qty > 0)) continue;
    await db.query("INSERT INTO stock_moves (location_id, item_id, kind, qty, at, ref, raw_name, by) VALUES ($1, $2, 'dc', $3, $4, $5, $6, $7)",
      [dc.location_id, line.item_id, line.qty, dc.dc_at || dc.created_at, dc.ref || `dc-${dc.id}`, line.name, dc.by]);
  }
}

export async function readDcFile({ buffer, mime, fileName, fileUrl, fromPhone, source, by }) {
  const isPdf = /pdf/i.test(mime || "") || /\.pdf$/i.test(fileName || "");
  const text = isPdf ? await pdfText(buffer) : await imageText(buffer);
  const parsed = parseDcText(text);
  if (!parsed.lines.length && isPdf) parsed.problem = "No items could be read";
  return saveDc({ parsed, fileUrl, fromPhone, source: isPdf ? source : `${source} (photo)`, by });
}

/* ---------- DCs on WhatsApp from the DC numbers ---------- */
async function dcSenders() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'stock_dc_senders'").catch(() => ({ rows: [] }));
  try { return JSON.parse(rows[0]?.value || "[]"); } catch { return []; }
}

export async function handleStockDcWhatsApp(msg) {
  if (!db || !msg?.from || !["document", "image"].includes(msg.type)) return false;
  const senders = await dcSenders();
  const sender = senders.find((item) => last10(item.phone) === last10(msg.from));
  if (!sender) return false;
  const isPdf = msg.type === "document" && (/pdf/i.test(msg.document?.mime_type || "") || /\.pdf$/i.test(msg.document?.filename || ""));
  if (msg.type === "document" && !isPdf) return false; // e.g. an Excel order goes on to the rest of the bot
  await noteInbound(msg.from);
  try {
    const media = await storeIncomingMedia(msg);
    if (!media?.url) throw new Error("Couldn't download the file");
    const { default: axios } = await import("axios");
    const file = await axios.get(media.url, { responseType: "arraybuffer", timeout: 30000 });
    const dc = await readDcFile({ buffer: Buffer.from(file.data), mime: isPdf ? "application/pdf" : "image", fileName: media.fileName, fileUrl: media.url, fromPhone: msg.from, source: "whatsapp", by: sender.name || msg.from });
    const { rows } = dc.location_id ? await db.query("SELECT name FROM audit_locations WHERE id = $1", [dc.location_id]) : { rows: [] };
    const where = rows[0]?.name;
    const reply = dc.status === "added"
      ? `✅ DC ${dc.ref || ""} read${dc.replaced ? " (replaced the earlier one)" : ""}: ${dc.lines.length} items, ${round(dc.units)} units added to *${where}*'s stock.${!isPdf ? "\nIt was a photo: please check the items on Live Stock → DC inbox." : ""}`
      : dc.status === "unassigned"
        ? `📥 DC ${dc.ref || ""} read: ${dc.lines.length} items, but the location isn't clear${dc.party ? ` ("${dc.party}")` : ""}. Assign it on Live Stock → DC inbox; it will be remembered next time.`
        : `⚠️ Couldn't read the items on this DC${dc.ref ? ` (${dc.ref})` : ""}. Please send the PDF from the billing software, or add it on Live Stock → DC inbox.`;
    await sendWhatsApp(msg.from, reply);
    if (dc.status !== "added") sendPushToUsers(db, ["admin"], { title: "DC needs attention", body: `${dc.ref || "A DC"}: ${dc.problem}`, view: "live-stock" }).catch(() => {});
  } catch (err) {
    console.log("STOCK DC WHATSAPP ERROR:", err.message);
    await sendWhatsApp(msg.from, "⚠️ Couldn't read that DC. Please send it again, or upload it on Live Stock.").catch(() => {});
  }
  return true;
}

/* ---------- Warehouse data: counts per location and item ---------- */
function readWarehouse(base64) {
  const workbook = XLSX.read(Buffer.from(String(base64).replace(/^data:[^,]+,/, ""), "base64"), { type: "buffer" });
  const out = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const headerAt = sheet.findIndex((row) => row.some((cell) => /item|product|sku|name/i.test(String(cell))) && row.some((cell) => /qty|quantity|stock|count|closing|balance/i.test(String(cell))));
    if (headerAt < 0) continue;
    const header = sheet[headerAt].map((cell) => String(cell).trim().toLowerCase());
    const find = (pattern, not = null) => header.findIndex((cell) => pattern.test(cell) && !(not && not.test(cell)));
    const col = {
      location: find(/location|site|client|company|place|store/),
      item: find(/item|product|sku|name/, /location|site|client|company/),
      qty: find(/closing|balance|stock|qty|quantity|count/),
      unit: find(/^unit|uom/),
    };
    if (col.item < 0 || col.qty < 0) continue;
    for (const row of sheet.slice(headerAt + 1)) {
      const item = String(row[col.item] || "").trim();
      const qty = Number(String(row[col.qty] || "").replace(/[, ]/g, ""));
      if (!item || Number.isNaN(qty)) continue;
      out.push({ location: col.location >= 0 ? String(row[col.location] || "").trim() : sheetName, item, qty, unit: col.unit >= 0 ? String(row[col.unit] || "").trim() : "" });
    }
  }
  return out;
}

/* ---------- Working out the stock ---------- */
async function stockFor(locationIds = null) {
  const list = (await locations()).filter((location) => !locationIds || locationIds.includes(location.id));
  const ids = list.map((location) => location.id);
  const [moves, machines, itemRows] = await Promise.all([
    db.query("SELECT location_id, item_id, kind, qty, at, ref FROM stock_moves WHERE location_id = ANY($1) ORDER BY at", [ids]),
    db.query("SELECT id, name, location_id FROM stock_machines WHERE location_id = ANY($1)", [ids]).catch(() => ({ rows: [] })),
    items(),
  ]);
  const machineIds = machines.rows.map((machine) => machine.id);
  const { rows: sales } = await db.query(
    "SELECT day::text AS day, bucket, machine_id, product, SUM(qty)::int AS qty FROM stock_sales WHERE machine_id = ANY($1) GROUP BY day, bucket, machine_id, product ORDER BY day, bucket",
    [machineIds]
  ).catch(() => ({ rows: [] }));
  // Wendor product names → items (same cleaned name or remembered spelling; unknown names become items).
  const byKey = new Map();
  for (const item of itemRows) { byKey.set(item.key, item.id); for (const alias of item.aliases || []) byKey.set(alias, item.id); }
  const unknown = [...new Set(sales.map((sale) => sale.product))].filter((product) => !byKey.has(cleanName(product)));
  for (const product of unknown) byKey.set(cleanName(product), await itemFor(product));
  const allItems = await items();
  const itemName = new Map(allItems.map((item) => [item.id, item.name]));
  const machineLocation = new Map(machines.rows.map((machine) => [machine.id, machine.location_id]));
  const saleAt = (sale) => new Date(`${sale.day}T${String(Math.floor(sale.bucket / 6)).padStart(2, "0")}:${String((sale.bucket % 6) * 10).padStart(2, "0")}:00+05:30`);
  const lastSaleDay = sales.length ? sales[sales.length - 1].day : null;

  const result = new Map();
  for (const location of list) {
    const locMoves = moves.rows.filter((move) => move.location_id === location.id);
    const locSales = sales.filter((sale) => machineLocation.get(sale.machine_id) === location.id).map((sale) => ({ ...sale, at: saleAt(sale), item_id: byKey.get(cleanName(sale.product)) }));
    // Tracking starts at this location's first count or DC: sales before that don't count.
    const firstMove = locMoves[0]?.at ? new Date(locMoves[0].at) : null;
    const itemIds = [...new Set([...locMoves.map((move) => move.item_id), ...locSales.filter((sale) => !firstMove || sale.at >= firstMove).map((sale) => sale.item_id)])];
    const salesDays = [...new Set(locSales.map((sale) => sale.day))].sort();
    const recentDays = salesDays.filter((day) => day > addDays(salesDays[salesDays.length - 1] || istDay(), -7));
    const rows = itemIds.map((itemId) => {
      const ofItem = locMoves.filter((move) => move.item_id === itemId);
      const counts = ofItem.filter((move) => move.kind === "count");
      const lastCount = counts[counts.length - 1] || null;
      const from = lastCount ? new Date(lastCount.at) : firstMove;
      const dcIn = ofItem.filter((move) => move.kind === "dc" && (!lastCount || new Date(move.at) > from)).reduce((sum, move) => sum + Number(move.qty), 0);
      const adjust = ofItem.filter((move) => move.kind === "adjust" && (!lastCount || new Date(move.at) > from)).reduce((sum, move) => sum + Number(move.qty), 0);
      const sold = from ? locSales.filter((sale) => sale.item_id === itemId && sale.at >= from).reduce((sum, sale) => sum + sale.qty, 0) : 0;
      const base = lastCount ? Number(lastCount.qty) : 0;
      const raw = base + dcIn + adjust - sold;
      const recentSold = locSales.filter((sale) => sale.item_id === itemId && recentDays.includes(sale.day)).reduce((sum, sale) => sum + sale.qty, 0);
      const perDay = recentDays.length ? recentSold / recentDays.length : 0;
      const available = Math.max(0, raw);
      return {
        item_id: itemId, name: itemName.get(itemId) || "Item",
        counted: lastCount ? { qty: base, at: lastCount.at } : null,
        dc_in: round(dcIn), adjust: round(adjust), sold, available: round(available),
        short: raw < 0 ? round(-raw) : 0, // sold more than was there: a DC or count is missing
        per_day: Math.round(perDay * 10) / 10,
        days_left: perDay ? Math.round((available / perDay) * 10) / 10 : null,
        status: available <= 0 ? "out" : perDay && available / perDay < 2 ? "low" : "ok",
      };
    }).sort((a, b) => (a.status === "out") - (b.status === "out") || a.name.localeCompare(b.name));
    const locDcs = [...new Set(locMoves.filter((move) => move.kind === "dc").map((move) => move.ref))];
    const lastCountAt = locMoves.filter((move) => move.kind === "count").map((move) => move.at).pop() || null;
    result.set(location.id, {
      id: location.id, name: location.name, machines: machines.rows.filter((machine) => machine.location_id === location.id).map((machine) => machine.name),
      items: rows,
      totals: {
        items: rows.filter((row) => row.available > 0).length, units: round(rows.reduce((sum, row) => sum + row.available, 0)),
        out: rows.filter((row) => row.status === "out").length, low: rows.filter((row) => row.status === "low").length,
        short: rows.filter((row) => row.short > 0).length, per_day: Math.round(rows.reduce((sum, row) => sum + row.per_day, 0) * 10) / 10,
        dcs: locDcs.length,
      },
      last_count_at: lastCountAt, sales_to: salesDays[salesDays.length - 1] || null, last_sale_day: lastSaleDay,
    });
  }
  return result;
}

export function registerLocationStockRoutes(app, { auth }) {
  const guard = (req, res, next) => (hasPage(req.user, "refills") ? next() : res.status(403).json({ error: "No access to Live Stock" }));
  const who = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Staff");
  const handle = (label, fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { console.log(`${label} ERROR:`, err.message); res.status(500).json({ error: err.message?.length < 160 ? err.message : "Server error" }); }
  };

  app.get("/locstock/overview", auth, guard, handle("LOCSTOCK OVERVIEW", async (req, res) => {
    const stock = await stockFor();
    const { rows: inbox } = await db.query("SELECT COUNT(*)::int AS count FROM stock_dcs WHERE status <> 'added'");
    const { rows: machines } = await db.query("SELECT id, name, wendor_id, location_id FROM stock_machines ORDER BY name").catch(() => ({ rows: [] }));
    const { rows: uploads } = await db.query("SELECT id, file_name, day_from::text, day_to::text, sold, uploaded_by, uploaded_at FROM stock_uploads ORDER BY uploaded_at DESC LIMIT 5").catch(() => ({ rows: [] }));
    res.json({
      locations: [...stock.values()].map(({ items: rows, ...rest }) => rest),
      inbox: inbox[0].count, machines, uploads, senders: await dcSenders(), today: istDay(),
    });
  }));

  app.get("/locstock/locations/:id", auth, guard, handle("LOCSTOCK LOCATION", async (req, res) => {
    const stock = await stockFor([Number(req.params.id)]);
    const location = stock.get(Number(req.params.id));
    if (!location) return res.status(404).json({ error: "Location not found" });
    const { rows: dcs } = await db.query("SELECT id, ref, dc_date::text, units, jsonb_array_length(lines) AS items, source, file_url, created_at FROM stock_dcs WHERE location_id = $1 ORDER BY COALESCE(dc_at, created_at) DESC LIMIT 30", [location.id]);
    res.json({ ...location, dcs });
  }));

  // Warehouse data: an Excel with location, item and quantity (a count: it sets the stock).
  app.post("/locstock/warehouse", auth, guard, handle("LOCSTOCK WAREHOUSE", async (req, res) => {
    const rows = readWarehouse(req.body?.file?.data);
    if (!rows.length) return res.status(400).json({ error: "No rows found. The Excel needs columns for location, item and quantity." });
    const list = await locations();
    const at = new Date();
    const by = who(req.user);
    const unmatched = new Set();
    let saved = 0;
    const cache = new Map();
    for (const row of rows) {
      let locationId = cache.get(row.location);
      if (locationId === undefined) {
        locationId = list.find((location) => partyKey(location.name) === partyKey(row.location))?.id || await locationForParty(row.location);
        cache.set(row.location, locationId || null);
      }
      if (!locationId) { unmatched.add(row.location); continue; }
      await db.query("INSERT INTO stock_moves (location_id, item_id, kind, qty, at, ref, raw_name, by) VALUES ($1, $2, 'count', $3, $4, $5, $6, $7)",
        [locationId, await itemFor(row.item, row.unit), row.qty, at, `warehouse ${istDay(at)}`, row.item, by]);
      saved += 1;
    }
    onChange();
    res.locals.activity = { section: "Refills", action: `Uploaded warehouse stock (${saved} rows)` };
    res.json({ saved, rows: rows.length, locations: cache.size - unmatched.size, unmatched: [...unmatched] });
  }));

  // A DC uploaded on the page (PDF or photo).
  app.post("/locstock/dcs", auth, guard, handle("LOCSTOCK DC UPLOAD", async (req, res) => {
    const file = req.body?.file || {};
    const buffer = Buffer.from(String(file.data || "").replace(/^data:[^,]+,/, ""), "base64");
    if (!buffer.length) return res.status(400).json({ error: "Choose the DC file" });
    const dc = await readDcFile({ buffer, mime: file.type, fileName: file.name, fileUrl: null, fromPhone: null, source: "upload", by: who(req.user) });
    res.json(dc);
  }));

  app.get("/locstock/dcs", auth, guard, handle("LOCSTOCK DCS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT d.*, d.dc_date::text AS dc_date, l.name AS location_name FROM stock_dcs d LEFT JOIN audit_locations l ON l.id = d.location_id
       ORDER BY (d.status = 'added'), COALESCE(d.dc_at, d.created_at) DESC LIMIT 100`
    );
    res.json(rows);
  }));

  // Assign a DC to a location (remembered for that party); or fix its lines.
  app.patch("/locstock/dcs/:id", auth, guard, handle("LOCSTOCK DC UPDATE", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM stock_dcs WHERE id = $1", [req.params.id]);
    const dc = rows[0];
    if (!dc) return res.status(404).json({ error: "DC not found" });
    const locationId = Number(req.body?.location_id) || dc.location_id;
    if (!locationId) return res.status(400).json({ error: "Choose the location" });
    let lines = dc.lines || [];
    if (Array.isArray(req.body?.lines)) {
      lines = [];
      for (const line of req.body.lines) if (String(line.name || "").trim() && Number(line.qty) > 0) lines.push({ name: String(line.name).trim(), qty: Number(line.qty), unit: line.unit || "pcs", item_id: await itemFor(line.name, line.unit) });
    }
    if (!lines.length) return res.status(400).json({ error: "The DC has no items" });
    const { rows: updated } = await db.query(
      "UPDATE stock_dcs SET location_id = $2, lines = $3, units = $4, status = 'added', problem = NULL WHERE id = $1 RETURNING *",
      [dc.id, locationId, JSON.stringify(lines), lines.reduce((sum, line) => sum + line.qty, 0)]
    );
    if (dc.party && req.body?.location_id) await db.query("INSERT INTO stock_party_links (party_key, location_id) VALUES ($1, $2) ON CONFLICT (party_key) DO UPDATE SET location_id = EXCLUDED.location_id", [partyKey(dc.party), locationId]);
    if (dc.ship_to && req.body?.location_id) await db.query("INSERT INTO stock_party_links (party_key, location_id) VALUES ($1, $2) ON CONFLICT (party_key) DO UPDATE SET location_id = EXCLUDED.location_id", [partyKey(dc.ship_to), locationId]);
    await addDcMoves(updated[0]);
    onChange();
    res.json(updated[0]);
  }));

  app.delete("/locstock/dcs/:id", auth, guard, handle("LOCSTOCK DC DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM stock_dcs WHERE id = $1 RETURNING ref, id", [req.params.id]);
    if (rows[0]) await db.query("DELETE FROM stock_moves WHERE kind = 'dc' AND ref = $1", [rows[0].ref || `dc-${rows[0].id}`]);
    onChange();
    res.json({ success: Boolean(rows[0]) });
  }));

  // A correction at a location: the real count of an item now, or + / − an amount.
  app.post("/locstock/locations/:id/moves", auth, guard, handle("LOCSTOCK MOVE", async (req, res) => {
    const kind = req.body?.kind === "adjust" ? "adjust" : "count";
    const qty = Number(req.body?.qty);
    if (Number.isNaN(qty) || (kind === "count" && qty < 0)) return res.status(400).json({ error: "Enter the quantity" });
    const itemId = Number(req.body?.item_id) || (req.body?.name ? await itemFor(req.body.name) : null);
    if (!itemId) return res.status(400).json({ error: "Choose the item" });
    await db.query("INSERT INTO stock_moves (location_id, item_id, kind, qty, ref, by) VALUES ($1, $2, $3, $4, $5, $6)", [req.params.id, itemId, kind, qty, String(req.body?.note || kind).slice(0, 120), who(req.user)]);
    onChange();
    res.json({ success: true });
  }));

  // Items: the list, and merging two names that are one product.
  app.get("/locstock/items", auth, guard, handle("LOCSTOCK ITEMS", async (req, res) => {
    const list = await items();
    // Likely the same product (same sizes, nearly the same words), to merge.
    const similar = [];
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      const score = likeness(list[a].key, list[b].key);
      if (score >= 0.8 && score < 1) similar.push({ a: list[a], b: list[b], score: Math.round(score * 100) });
    }
    res.json({ items: list, similar: similar.sort((x, y) => y.score - x.score).slice(0, 60) });
  }));

  app.post("/locstock/items/merge", auth, guard, handle("LOCSTOCK MERGE", async (req, res) => {
    const from = Number(req.body?.from_id);
    const into = Number(req.body?.into_id);
    if (!from || !into || from === into) return res.status(400).json({ error: "Choose two different items" });
    const { rows } = await db.query("SELECT * FROM stock_items WHERE id = ANY($1)", [[from, into]]);
    const old = rows.find((row) => row.id === from);
    if (!old || !rows.find((row) => row.id === into)) return res.status(404).json({ error: "Item not found" });
    await db.query("UPDATE stock_moves SET item_id = $2 WHERE item_id = $1", [from, into]);
    await db.query("UPDATE stock_items SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))) WHERE id = $1", [into, [old.key, ...(old.aliases || [])]]);
    await db.query("DELETE FROM stock_items WHERE id = $1", [from]);
    // DC lines keep pointing at the right item.
    await db.query(`UPDATE stock_dcs SET lines = (SELECT jsonb_agg(CASE WHEN (line->>'item_id')::int = $1 THEN jsonb_set(line, '{item_id}', to_jsonb($2::int)) ELSE line END) FROM jsonb_array_elements(lines) AS line) WHERE lines @> $3::jsonb`, [from, into, JSON.stringify([{ item_id: from }])]);
    itemCache.at = 0;
    onChange();
    res.json({ success: true });
  }));

  // Who sends DCs on WhatsApp (their PDFs and photos are read as stock coming in).
  app.put("/locstock/senders", auth, guard, handle("LOCSTOCK SENDERS", async (req, res) => {
    const senders = (Array.isArray(req.body?.senders) ? req.body.senders : [])
      .map((item) => ({ name: String(item.name || "").trim().slice(0, 60), phone: String(item.phone || "").replace(/[^\d+]/g, "") }))
      .filter((item) => item.phone.replace(/\D/g, "").length >= 10);
    await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('stock_dc_senders', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(senders)]);
    res.json({ senders });
  }));
}
