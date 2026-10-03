/* =========================================================
    DIRECT SUPPLY · DELIVERY CHALLANS (DC)
    One DC per company for a delivery date, in Snackit's format (seller box with logo, DC number,
    date and place of supply; Bill To / Ship To; items with HSN, Exp. and Mfg. date, quantity and
    unit; total; terms; Received By / Delivered By / Authorized Signatory with the stamp).
      • made by itself when the stock buyer taps "Goods received", and sent to his WhatsApp as
        PDFs (one per company), ready to print and go with the delivery;
      • quantities are what each company ordered, or the packed quantity if it was changed on
        the dashboard (Delivery & bills);
      • HSN comes from Setup → Items; Mfg. and Exp. dates from what the buyer filled on his page;
      • Bill To / Ship To come from each company's billing details (Setup → Companies → Billing);
      • the number is the prefix + next number from Invoice details (e.g. DIR26 + 00488), kept
        when the DC is made again for the same company and date.
========================================================= */
import crypto from "crypto";
import axios from "axios";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { companyLines } from "./supplyBilling.js";
import { cleanName, likeness } from "./supplyParse.js";
import { savePastOrders, saveSept2026Workbook } from "./supplyHistory.js";
import { splitExistingRounds } from "./supplySegments.js";
import { storeDashboardFile } from "./ticketChat.js";
import { sendWhatsApp, sendWhatsAppPayload, sendWhatsAppTemplate } from "./whatsapp.js";
import { refillerWindowOpen } from "./whatsappOutbox.js";

