/* =========================================================
    UPI SCREENSHOT READER
    Reads the text on a customer's payment screenshot with Tesseract
    (free, runs on this server) and picks out the UTR, amount, UPI IDs,
    date, status and app. Results are saved on the ticket with warning
    flags for the support team. Nothing is sent to an outside service.
========================================================= */
import axios from "axios";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { imageFingerprint } from "./ticketWatch.js";

// The English language file ships with the app (no download at start-up, so it works even
// when the server can't reach the internet).
const require = createRequire(import.meta.url);
const LANG_PATH = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");

let db = null;
let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
const IDLE_MS = 5 * 60 * 1000;

export async function ensureUpiScanColumns(database) {
  db = database;
  await db.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS upi_scan JSONB,
      ADD COLUMN IF NOT EXISTS upi_utr TEXT,
      ADD COLUMN IF NOT EXISTS screenshot_upi_id TEXT,
      ADD COLUMN IF NOT EXISTS upi_scanned_at TIMESTAMPTZ
  `);
  await db.query("CREATE INDEX IF NOT EXISTS tickets_upi_utr_idx ON tickets (upi_utr)");
}

// One reader is kept and reused; the language data downloads once per start.
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, { langPath: LANG_PATH, cachePath: os.tmpdir(), gzip: true })
      // Sparse mode finds text of any size anywhere on the screen, like the big ₹ amount.
      .then(async (worker) => { await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); return worker; })
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

// Two versions of the screenshot are read: a clean grey one (dark mode flipped
// to dark-on-light) and a pure black-and-white one, which catches white text on
// coloured banners. Both are resized to phone width so the big ₹ amount is read.
async function prepareImages(buffer) {
  const base = sharp(buffer).rotate().greyscale().resize({ width: 1000 });
  const { channels } = await sharp(buffer).greyscale().stats();
  const isDark = channels[0].mean < 110;
  const clean = await (isDark ? base.clone().negate({ alpha: false }) : base.clone()).normalise().png().toBuffer();
  const blackWhite = await base.clone().threshold(140).png().toBuffer();
  return [clean, blackWhite];
}

const APPS = [
  ["Google Pay", /google\s*pay|\bg\s*pay\b/i],
  ["PhonePe", /phone\s*pe/i],
  ["Paytm", /paytm/i],
  ["BHIM", /\bbhim\b/i],
  ["Amazon Pay", /amazon\s*pay/i],
  ["CRED", /\bcred\b/i],
  ["Navi", /\bnavi\b/i],
  ["super.money", /super\.?\s*money/i],
];

const EMAIL_DOMAINS = /^(gmail|yahoo|outlook|hotmail|icloud|rediffmail|live)$/i;

// UPI IDs look like name@bank; the bank part has no dot (unlike email addresses).
// Google Pay hides the start of IDs ("••••01-3@okhdfcbank"); those are kept with the dots
// and marked as partly hidden, so nobody mistakes the visible part for the full ID.
function findUpiIds(lines) {
  const found = [];
  lines.forEach((line, index) => {
    const pattern = /([a-z0-9][a-z0-9._-]{1,255})\s?@\s?([a-z][a-z0-9]{1,63})(?![a-z0-9]*\.[a-z])/gi;
    for (const match of line.matchAll(pattern)) {
      if (EMAIL_DOMAINS.test(match[2])) continue;
      const before = line.slice(0, match.index);
      const masked = /[•*+«·.:~-]{2,}\s*$/.test(before);
      const id = `${masked ? "••••" : ""}${match[1]}@${match[2]}`.toLowerCase();
      if (!found.some((item) => item.id === id)) found.push({ id, index, masked });
    }
  });
  return found;
}

// Decides whether a UPI ID belongs to the payer or the payee from the words just above it.
function roleOf(lines, index) {
  const context = ` ${lines.slice(Math.max(0, index - 3), index + 1).join(" ").toLowerCase()}`;
  const fromAt = Math.max(context.lastIndexOf("from"), context.lastIndexOf("debited"), context.lastIndexOf("sender"), context.lastIndexOf("your upi"));
  const toAt = Math.max(context.lastIndexOf(" to "), context.lastIndexOf("paid to"), context.lastIndexOf("to:"), context.lastIndexOf("received by"), context.lastIndexOf("merchant"), context.lastIndexOf("banking name"));
  if (fromAt === -1 && toAt === -1) return null;
  return fromAt > toAt ? "payer" : "payee";
}

function findUtr(text) {
  const joined = text.replace(/(\d)[ ](?=\d)/g, "$1");
  const labelled = joined.match(/(?:utr|upi\s*ref(?:erence)?(?:\s*(?:no|number|id))?|upi\s*transaction\s*id|transaction\s*id|txn\s*id|ref(?:erence)?\s*(?:no|number)|rrn)[\s.:#-]*\n?\s*([0-9]{12})\b/i);
  if (labelled) return labelled[1];
  const bare = joined.match(/(?<![0-9])([0-9]{12})(?![0-9])/);
  return bare ? bare[1] : null;
}

function findAmount(lines) {
  // Wording used by the apps, e.g. "Payment of ₹72 completed", "Paid ₹72", "₹72 sent".
  const joined = lines.join(" ");
  const worded = joined.match(/(?:payment of|paid|amount paid|you paid|sent|debited)\s*(?:₹|rs\.?|inr|[%zZF])?\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{1,5}(?:\.[0-9]{1,2})?)\b(?!\s*(?:%|am|pm|:))/i);
  if (worded && Number(worded[1].replace(/,/g, "")) > 0) return Number(worded[1].replace(/,/g, ""));
  const number = "([0-9]{1,3}(?:,[0-9]{2,3})+(?:\\.[0-9]{1,2})?|[0-9]{1,5}(?:\\.[0-9]{1,2})?)";
  for (const line of lines) {
    const labelled = line.match(new RegExp(`(?:₹|\\brs\\.?|\\binr|amount(?: paid)?)\\s*:?\\s*${number}\\b`, "i"));
    if (labelled) return Number(labelled[1].replace(/,/g, ""));
  }
  // The big amount sits on its own line; OCR often reads ₹ as X, <, T, %, Z or F.
  for (const line of lines) {
    const alone = line.trim().match(new RegExp(`^(?:[₹xX<T%zZF]{1,2}\\s?)?${number}$`));
    if (alone) {
      const value = Number(alone[1].replace(/,/g, ""));
      if (value > 0 && value < 100000) return value;
    }
  }
  return null;
}

function findStatus(text) {
  if (/fail(ed|ure)?|declined|unsuccessful/i.test(text)) return "FAILED";
  if (/pending|processing|in progress/i.test(text)) return "PENDING";
  if (/success(ful(ly)?)?|completed|paid|sent|debited|received/i.test(text)) return "SUCCESS";
  return null;
}

function findDate(text) {
  const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
  const patterns = [
    new RegExp(`\\b(\\d{1,2})\\s*(${months})[a-z]*[,\\s]+(\\d{4})`, "i"),
    new RegExp(`\\b(${months})[a-z]*\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"),
    /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/,
  ];
  const date = patterns.map((pattern) => text.match(pattern)?.[0]).find(Boolean) || null;
  const time = text.match(/\b(\d{1,2}:\d{2})(?::\d{2})?\s*(am|pm)?\b/i)?.[0] || null;
  return date || time ? [date, time].filter(Boolean).join(" ") : null;
}

