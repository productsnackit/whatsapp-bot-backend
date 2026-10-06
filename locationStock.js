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
import { bestMatches, nameParts, similarity, sure } from "./productMatch.js";
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
    -- Price of one unit (MRP from closing stock, or set on the page), for stock values.
    ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS price NUMERIC, ADD COLUMN IF NOT EXISTS price_from TEXT;
    -- The Product List (Wendor's active products): the master names every other name links to.
    ALTER TABLE stock_items
      ADD COLUMN IF NOT EXISTS in_list BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS wendor_ids TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS brand TEXT,
      ADD COLUMN IF NOT EXISTS price_ok BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS price_options NUMERIC[] NOT NULL DEFAULT '{}';
    -- Two names the admin said are different products (not asked again).
    CREATE TABLE IF NOT EXISTS stock_item_not_same (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
  `);
}

/* ---------- Items: one list for warehouse, DC and Wendor names ---------- */
let itemCache = { at: 0, rows: [] };
async function items() {
  if (Date.now() - itemCache.at < 30000) return itemCache.rows;
  const { rows } = await db.query(
    `SELECT id, name, key, aliases, unit, price::float AS price, price_from, in_list, wendor_ids, brand, price_ok,
       ARRAY(SELECT unnest(price_options)::float) AS price_options FROM stock_items ORDER BY name`
  );
  for (const row of rows) row.parts = nameParts(row.name);
  itemCache = { at: Date.now(), rows };
  return rows;
}
// The item for a name: same cleaned name or a remembered spelling; else the Product List product
// it surely is (spelling slips, short names — see productMatch.js), remembered as its spelling;
// else a new item, which the Product List page asks the admin about.
export async function itemFor(name, unit = null, { price = null } = {}) {
  const key = cleanName(name);
  if (!key) return null;
  const list = await items();
  const found = list.find((item) => item.key === key || (item.aliases || []).includes(key));
  if (found) return found.id;
  const match = sure(bestMatches(name, list.filter((item) => item.in_list), { price }));
  if (match) {
    await db.query("UPDATE stock_items SET aliases = array_append(aliases, $2) WHERE id = $1 AND NOT ($2 = ANY(aliases))", [match.id, key]);
    itemCache.at = 0;
    return match.id;
  }
  const { rows } = await db.query(
    "INSERT INTO stock_items (name, key, unit) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id",
    [displayName(name).slice(0, 160), key, unit]
  );
  itemCache.at = 0;
  return rows[0].id;
}

// Two names are one product: everything of "from" moves to "into", whose name stays; "from"'s
// spellings are remembered for "into".
async function mergeItems(from, into) {
  if (!from || !into || from === into) return { error: "Choose two different items" };
  const { rows } = await db.query("SELECT * FROM stock_items WHERE id = ANY($1)", [[from, into]]);
  const old = rows.find((row) => row.id === from);
  const keep = rows.find((row) => row.id === into);
  if (!old || !keep) return { error: "Item not found" };
  await db.query("UPDATE stock_moves SET item_id = $2 WHERE item_id = $1", [from, into]);
  await db.query(
    `UPDATE stock_items SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))),
       wendor_ids = (SELECT ARRAY(SELECT DISTINCT unnest(wendor_ids || $3::text[]))), in_list = in_list OR $4,
       brand = COALESCE(brand, $5), price_options = (SELECT ARRAY(SELECT DISTINCT unnest(price_options || $6::numeric[])))
     WHERE id = $1`,
    [into, [old.key, ...(old.aliases || [])], old.wendor_ids || [], old.in_list, old.brand, old.in_list && old.price != null ? [old.price] : []]
  );
  if (old.price != null) await db.query("UPDATE stock_items SET price = $2, price_from = $3 WHERE id = $1 AND price IS NULL", [into, old.price, old.price_from]);
  // Two Product List products with different prices: the admin confirms which.
  await db.query("UPDATE stock_items SET price_ok = FALSE WHERE id = $1 AND array_length(price_options, 1) > 1 AND NOT price_ok", [into]);
  await db.query("DELETE FROM stock_items WHERE id = $1", [from]);
  await db.query("DELETE FROM stock_item_not_same WHERE a = $1 OR b = $1", [from]);
  // DC lines keep pointing at the right item.
  await db.query(`UPDATE stock_dcs SET lines = (SELECT jsonb_agg(CASE WHEN (line->>'item_id')::int = $1 THEN jsonb_set(line, '{item_id}', to_jsonb($2::int)) ELSE line END) FROM jsonb_array_elements(lines) AS line) WHERE lines @> $3::jsonb`, [from, into, JSON.stringify([{ item_id: from }])]);
  itemCache.at = 0;
  onChange();
  return { success: true };
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
      expired: find(/expir|damage/),
      price: find(/mrp|price|rate/),
    };
    if (col.item < 0 || col.qty < 0) continue;
    for (const row of sheet.slice(headerAt + 1)) {
      const item = String(row[col.item] || "").trim();
      if (/^(grand\s*)?total$/i.test(item)) continue;
      const qty = Number(String(row[col.qty] || "").replace(/[, ]/g, "")); // blank = none left
      const expired = col.expired >= 0 ? Number(String(row[col.expired] || "").replace(/[, ]/g, "")) || 0 : 0;
      const price = col.price >= 0 ? Number(String(row[col.price] || "").replace(/[₹, ]/g, "")) || null : null;
      if (!item || Number.isNaN(qty)) continue;
      // No location column: the location is chosen on upload, or read from the file / sheet name.
      out.push({ location: col.location >= 0 ? String(row[col.location] || "").trim() : null, sheet: sheetName, item, qty, expired, price, unit: col.unit >= 0 ? String(row[col.unit] || "").trim() : "" });
    }
  }
  return out;
}

/* ---------- Product List ---------- */
function productsFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const out = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const headerAt = sheet.findIndex((row) => row.some((cell) => /product\s*name|item\s*name/i.test(String(cell))));
    if (headerAt < 0) continue;
    const header = sheet[headerAt].map((cell) => String(cell).trim().toLowerCase());
    const col = {
      id: header.findIndex((cell) => /^(product\s*)?id$|product\s*code|sku/.test(cell)),
      name: header.findIndex((cell) => /product\s*name|item\s*name/.test(cell)),
      price: header.findIndex((cell) => /price|mrp|rate/.test(cell)),
      brand: header.findIndex((cell) => /brand\s*name|^brand$/.test(cell)),
      status: header.findIndex((cell) => /^status$/.test(cell)),
    };
    for (const row of sheet.slice(headerAt + 1)) {
      const name = String(row[col.name] || "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      if (col.status >= 0 && /^(false|inactive|no)$/i.test(String(row[col.status]).trim())) continue;
      const price = Number(String(row[col.price] ?? "").replace(/[₹, ]/g, ""));
      out.push({ id: col.id >= 0 ? String(row[col.id] || "").trim() || null : null, name, price: price > 0 ? price : null, brand: col.brand >= 0 ? String(row[col.brand] || "").trim() || null : null });
    }
  }
  return out;
}

// Wendor's "Product Active List" PDF: "25823  Coca-Cola Zero Sugar Can (300ml)  40  28  1344010  Universal  True …";
// a long name wraps onto the next line.
function productsFromPdf(text) {
  const out = [];
  for (const line of String(text || "").split("\n").map((item) => item.trim()).filter(Boolean)) {
    const cells = line.split(/\s{2,}/);
    if (/^\d{4,7}$/.test(cells[0]) && cells[1] && /[a-z]/i.test(cells[1])) {
      const price = Number(String(cells[2] || "").replace(/[₹,]/g, ""));
      const brandAt = cells.findIndex((cell, index) => index > 2 && /^\d{6,8}$/.test(cell));
      out.push({ id: cells[0], name: cells[1].trim(), price: price > 0 ? price : null, brand: brandAt > 0 ? cells[brandAt + 1] || null : null });
    } else if (out.length && cells.length === 1 && /^[a-z(]/i.test(line) && !/product (active )?list|page \d|product id/i.test(line)) {
      out[out.length - 1].name = `${out[out.length - 1].name} ${line}`.trim(); // the name's second line
    }
  }
  return out;
}

async function importProducts(rows) {
  // The list itself can have one product twice (same name, sometimes two prices).
  const groups = new Map();
  for (const row of rows) {
    const key = cleanName(row.name);
    if (!key) continue;
    const group = groups.get(key) || { key, name: row.name, ids: [], prices: [], brand: row.brand };
    if (row.id) group.ids.push(row.id);
    if (row.price != null && !group.prices.includes(row.price)) group.prices.push(row.price);
    group.brand = group.brand || row.brand;
    groups.set(key, group);
  }
  let added = 0;
  let updated = 0;
  for (const group of groups.values()) {
    const list = await items();
    const found = list.find((item) => item.key === group.key || (item.aliases || []).includes(group.key) || (group.ids.length && (item.wendor_ids || []).some((id) => group.ids.includes(id))));
    const twoPrices = group.prices.length > 1;
    if (found) {
      await db.query(
        `UPDATE stock_items SET in_list = TRUE, name = CASE WHEN in_list THEN name ELSE $2 END,
           wendor_ids = (SELECT ARRAY(SELECT DISTINCT unnest(wendor_ids || $3::text[]))), brand = COALESCE($4, brand),
           price = CASE WHEN COALESCE(price_from, '') = 'page' THEN price ELSE $5 END,
           price_from = CASE WHEN COALESCE(price_from, '') = 'page' THEN price_from WHEN $5 IS NULL THEN price_from ELSE 'product list' END,
           price_options = CASE WHEN $6 AND NOT price_ok THEN $7::numeric[] ELSE price_options END
         WHERE id = $1`,
        [found.id, displayName(group.name).slice(0, 160), group.ids, group.brand, group.prices[0] ?? found.price ?? null, twoPrices, group.prices]
      );
      updated += 1;
    } else {
      await db.query(
        "INSERT INTO stock_items (name, key, in_list, wendor_ids, brand, price, price_from, price_options) VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7) ON CONFLICT (key) DO NOTHING",
        [displayName(group.name).slice(0, 160), group.key, group.ids, group.brand, group.prices[0] ?? null, group.prices.length ? "product list" : null, twoPrices ? group.prices : []]
      );
      added += 1;
    }
    itemCache.at = 0;
  }
  // Names already in use (closing stocks, DCs, Wendor sales) that surely are a listed product join it.
  const list = await items();
  const listed = list.filter((item) => item.in_list);
  const notSame = await notSamePairs();
  let linked = 0;
  for (const item of list.filter((row) => !row.in_list)) {
    const match = sure(bestMatches(item.name, listed.filter((other) => !notSame.has(`${item.id}|${other.id}`))));
    if (match && !(await mergeItems(item.id, match.id)).error) linked += 1;
  }
  onChange();
  return { products: groups.size, rows: rows.length, added, updated, linked };
}

async function notSamePairs() {
  const { rows } = await db.query("SELECT a, b FROM stock_item_not_same");
  return new Set(rows.map((row) => `${row.a}|${row.b}`));
}

// The Product List page: every product, where it's used, and what to confirm.
async function productsPage() {
  itemCache.at = 0;
  const list = await items();
  const notSame = await notSamePairs();
  const [{ rows: moves }, { rows: sales }] = await Promise.all([
    db.query("SELECT item_id, COUNT(DISTINCT location_id)::int AS locations, COUNT(*)::int AS entries FROM stock_moves GROUP BY item_id"),
    db.query("SELECT product, SUM(qty)::int AS qty FROM stock_sales WHERE day >= CURRENT_DATE - 60 GROUP BY product").catch(() => ({ rows: [] })),
  ]);
  const byKey = new Map();
  for (const item of list) { byKey.set(item.key, item.id); for (const alias of item.aliases || []) byKey.set(alias, item.id); }
  const sold = new Map();
  for (const sale of sales) { const id = byKey.get(cleanName(sale.product)); if (id) sold.set(id, (sold.get(id) || 0) + sale.qty); }
  const used = new Map(moves.map((row) => [row.item_id, row]));
  const view = (item) => ({
    id: item.id, name: item.name, in_list: item.in_list, wendor_ids: item.wendor_ids, brand: item.brand, aliases: item.aliases,
    price: item.price, price_from: item.price_from, price_ok: item.price_ok, price_options: item.price_options,
    locations: used.get(item.id)?.locations || 0, sold_60d: sold.get(item.id) || 0,
  });
  const listed = list.filter((item) => item.in_list);
  // 1. Names not in the Product List: which listed product is it?
  const matches = [];
  for (const item of list.filter((row) => !row.in_list)) {
    const options = bestMatches(item.name, listed.filter((other) => !notSame.has(`${item.id}|${other.id}`)), { price: item.price, limit: 3 }).filter((option) => option.score >= 0.5);
    matches.push({ item: view(item), options: options.map((option) => ({ ...view(option), score: Math.round(option.score * 100) })) });
  }
  // 2. Two listed products that look like one (the list has some twice).
  const duplicates = [];
  for (let a = 0; a < listed.length; a += 1) {
    for (let b = a + 1; b < listed.length; b += 1) {
      if (listed[a].parts.words[0] !== listed[b].parts.words[0] && listed[a].parts.words[0]?.slice(0, 4) !== listed[b].parts.words[0]?.slice(0, 4)) continue;
      if (notSame.has(`${listed[a].id}|${listed[b].id}`)) continue;
      const score = similarity(listed[a].parts, listed[b].parts);
      if (score >= 0.9) duplicates.push({ a: view(listed[a]), b: view(listed[b]), score: Math.round(score * 100) });
    }
  }
  duplicates.sort((x, y) => y.score - x.score);
  // 3. Prices to confirm: two prices for one product, or no price for one in use.
  const prices = list.filter((item) => (!item.price_ok && (item.price_options || []).length > 1) || (item.price == null && (used.has(item.id) || sold.has(item.id)))).map(view);
  return {
    products: list.map(view),
    confirm: { matches: matches.sort((x, y) => (y.item.locations + y.item.sold_60d) - (x.item.locations + x.item.sold_60d)), duplicates, prices },
    counts: { total: list.length, listed: listed.length, not_listed: list.length - listed.length },
  };
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
    "SELECT day::text AS day, bucket, machine_id, product, SUM(qty)::int AS qty, SUM(amount)::float AS amount FROM stock_sales WHERE machine_id = ANY($1) GROUP BY day, bucket, machine_id, product ORDER BY day, bucket",
    [machineIds]
  ).catch(() => ({ rows: [] }));
  // Wendor product names → items (same cleaned name or remembered spelling; unknown names become items).
  const byKey = new Map();
  for (const item of itemRows) { byKey.set(item.key, item.id); for (const alias of item.aliases || []) byKey.set(alias, item.id); }
  const unknown = [...new Set(sales.map((sale) => sale.product))].filter((product) => !byKey.has(cleanName(product)));
  for (const product of unknown) byKey.set(cleanName(product), await itemFor(product));
  const allItems = await items();
  const itemName = new Map(allItems.map((item) => [item.id, item.name]));
  // Price of a unit: the item's price (MRP), else what the machines sold it for on average.
  const itemPrice = new Map(allItems.filter((item) => item.price > 0).map((item) => [item.id, item]));
  const salePrice = new Map();
  for (const sale of sales) {
    const id = byKey.get(cleanName(sale.product));
    const sum = salePrice.get(id) || { qty: 0, amount: 0 };
    sum.qty += sale.qty; sum.amount += Number(sale.amount) || 0;
    salePrice.set(id, sum);
  }
  const avgSale = (id) => (salePrice.get(id)?.qty && salePrice.get(id).amount ? Math.round((salePrice.get(id).amount / salePrice.get(id).qty) * 100) / 100 : null);
  // A closing-stock sheet's "Sum of MRP" can be added up over rows (330 for a ₹110 item): when the
  // machines sell it for under half of that, their price is the one used. A price set on the page wins.
  const priceInfo = (id) => {
    const item = itemPrice.get(id);
    const sale = avgSale(id);
    if (item && !(item.price_from === "closing stock" && sale && item.price >= sale * 1.8)) return { price: item.price, from: item.price_from === "page" ? "page" : item.price_from === "product list" ? "list" : "mrp" };
    return sale ? { price: sale, from: "sales" } : { price: null, from: null };
  };
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
      // The latest count; two names counted at the same time that are one product add up.
      const latest = counts[counts.length - 1] || null;
      const lastCount = latest ? { ...latest, qty: counts.filter((move) => new Date(move.at).getTime() === new Date(latest.at).getTime()).reduce((sum, move) => sum + Number(move.qty), 0) } : null;
      const from = lastCount ? new Date(lastCount.at) : firstMove;
      const dcIn = ofItem.filter((move) => move.kind === "dc" && (!lastCount || new Date(move.at) > from)).reduce((sum, move) => sum + Number(move.qty), 0);
      const adjust = ofItem.filter((move) => move.kind === "adjust" && (!lastCount || new Date(move.at) > from)).reduce((sum, move) => sum + Number(move.qty), 0);
      const soldSales = from ? locSales.filter((sale) => sale.item_id === itemId && sale.at >= from) : [];
      const sold = soldSales.reduce((sum, sale) => sum + sale.qty, 0);
      const { price, from: priceFrom } = priceInfo(itemId);
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
        price, price_from: priceFrom,
        value: price != null ? Math.round(available * price) : null, // stock value now
        // What went out: the sales amount (a ₹0 sale, e.g. a free vend, at the item's price).
        sold_value: Math.round(soldSales.reduce((sum, sale) => sum + (Number(sale.amount) || sale.qty * (price || 0)), 0)),
        dc_value: price != null ? Math.round(dcIn * price) : null,
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
        value: rows.reduce((sum, row) => sum + (row.value || 0), 0),
        sold_value: rows.reduce((sum, row) => sum + row.sold_value, 0),
        dc_value: rows.reduce((sum, row) => sum + (row.dc_value || 0), 0),
        no_price: rows.filter((row) => row.available > 0 && row.price == null).length,
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
    const { rows: counts } = await db.query(
      `SELECT at, (at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, COUNT(*)::int AS items, SUM(qty) AS units, MAX(by) AS by
       FROM stock_moves WHERE location_id = $1 AND kind = 'count' AND ref LIKE 'warehouse%' GROUP BY at ORDER BY at DESC LIMIT 20`,
      [location.id]
    );
    res.json({ ...location, dcs, counts });
  }));

  // Remove one closing stock of a location (e.g. uploaded with the wrong date).
  app.delete("/locstock/locations/:id/counts", auth, guard, handle("LOCSTOCK COUNT DELETE", async (req, res) => {
    const at = new Date(String(req.query.at || ""));
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: "Which closing stock?" });
    const { rowCount } = await db.query("DELETE FROM stock_moves WHERE location_id = $1 AND kind = 'count' AND ref LIKE 'warehouse%' AND at = $2", [req.params.id, at]);
    onChange();
    res.json({ removed: rowCount });
  }));

  // Warehouse data: an Excel with location, item and quantity (a count: it sets the stock).
  // A closing-stock sheet for one location (e.g. "Bitgo Closing Stock": Product, Quantity, Expired)
  // or for many (with a Location column). Expired units aren't counted as stock; the same product
  // on two rows adds up.
  app.post("/locstock/warehouse", auth, guard, handle("LOCSTOCK WAREHOUSE", async (req, res) => {
    const rows = readWarehouse(req.body?.file?.data);
    if (!rows.length) return res.status(400).json({ error: "No rows found. The Excel needs columns for the item (Product) and the quantity." });
    const list = await locations();
    const chosen = Number(req.body?.location_id) || null;
    // The day the closing stock was taken: it is the stock at the end of that day (sales from the
    // next day are taken away). Default today.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || "")) ? req.body.date : istDay();
    if (day > istDay()) return res.status(400).json({ error: "The closing stock date can't be in the future" });
    if (chosen && !list.some((location) => location.id === chosen)) return res.status(400).json({ error: "Location not found" });
    // A location named in the file name or sheet name ("Bitgo_Closing_Stock.xlsx" → Bitgo).
    const named = (text) => {
      const key = ` ${partyKey(String(text || "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " "))} `;
      return list.filter((location) => partyKey(location.name) && key.includes(` ${partyKey(location.name)} `)).sort((a, b) => b.name.length - a.name.length)[0]?.id || null;
    };
    const fromFile = named(req.body?.file?.name);
    const cache = new Map();
    const unmatched = new Set();
    const totals = new Map(); // location|item → { qty, expired }
    const prices = new Map(); // item → MRP in the sheet
    for (const row of rows) {
      let locationId = null;
      if (row.location) {
        if (!cache.has(row.location)) cache.set(row.location, list.find((location) => partyKey(location.name) === partyKey(row.location))?.id || await locationForParty(row.location));
        locationId = cache.get(row.location);
        if (!locationId) { unmatched.add(row.location); continue; }
      } else {
        locationId = chosen || fromFile || named(row.sheet);
        if (!locationId) return res.status(400).json({ error: "Which location is this stock for? Choose it and upload again.", need_location: true });
      }
      const itemId = await itemFor(row.item, row.unit, { price: row.price });
      if (!itemId) continue;
      const key = `${locationId}|${itemId}`;
      const total = totals.get(key) || { locationId, itemId, raw: row.item, qty: 0, expired: 0 };
      if (row.price > 0) prices.set(itemId, row.price);
      total.qty += row.qty;
      total.expired += Math.min(row.expired, row.qty);
      totals.set(key, total);
    }
    const at = new Date(`${day}T23:59:59+05:30`);
    const by = who(req.user);
    // A closing stock replaces the earlier closing stocks uploaded for that location for the same
    // day or a later one (e.g. one uploaded with the wrong date).
    const places = [...new Set([...totals.values()].map((total) => total.locationId))];
    await db.query("DELETE FROM stock_moves WHERE kind = 'count' AND ref LIKE 'warehouse%' AND location_id = ANY($1) AND at >= $2", [places, new Date(`${day}T00:00:00+05:30`)]);
    for (const total of totals.values()) {
      await db.query("INSERT INTO stock_moves (location_id, item_id, kind, qty, at, ref, raw_name, by) VALUES ($1, $2, 'count', $3, $4, $5, $6, $7)",
        [total.locationId, total.itemId, Math.max(0, total.qty - total.expired), at, `warehouse ${day}${total.expired ? ` (${total.expired} expired)` : ""}`, total.raw, by]);
    }
    // The sheet's MRP becomes the item's price (unless someone set the price on the page).
    // (The Product List's price and a price set on the page win over the sheet.)
    for (const [itemId, price] of prices) await db.query("UPDATE stock_items SET price = $2, price_from = 'closing stock' WHERE id = $1 AND NOT in_list AND COALESCE(price_from, '') NOT IN ('page', 'product list')", [itemId, price]);
    if (prices.size) itemCache.at = 0;
    onChange();
    const names = list.filter((location) => places.includes(location.id)).map((location) => location.name);
    res.locals.activity = { section: "Refills", action: `Uploaded closing stock for ${names.join(", ") || "no location"} (${totals.size} items)` };
    res.json({
      saved: totals.size, rows: rows.length, date: day, locations: places.length, location_names: names, unmatched: [...unmatched],
      units: [...totals.values()].reduce((sum, total) => sum + Math.max(0, total.qty - total.expired), 0),
      expired: [...totals.values()].reduce((sum, total) => sum + total.expired, 0),
    });
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
    const result = await mergeItems(Number(req.body?.from_id), Number(req.body?.into_id));
    if (result.error) return res.status(400).json(result);
    res.json({ success: true });
  }));

  // An item's price (one unit), used for stock values. Blank = back to the MRP / sales price.
  app.patch("/locstock/items/:id", auth, guard, handle("LOCSTOCK ITEM", async (req, res) => {
    const raw = String(req.body?.price ?? "").trim();
    const price = raw === "" ? null : Number(raw);
    if (price != null && (Number.isNaN(price) || price < 0)) return res.status(400).json({ error: "Enter the price" });
    const { rowCount } = await db.query(
      "UPDATE stock_items SET price = $2, price_from = $3, price_ok = $4, price_options = CASE WHEN $4 THEN '{}' ELSE price_options END WHERE id = $1",
      [req.params.id, price, price == null ? null : "page", price != null]
    );
    if (!rowCount) return res.status(404).json({ error: "Item not found" });
    itemCache.at = 0;
    onChange();
    res.json({ success: true });
  }));

  /* ---------- Product List ---------- */
  // Wendor's product list (Excel or PDF: Product ID, Product Name, Product Price, Brand Name).
  app.post("/locstock/products/upload", auth, guard, handle("LOCSTOCK PRODUCTS UPLOAD", async (req, res) => {
    const file = req.body?.file || {};
    const buffer = Buffer.from(String(file.data || "").replace(/^data:[^,]+,/, ""), "base64");
    if (!buffer.length) return res.status(400).json({ error: "Choose the product list file" });
    const isPdf = /pdf/i.test(file.type || "") || /\.pdf$/i.test(file.name || "");
    const rows = isPdf ? productsFromPdf(await pdfText(buffer)) : productsFromExcel(buffer);
    if (!rows.length) return res.status(400).json({ error: "No products found. The file needs Product Name and Product Price columns." });
    res.locals.activity = { section: "Refills", action: `Uploaded the product list (${rows.length} products)` };
    res.json(await importProducts(rows));
  }));

  // Every product, with where it is used, and what the admin should confirm.
  app.get("/locstock/products", auth, guard, handle("LOCSTOCK PRODUCTS", async (req, res) => {
    res.json(await productsPage());
  }));

  // "These two are the same product": keep one (its name), and the price to use.
  app.post("/locstock/products/same", auth, guard, handle("LOCSTOCK SAME", async (req, res) => {
    const from = Number(req.body?.from_id);
    const into = Number(req.body?.into_id);
    const result = await mergeItems(from, into);
    if (result.error) return res.status(400).json(result);
    const price = req.body?.price === "" || req.body?.price == null ? null : Number(req.body.price);
    if (price != null && !Number.isNaN(price) && price >= 0) {
      await db.query("UPDATE stock_items SET price = $2, price_from = 'page', price_ok = TRUE, price_options = '{}' WHERE id = $1", [into, price]);
      itemCache.at = 0;
    }
    res.locals.activity = { section: "Refills", action: `Product List: merged two names into one product (#${into})` };
    res.json({ success: true });
  }));

  app.post("/locstock/products/not-same", auth, guard, handle("LOCSTOCK NOT SAME", async (req, res) => {
    const a = Number(req.body?.a_id);
    const b = Number(req.body?.b_id);
    if (!a || !b || a === b) return res.status(400).json({ error: "Choose two products" });
    await db.query("INSERT INTO stock_item_not_same (a, b) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING", [a, b]);
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