let db = null;
let buyerContact = async () => ({});
let onChange = () => {};
const pad = (n) => String(n).padStart(2, "0");
const plainDate = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : value);
const dayLabel = (date) => new Date(`${plainDate(date)}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const qtyText = (qty) => String(Math.round(Number(qty) * 1000) / 1000);
const UNIT_TEXT = { pcs: "Nos", kg: "Kg", box: "Box", pkt: "Pkt", bottle: "Bottle", l: "Ltr", bunch: "Bunch", tray: "Tray" };
const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

export async function ensureSupplyChallan(database, { getBuyer, onChanged } = {}) {
  db = database;
  if (getBuyer) buyerContact = getBuyer;
  if (onChanged) onChange = onChanged;
  await db.query(`
    ALTER TABLE supply_companies
      ADD COLUMN IF NOT EXISTS contact_no TEXT,
      ADD COLUMN IF NOT EXISTS state TEXT,
      ADD COLUMN IF NOT EXISTS ship_to TEXT;
    ALTER TABLE supply_products ADD COLUMN IF NOT EXISTS hsn TEXT;
    ALTER TABLE supply_purchases
      ADD COLUMN IF NOT EXISTS mfg_date TEXT,
      ADD COLUMN IF NOT EXISTS exp_date TEXT;
    CREATE TABLE IF NOT EXISTS supply_challans (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES supply_rounds(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES supply_companies(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      lines JSONB NOT NULL DEFAULT '[]',
      total_qty NUMERIC NOT NULL DEFAULT 0,
      pdf_url TEXT,
      made_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      UNIQUE (round_id, company_id)
    );
    ALTER TABLE supply_challans
      ADD COLUMN IF NOT EXISTS pdf BYTEA,
      ADD COLUMN IF NOT EXISTS file_token TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS file_name TEXT,
      ADD COLUMN IF NOT EXISTS send_error TEXT;
  `);
  await saveKnownLocations().catch((err) => console.log("SUPPLY LOCATIONS ERROR:", err.message));
  await fillKnownHsn().catch((err) => console.log("SUPPLY HSN ERROR:", err.message));
  await savePastOrders(db).catch((err) => console.log("SUPPLY PAST ORDERS ERROR:", err.message));
  await saveSept2026Workbook(db).catch((err) => console.log("SUPPLY SEPT WORKBOOK ERROR:", err.message));
  await splitExistingRounds().catch((err) => console.log("SUPPLY SPLIT ERROR:", err.message));
}

/* Locations from Snackit's earlier DCs (Oct 2026), saved once: a new location is added; an
   existing one (same name) only gets the details that are still empty. */
const KNOWN_LOCATIONS = [
  { name: "Nutanix", billing_name: "Nutanix Technologies India Pvt Ltd", address: "Prestige Tech Park 9th Floor, Mercury 2B Block Marathahalli - Sarjapur Outer Ring Road Kadabeesanahalli Kadabeesanahalli", contact_no: "6364831771", gstin: "29AAECN3355L1Z2", state: "29-Karnataka", ship_to: "Prestige TechPark" },
  { name: "Newtap", billing_name: "Newtap Finance Private Limited", address: "3rd Floor 777/A KP Towers 13th Main Road, 100 Feet Road Bengaluru", gstin: "29AACCP3655M1ZX", state: "29-Karnataka" },
  { name: "Solera", billing_name: "Dealer Socket (India) Private Limited", address: "Khatha No.381 Prestige Technostar Krishnarajapuram Hobli Doddanekundi Industrial Area, Doddanekundi Village", contact_no: "9060301538", gstin: "29AAHCD3977F1ZA" },
  { name: "Sanas", billing_name: "Sanas", address: "Prestige Pegasus, Sarjapur - Marathahalli Rd, Ambalipura, Haralur, Bengaluru, Karntaka - 560103.", gstin: "29ABICS7655M1ZE", state: "29-Karnataka" },
];

async function saveKnownLocations() {
  const { rows: done } = await db.query("SELECT 1 FROM app_settings WHERE key = 'supply_locations_v1'");
  if (done.length) return;
  const key = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const { rows: companies } = await db.query("SELECT * FROM supply_companies");
  for (const location of KNOWN_LOCATIONS) {
    const found = companies.find((company) => key(company.name) === key(location.name));
    const fields = Object.keys(location).filter((field) => field !== "name");
    if (!found) {
      await db.query(
        `INSERT INTO supply_companies (name, ${fields.join(", ")}) VALUES ($1, ${fields.map((_, index) => `$${index + 2}`).join(", ")}) ON CONFLICT (name) DO NOTHING`,
        [location.name, ...fields.map((field) => location[field])]
      );
    } else {
      const empty = fields.filter((field) => !String(found[field] ?? "").trim());
      if (empty.length) await db.query(`UPDATE supply_companies SET ${empty.map((field, index) => `${field} = $${index + 2}`).join(", ")} WHERE id = $1`, [found.id, ...empty.map((field) => location[field])]);
    }
  }
  await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_locations_v1', 'done', NOW()) ON CONFLICT (key) DO NOTHING");
  console.log("📍 Direct Supply: saved the locations from the earlier DCs");
}

/* HSN codes from Snackit's earlier DCs. An item gets one when its name clearly matches
   (same sizes, nearly the same words): filled into Setup → Items once, and used on a DC for
   any item whose HSN is still empty (so items ordered for the first time later get it too). */
const KNOWN_HSN = [
  ["PAPER BOAT MIXED FRUIT (160ML)", "22029920"], ["PAPER BOAT ORANGE (160ML)", "22029920"], ["PAPER BOAT APPLE (160ML)", "22029920"],
  ["FITSUPPORT Hydration Drink ZERO SUGAR (250ML)", "22021090"], ["DIET COKE CAN (330ML)", "220210"],
  ["RED BULL ENERGY DRINK (250ML)", "22029990"], ["RED BULL SUGAR FREE (250ML)", "22029990"],
  ["Nutraj snackrite Crispy nut mix 25gm", "20081920"], ["Nutraj Snackrite Seeds & Berry Mix (25gm)", "20081920"],
  ["yoga bar muesli dark chocolate cranberry", "19041090"], ["Yoga Bar Multigrain Energy Bar Nuts and Seeds (MRP-50)", "21069099"],
  ["YOGA BAR PROTEIN MINI'S COFFEE CRUCH (MRP-20)", "21069099"],
  ["LAYS SPANISH TOMATO (31.2GM)", "21069099"], ["LAYS WEST INDIES HOT N SWEET CHILLI (27.5GM)", "21069099"],
  ["LAYS INDIA'S MAGIC MASALA (27.5GM)", "21069099"], ["LAYS CLASSIC SALT(27.5GM)", "21069099"], ["LAYS CREAM & ONION (27.5GM)", "21069099"],
  ["TOWN BUS MADRAS MIXTURE (45G)", "21069099"], ["Bingo Mad Angles 32g", "21069099"],
  ["RAW COCONUT WATER ALOE LEMON (200ML)", "22029920"],
  ["LIMCA PET BOTTLE (250ML)", "22021010"], ["SPRITE PET BOTTLE (250ML)", "22021010"], ["THUMSUP PET BOTTLE (250ML)", "22021010"],
  ["OREO ORIGINIAL(41.75GM)", "19053100"], ["BRITANNIA GOOD DAY PISTA AND BADAM(52.5GM)", "19053100"],
  ["BRITANNIA GOOD DAY CASHEW COOKIES(60.1GM)", "19053100"], ["BRITANNIA 50-50 MASKA CHASKA(42.7GM)", "19053100"], ["Britannia little hearts", "19053100"],
  ["PARLE MARIE(MRP-10)", "19059020"], ["PARLE MONACO CLASSIC-(52.2gms)", "19059020"], ["Parle G gold (68.75g)", "19059020"],
  ["AKSHAYAKALPA SPICED BUTTERMILK (200ml)", "04039090"], ["AKSHAYAKALPA PLAIN BUTTERMILK (200ML)", "04039090"],
  ["NESCAFE CHOCO MOCHA(180ML)", "22029930"], ["EPIGAMIA TURBO CHOCOLATE PROTEIN MILKSHAKE (250ML)", "22029930"],
  ["EPIGAMIA TURBO VANILLA CARAMEL PROTEIN MILKSHAKE (250ML)", "22029930"],
  ["MINUTE MAID PULPY ORANGE(250ML)", "22029020"], ["CAVIN'S BADAM FLAVOURED MILK (170ML)", "04029990"],
  ["Alo Mixed fruit (300ml)", "20098990"], ["Horlicks 500gm", "19019090"], ["RED LABEL NATURAL CARE(1KG)", "09023030"],
].map(([name, hsn]) => ({ key: cleanName(name), hsn }));

export function knownHsn(...names) {
  let best = null;
  for (const name of names.filter(Boolean)) {
    const key = cleanName(name);
    for (const known of KNOWN_HSN) {
      const score = likeness(key, known.key);
      if (score >= 0.9 && (!best || score > best.score)) best = { hsn: known.hsn, score };
    }
  }
  return best?.hsn || "";
}

async function fillKnownHsn() {
  const { rows: done } = await db.query("SELECT 1 FROM app_settings WHERE key = 'supply_hsn_v1'");
  if (done.length) return;
  const { rows } = await db.query("SELECT id, name, key, aliases FROM supply_products WHERE hsn IS NULL OR hsn = ''");
  let filled = 0;
  for (const product of rows) {
    const hsn = knownHsn(product.name, product.key, ...(product.aliases || []));
    if (hsn) { await db.query("UPDATE supply_products SET hsn = $2 WHERE id = $1", [product.id, hsn]); filled += 1; }
  }
  await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_hsn_v1', $1, NOW()) ON CONFLICT (key) DO NOTHING", [String(filled)]);
  console.log(`🏷️ Direct Supply: filled HSN for ${filled} item(s) from the earlier DCs`);
}

async function seller() {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'supply_seller'").catch(() => ({ rows: [] }));
  try { return JSON.parse(rows[0]?.value || "{}"); } catch { return {}; }
}

// The next DC number from the settings (prefix + number, keeping its zeros), and move it on.
async function nextRef() {
  const value = await seller();
  const prefix = String(value.dc_prefix ?? "DC").trim();
  const next = String(value.dc_next || "1").trim().replace(/\D/g, "") || "1";
  const ref = `${prefix}${next}`;
  const following = String(Number(next) + 1).padStart(next.length, "0");
  await db.query("UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = 'supply_seller'", [JSON.stringify({ ...value, dc_next: following })]);
  return ref;
}

async function imageBuffer(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
    return await sharp(Buffer.from(response.data)).png().toBuffer();
  } catch (err) {
    console.log("DC IMAGE ERROR:", err.message);
    return null;
  }
}

/* What goes on one company's DC. */
async function challanData(round, companyId) {
  const { rows: companies } = await db.query("SELECT * FROM supply_companies WHERE id = $1", [companyId]);
  const company = companies[0];
  const lines = (await companyLines(round.id, companyId)).filter((line) => line.delivered > 0);
  const ids = lines.map((line) => line.product_id).filter(Boolean);
  const [{ rows: products }, { rows: dates }] = await Promise.all([
    db.query("SELECT id, hsn FROM supply_products WHERE id = ANY($1)", [ids]),
    db.query(
      `SELECT DISTINCT ON (product_id) product_id, mfg_date, exp_date FROM supply_purchases
       WHERE round_id = $1 AND product_id = ANY($2) AND (mfg_date IS NOT NULL OR exp_date IS NOT NULL)
       ORDER BY product_id, bought_at DESC`,
      [round.id, ids]
    ),
  ]);
  return {
    company,
    lines: lines.map((line) => ({
      name: line.name,
      hsn: products.find((product) => product.id === line.product_id)?.hsn || knownHsn(line.name),
      exp: dates.find((row) => row.product_id === line.product_id)?.exp_date || "",
      mfg: dates.find((row) => row.product_id === line.product_id)?.mfg_date || "",
      qty: Number(qtyText(line.delivered)),
      unit: UNIT_TEXT[line.unit] || line.unit,
    })),
  };
}

/* ---------- The PDF, laid out like Snackit's DC ---------- */
async function challanPdf({ ref, madeAt, round, company, lines, seller: me }) {
  const [logo, stamp] = await Promise.all([imageBuffer(me.logo_url), imageBuffer(me.stamp_url)]);
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const L = 36;
  const R = 559;
  const W = R - L;
  const ink = "#111111";
  const line = "#7a7a7a";
  const box = (x, y, w, h) => doc.lineWidth(0.7).strokeColor(line).rect(x, y, w, h).stroke();
  const text = (value, x, y, options = {}) => doc.font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 8.5).fillColor(options.color || ink).text(String(value ?? ""), x, y, { width: options.width, align: options.align || "left", lineGap: 1 });
  const heightOf = (value, width, size = 8.5, bold = false) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).heightOfString(String(value ?? ""), { width, lineGap: 1 });
  const placeOfSupply = me.state || "29-Karnataka";
  const when = new Date(new Date(madeAt).getTime() + 5.5 * 3600000);
  const dateText = `${pad(when.getUTCDate())}-${pad(when.getUTCMonth() + 1)}-${when.getUTCFullYear()}, ${when.getUTCHours() % 12 || 12}:${pad(when.getUTCMinutes())} ${when.getUTCHours() < 12 ? "AM" : "PM"}`;

  text("Delivery Challan", L, 30, { bold: true, size: 12, width: W, align: "center" });

  // Seller box | DC number, date, place of supply
  let y = 48;
  const split = L + W * 0.58;
  const sellerX = logo ? L + 70 : L + 8;
  const sellerLines = [me.address, me.phone ? `Phone no.: ${me.phone}` : "", me.email ? `Email: ${me.email}` : "", me.gstin ? `GSTIN: ${me.gstin}` : "", me.state ? `State: ${me.state}` : ""].filter(Boolean).join("\n");
  const sellerHeight = Math.max(86, 14 + heightOf(me.name || "Snackit", split - sellerX - 8, 13, true) + heightOf(sellerLines, split - sellerX - 8, 8) + 8);
  box(L, y, W, sellerHeight);
  doc.moveTo(split, y).lineTo(split, y + sellerHeight).stroke();
  if (logo) doc.image(logo, L + 10, y + 18, { fit: [52, 52], align: "center", valign: "center" });
  text(me.name || "Snackit", sellerX, y + 8, { bold: true, size: 13, width: split - sellerX - 8 });
  text(sellerLines, sellerX, doc.y + 2, { size: 8, width: split - sellerX - 8 });
  const mid = split + (R - split) / 2;
  const rowH = 28;
  doc.moveTo(split, y + rowH).lineTo(R, y + rowH).stroke();
  doc.moveTo(split, y + rowH * 2).lineTo(R, y + rowH * 2).stroke();
  doc.moveTo(mid, y).lineTo(mid, y + rowH * 2).stroke();
  text("Invoice No.", split + 6, y + 4);
  text(ref, split + 6, y + 14, { bold: true });
  text("Date", mid + 6, y + 4);
  text(dateText, mid + 6, y + 14, { bold: true });
  text("Place of supply", split + 6, y + rowH + 4);
  text(placeOfSupply, split + 6, y + rowH + 14, { bold: true });
  y += sellerHeight;

  // Bill To | Ship To
  const billLines = [
    company.address || company.location || "",
    company.contact_no ? `Contact No. : ${company.contact_no}` : "",
    company.gstin ? `GSTIN : ${company.gstin}` : "",
    `State: ${company.state || placeOfSupply}`,
  ].filter(Boolean).join("\n");
  const billName = company.billing_name || company.name;
  // Like Snackit's DCs: a Ship To box only when there is a ship-to; otherwise Bill To is full width.
  const shipText = String(company.ship_to || "").trim();
  const billRight = shipText ? split : R;
  const partyHeight = Math.max(56, 18 + heightOf(billName, billRight - L - 12, 9, true) + heightOf(billLines, billRight - L - 12) + 8, shipText ? 18 + heightOf(shipText, R - split - 12) + 8 : 0);
  box(L, y, W, partyHeight);
  if (shipText) doc.moveTo(split, y).lineTo(split, y + partyHeight).stroke();
  text("Bill To", L + 6, y + 4);
  text(billName, L + 6, y + 18, { bold: true, size: 9, width: billRight - L - 12 });
  text(billLines, L + 6, doc.y + 4, { width: billRight - L - 12 });
  if (shipText) {
    text("Ship To", split + 6, y + 4);
    text(shipText, split + 6, y + 18, { width: R - split - 12 });
  }
  y += partyHeight;

  // Items
  // Exp. / Mfg. columns only when some item has a date (as on Snackit's DCs).
  const withDates = lines.some((item) => item.exp || item.mfg);
  const cols = withDates ? [
    { key: "n", title: "#", w: 22 },
    { key: "name", title: "Item name", w: 170, bold: true },
    { key: "hsn", title: "HSN/ SAC", w: 66 },
    { key: "exp", title: "Exp. Date", w: 66, align: "right" },
    { key: "mfg", title: "Mfg. Date", w: 66, align: "right" },
    { key: "qty", title: "Quantity", w: 70, align: "right" },
    { key: "unit", title: "Unit", w: W - 22 - 170 - 66 * 3 - 70, align: "right" },
  ] : [
    { key: "n", title: "#", w: 26 },
    { key: "name", title: "Item name", w: 245, bold: true },
    { key: "hsn", title: "HSN/ SAC", w: 98 },
    { key: "qty", title: "Quantity", w: 88, align: "right" },
    { key: "unit", title: "Unit", w: W - 26 - 245 - 98 - 88, align: "right" },
  ];
  const drawRow = (cells, top, options = {}) => {
    const h = Math.max(18, ...cols.map((col) => heightOf(cells[col.key], col.w - 8, 8.5, options.bold || col.bold) + 8));
    if (options.fill) doc.rect(L, top, W, h).fill(options.fill);
    let x = L;
    for (const col of cols) {
      box(x, top, col.w, h);
      text(cells[col.key], x + 4, top + 5, { width: col.w - 8, align: col.align, bold: options.bold || col.bold });
      x += col.w;
    }
    return h;
  };
  const header = Object.fromEntries(cols.map((col) => [col.key, col.title]));
  y += drawRow(header, y, { bold: true, fill: "#f2f2f2" });
  lines.forEach((item, index) => {
    const cells = { n: index + 1, name: item.name, hsn: item.hsn, exp: item.exp, mfg: item.mfg, qty: qtyText(item.qty), unit: item.unit };
    const h = Math.max(18, ...cols.map((col) => heightOf(cells[col.key], col.w - 8, 8.5, col.bold) + 8));
    if (y + h > 842 - 36 - 150) { doc.addPage(); y = 36; y += drawRow(header, y, { bold: true, fill: "#f2f2f2" }); }
    y += drawRow(cells, y);
  });
  const total = lines.reduce((sum, item) => sum + item.qty, 0);
  y += drawRow({ n: "", name: "Total", hsn: "", exp: "", mfg: "", qty: qtyText(total), unit: "" }, y, { bold: true });

  // Terms, then signatures (kept together on one page)
  if (y + 150 > 842 - 36) { doc.addPage(); y = 36; }
  const terms = me.terms || "Thanks for doing business with us!";
  const termsHeight = 22 + heightOf(terms, W - 12) + 8;
  box(L, y, W, termsHeight);
  text("Terms and conditions", L + 6, y + 6, { bold: true });
  text(terms, L + 6, y + 20, { width: W - 12 });
  y += termsHeight;
  const signH = 112;
  const third = W / 3;
  box(L, y, W, signH);
  doc.moveTo(L + third, y).lineTo(L + third, y + signH).stroke();
  doc.moveTo(L + third * 2, y).lineTo(L + third * 2, y + signH).stroke();
  for (const [index, title] of ["Received By", "Delivered By:"].entries()) {
    const x = L + third * index + 8;
    text(title, x, y + 8, { bold: true });
    ["Name:", "Comment:", "Date:", "Signature:"].forEach((label, row) => text(label, x, y + 26 + row * 20));
  }
  text(`For : ${me.name || "Snackit"}`, L + third * 2 + 6, y + 10, { width: third - 12, align: "center" });
  if (stamp) doc.image(stamp, L + third * 2 + third / 2 - 40, y + 26, { fit: [80, 56], align: "center", valign: "center" });
  text("Authorized Signatory", L + third * 2 + 6, y + signH - 18, { bold: true, width: third - 12, align: "center" });

  doc.end();
  return done;
}

/* Makes (or makes again) the DCs for a round, one per company with something to deliver.
   Returns [{ company, ref, file }]. */
/* The PDF is kept here and served from this server's own address (Cloudinary blocks PDFs on
   many accounts, which stopped them opening and WhatsApp fetching them). */
const SERVER_URL = String(process.env.PUBLIC_SERVER_URL || process.env.RENDER_EXTERNAL_URL || "https://whatsapp-bot-backend-b3nb.onrender.com").replace(/\/$/, "");
const fileUrl = (token, name) => `${SERVER_URL}/public/supply/dc/${token}/${encodeURIComponent(name)}`;

export async function makeChallans(roundId) {
  const { rows: rounds } = await db.query("SELECT * FROM supply_rounds WHERE id = $1", [roundId]);
  if (!rounds[0]) throw new Error("Delivery date not found");
  const round = { ...rounds[0], delivery_date: plainDate(rounds[0].delivery_date) };
  const me = await seller();
  const { rows: companies } = await db.query("SELECT DISTINCT company_id FROM supply_orders WHERE round_id = $1", [round.id]);
  const made = [];
  for (const { company_id: companyId } of companies) {
    const data = await challanData(round, companyId);
    if (!data.lines.length) continue;
    const { rows: existing } = await db.query("SELECT ref, made_at, file_token FROM supply_challans WHERE round_id = $1 AND company_id = $2", [round.id, companyId]);
    const ref = existing[0]?.ref || await nextRef();
    const madeAt = existing[0]?.made_at || new Date();
    const pdf = await challanPdf({ ref, madeAt, round, company: data.company, lines: data.lines, seller: me });
    const fileName = `DC-${ref}-${data.company.name.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
    const token = existing[0]?.file_token || crypto.randomBytes(18).toString("base64url");
    const url = fileUrl(token, fileName);
    const total = data.lines.reduce((sum, item) => sum + item.qty, 0);
    await db.query(
      `INSERT INTO supply_challans (round_id, company_id, ref, lines, total_qty, pdf_url, made_at, pdf, file_token, file_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (round_id, company_id) DO UPDATE SET lines = EXCLUDED.lines, total_qty = EXCLUDED.total_qty, pdf_url = EXCLUDED.pdf_url,
         pdf = EXCLUDED.pdf, file_token = EXCLUDED.file_token, file_name = EXCLUDED.file_name, sent_at = NULL, send_error = NULL`,
      [round.id, companyId, ref, JSON.stringify(data.lines), total, url, madeAt, pdf, token, fileName]
    );
    made.push({ company: data.company, ref, file: { url, name: fileName }, total });
  }
  onChange();
  return { round, made };
}

/* Makes the DCs and sends them to the buyer's WhatsApp. Returns { made, sent, error }. */
export async function makeAndSendChallans(roundId) {
  const { round, made } = await makeChallans(roundId);
  if (!made.length) return { made: 0, sent: 0, error: "Nothing to deliver for this date" };
  const contact = await buyerContact();
  if (!contact.phone) return { made: made.length, sent: 0, error: "Add the buyer's WhatsApp number in Admin Settings → Direct Supply buyer." };
  const to = phoneDigits(contact.phone);
  const open = await refillerWindowOpen(to);
  if (open) {
    await sendWhatsApp(to, `📄 *Delivery challans · ${dayLabel(round.delivery_date)}* (${round.ref})\n${made.length} DC${made.length === 1 ? "" : "s"}, one per company:\n${made.map((item) => `• ${item.company.name}: ${item.ref} (${qtyText(item.total)} items)`).join("\n")}\n\nPrint each one and send it with that company's delivery.`);
  }
  let sent = 0;
  const problems = [];
  for (const item of made) {
    // Inside WhatsApp's 24 hours: the PDF itself. Outside: the approved supply_buyer_list template
    // with the PDF as its document (one per company).
    const result = open
      ? await sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "document", document: { link: item.file.url, filename: item.file.name, caption: `${item.ref} · ${item.company.name}` } })
      : await sendWhatsAppTemplate(to, "supply_buyer_list", "en", [`the delivery challan ${item.ref} for ${item.company.name}, ${dayLabel(round.delivery_date)},`, String(item.total), item.file.url], [`SBDC:${round.id}`], { link: item.file.url, filename: item.file.name });
    if (result.ok) {
      sent += 1;
      await db.query("UPDATE supply_challans SET sent_at = NOW(), send_error = NULL WHERE round_id = $1 AND company_id = $2", [round.id, item.company.id]);
    } else {
      problems.push(`${item.company.name}: ${result.error || "not accepted"}`);
      await db.query("UPDATE supply_challans SET send_error = $3 WHERE round_id = $1 AND company_id = $2", [round.id, item.company.id, String(result.error || "Not sent").slice(0, 300)]);
    }
  }
  if (problems.length) console.log("DC SEND:", problems.join(" | "));
  onChange();
  const reason = open ? "WhatsApp didn't take some DCs" : `${contact.name || "The buyer"} hasn't messaged the Snackit number in the last 24 hours, and the supply_buyer_list template didn't go (create it in Meta with a Document header, or ask him to send "hi")`;
  return { made: made.length, sent, error: sent < made.length ? `${reason}. You can open and print them from the dashboard.` : null };
}