export function parseUpiText(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const upiIds = findUpiIds(lines);
  // The screenshot shows both sides of the payment; only the customer's (payer's) UPI ID is kept.
  let payer = null;
  let payee = null;
  for (const { id, index } of upiIds) {
    const role = roleOf(lines, index);
    if (role === "payee" && !payee) payee = id;
    else if (role === "payer" && !payer) payer = id;
  }
  if (!payer) payer = upiIds.map((item) => item.id).find((id) => id !== payee) || null;

  return {
    utr: findUtr(text),
    amount: findAmount(lines),
    payer_upi: payer,
    upi_ids: upiIds.map((item) => item.id),
    status: findStatus(text),
    paid_at: findDate(text),
    app: APPS.find(([, pattern]) => pattern.test(text))?.[0] || null,
  };
}

async function buildFlags(ticket, result) {
  const flags = [];
  if (!result.utr && !result.amount && !result.upi_ids.length) flags.push("Could not read payment details. Check the screenshot yourself.");
  if (result.status === "FAILED") flags.push("Screenshot shows a FAILED payment.");
  if (result.status === "PENDING") flags.push("Screenshot shows a PENDING payment.");
  const typed = String(ticket.upi_id || "").trim().toLowerCase();
  const visible = String(result.payer_upi || "").replace(/^••••/, "");
  const matchesTyped = result.payer_upi?.startsWith("••••") ? typed.endsWith(visible) : typed === result.payer_upi;
  if (typed.includes("@") && result.payer_upi && !matchesTyped) flags.push(`Customer typed UPI ID ${typed}, screenshot shows ${result.payer_upi}.`);
  if (result.utr) {
    const duplicate = await db.query(
      "SELECT id, phone FROM tickets WHERE upi_utr = $1 AND id <> $2 ORDER BY id LIMIT 3",
      [result.utr, ticket.id]
    );
    if (duplicate.rows.length) flags.push(`Same UTR already used in ticket ${duplicate.rows.map((row) => `#${row.id} (${row.phone})`).join(", ")}.`);
  }
  return flags;
}

// Reads one screenshot. Details come from the first pass; the second only fills what the first missed.
export async function readUpiImage(buffer) {
  const worker = await getWorker();
  const passes = [];
  for (const prepared of await prepareImages(buffer)) {
    const { data } = await worker.recognize(prepared);
    passes.push(data);
  }
  const [first, second] = passes.map((data) => parseUpiText(data.text));
  const result = Object.fromEntries(Object.entries(first).map(([key, value]) => [key, (Array.isArray(value) ? value.length : value != null) ? value : second[key]]));
  return { result, data: { text: passes.map((pass) => pass.text).join("\n-----\n"), confidence: passes[0].confidence } };
}

async function scanNow(ticketId) {
  const { rows } = await db.query("SELECT id, phone, upi_id, upi_image FROM tickets WHERE id = $1", [ticketId]);
  const ticket = rows[0];
  if (!ticket?.upi_image) return null;

  const started = Date.now();
  const image = await axios.get(ticket.upi_image, { responseType: "arraybuffer", timeout: 20000 });
  const buffer = Buffer.from(image.data);
  const { result, data } = await readUpiImage(buffer);
  // Lets the dashboard spot the same screenshot sent on another ticket.
  await imageFingerprint(buffer)
    .then((hash) => db.query("UPDATE tickets SET upi_image_hash = $1 WHERE id = $2", [hash, ticketId]))
    .catch((err) => console.log(`SCREENSHOT FINGERPRINT ticket #${ticketId}:`, err.message));
  const scan = {
    ...result,
    confidence: Math.round(data.confidence || 0),
    flags: await buildFlags(ticket, result),
    text: String(data.text || "").slice(0, 4000),
    image: ticket.upi_image,
    ms: Date.now() - started,
  };
  // The customer's UPI ID from the screenshot is shown on the dashboard. The ticket's own
  // upi_id column holds the transaction ID the customer gave, so it is never overwritten.
  // The amount paid also becomes the refund amount when nobody has set one yet (editable on the dashboard).
  const saveScan = () => db.query(
    `UPDATE tickets SET upi_scan = $1, upi_utr = $2, screenshot_upi_id = $3, upi_scanned_at = NOW(),
       refund_amount = CASE WHEN COALESCE(NULLIF(refund_amount::text, '')::numeric, 0) = 0 AND $5::numeric > 0 THEN $6 ELSE refund_amount END
     WHERE id = $4`,
    [JSON.stringify(scan), result.utr, result.payer_upi, ticketId, result.amount ?? null, result.amount != null ? String(result.amount) : null]
  );
  try {
    await saveScan();
  } catch (err) {
    // e.g. paise in a whole-rupee column: keep the reading, leave the refund amount alone.
    console.log(`UPI SCAN SAVE (refund amount skipped) ticket #${ticketId}:`, err.message);
    await db.query(
      "UPDATE tickets SET upi_scan = $1, upi_utr = $2, screenshot_upi_id = $3, upi_scanned_at = NOW() WHERE id = $4",
      [JSON.stringify(scan), result.utr, result.payer_upi, ticketId]
    );
  }
  console.log(`🔎 UPI scan ticket #${ticketId}: UTR ${result.utr || "-"}, ₹${result.amount ?? "-"}, ${result.payer_upi || "no UPI ID"} (${scan.ms}ms)`);
  return scan;
}

// The reader holds ~100 MB, so it is closed after a few quiet minutes.
function closeWhenIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const pending = workerPromise;
    workerPromise = null;
    if (pending) (await pending.catch(() => null))?.terminate().catch(() => {});
  }, IDLE_MS);
}

// Screenshots are read one at a time so the server never runs several at once.
export function scanUpiScreenshot(ticketId) {
  if (!db) return Promise.resolve(null);
  clearTimeout(idleTimer);
  const job = queue.then(() => scanNow(ticketId)).finally(closeWhenIdle);
  queue = job.catch((err) => console.error(`UPI SCAN ERROR ticket #${ticketId}:`, err.message));
  return job;
}

// After a restart, recent screenshots that were never read are read in the background.
export async function readMissedScreenshots(limit = 40) {
  if (!db) return;
  try {
    // Screenshots read before amounts filled the refund amount: fill it now where it's still empty.
    const filled = await db.query(
      `UPDATE tickets SET refund_amount = (upi_scan->>'amount')::numeric
       WHERE upi_scan->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$' AND COALESCE(NULLIF(refund_amount::text, '')::numeric, 0) = 0
       RETURNING id`
    ).catch((err) => { console.log("REFUND AMOUNT FILL SKIPPED:", err.message); return { rows: [] }; });
    if (filled.rows.length) console.log(`💰 Refund amount filled from screenshots on ${filled.rows.length} ticket(s)`);
    const { rows } = await db.query(
      `SELECT id FROM tickets WHERE upi_image IS NOT NULL AND upi_scan IS NULL AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    if (rows.length) console.log(`🔎 Reading ${rows.length} UPI screenshot(s) that were missed`);
    for (const row of rows) scanUpiScreenshot(row.id).catch(() => {});
  } catch (err) {
    console.log("UPI BACKFILL ERROR:", err.message);
  }
}

export function registerUpiScanRoutes(app, { auth }) {
  // Read (or re-read) a ticket's UPI screenshot on demand.
  app.post("/tickets/:id/scan-upi", auth, async (req, res) => {
    try {
      const scan = await scanUpiScreenshot(Number(req.params.id));
      if (!scan) return res.status(404).json({ error: "This ticket has no UPI screenshot." });
      res.json(scan);
    } catch (err) {
      res.status(500).json({ error: `Could not read the screenshot: ${err.message}` });
    }
  });
}