export function registerSupplyChallanRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: err.message || "Server error" });
    }
  };

  app.get("/supply/rounds/:id/challans", auth, handle("SUPPLY CHALLANS", async (req, res) => {
    const { rows } = await db.query(
      `SELECT ch.id, ch.company_id, ch.ref, ch.total_qty, ch.pdf_url, ch.made_at, ch.sent_at, ch.send_error, (ch.pdf IS NOT NULL) AS has_file, c.name AS company_name
       FROM supply_challans ch JOIN supply_companies c ON c.id = ch.company_id WHERE ch.round_id = $1 ORDER BY c.name`,
      [req.params.id]
    );
    res.json(rows.map((row) => ({ ...row, total_qty: Number(row.total_qty) })));
  }));

  // Make again (after a change) and send to the buyer.
  app.post("/supply/rounds/:id/challans", auth, handle("SUPPLY CHALLANS MAKE", async (req, res) => {
    const result = req.body?.send === false ? { made: (await makeChallans(req.params.id)).made.length, sent: 0 } : await makeAndSendChallans(req.params.id);
    res.locals.activity = { section: "Direct Supply", action: `Made ${result.made} delivery challan(s)${result.sent ? `, sent ${result.sent} to the buyer` : ""}` };
    res.json(result);
  }));

  // The DC PDF (no login: the long random part of the link is the key, like the buyer's page).
  app.get("/public/supply/dc/:token/:name", handle("DC FILE", async (req, res) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(req.params.token)) return res.status(404).send("Not found");
    const { rows } = await db.query("SELECT pdf, file_name FROM supply_challans WHERE file_token = $1", [req.params.token]);
    if (!rows[0]?.pdf) return res.status(404).send("This delivery challan isn't available. Make it again from the dashboard.");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(rows[0].file_name || "DC.pdf").replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(rows[0].pdf);
  }));

  // Snackit's logo or the signatory's stamp for the DC.
  app.post("/supply/seller/image", auth, handle("SUPPLY SELLER IMAGE", async (req, res) => {
    const kind = req.body?.kind === "stamp" ? "stamp" : "logo";
    const file = await storeDashboardFile(req.body?.file || {});
    const value = { ...(await seller()), [`${kind}_url`]: file.url };
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('supply_seller', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(value)]
    );
    res.json(value);
  }));
}
