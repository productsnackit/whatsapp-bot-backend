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
import { applyPaidMachine } from "./siteMatcher.js";
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
// Told when a screenshot has been read, so open dashboards refresh the tickets list.
let scanListener = null;
// Bumped when the reader gets better; open tickets read by an older version are read again.
const SCAN_VERSION = 4;

export async function ensureUpiScanColumns(database) {
  db = database;
  await db.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS upi_scan JSONB,
      ADD COLUMN IF NOT EXISTS upi_utr TEXT,
      ADD COLUMN IF NOT EXISTS screenshot_upi_id TEXT,
      ADD COLUMN IF NOT EXISTS upi_scanned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payments JSONB,
      ADD COLUMN IF NOT EXISTS product_received BOOLEAN,
      ADD COLUMN IF NOT EXISTS charged_times INTEGER
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

// White text on a coloured banner (BHIM green, Paytm blue, PhonePe purple): the darkest of the
// three colour channels keeps white text bright and makes any colour dark; flipped, that is
// dark text on a light page, which OCR reads well. Used only when the amount is still unclear.
async function prepareBannerImage(buffer) {
  const { data, info } = await sharp(buffer).rotate().removeAlpha().resize({ width: 1000 }).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height);
  for (let i = 0, p = 0; p < out.length; i += info.channels, p += 1) out[p] = Math.min(data[i], data[i + 1], data[i + 2]);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).negate().normalise().png().toBuffer();
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

/* ---------- Transaction IDs ----------
   Every UPI payment has a 12-digit UPI reference (UTR / RRN), which banks use; each app
   labels it its own way. Apps also show their own ID in their own format. Both are kept:
     PhonePe:    "UTR: 320611846360"             · "PhonePe Transaction ID: T2609291346455865133796"
     Paytm:      "UPI Ref No: 627262914457"      · sometimes "Order ID" / "Transaction ID" (long number)
     Google Pay: "UPI transaction ID: 66310…"    · "Google transaction ID: CICAgPii0sS80g"      */
const UTR_LABEL = String.raw`(?:\bu[t1il]r\b(?:\s*(?:no|number))?|upi\s*ref(?:erence)?\.?(?:\s*(?:no|number|id))?|upi\s*transaction\s*id|\brrn\b|bank\s*ref(?:erence)?\.?(?:\s*(?:no|number))?)`;
const OTHER_ID_LABEL = String.raw`(?:transaction\s*id|txn\s*id|ref(?:erence)?\.?\s*(?:no|number))`;
const TWELVE = String.raw`[\s.:#-]*\n?\s*([0-9]{12})(?![0-9])`;

export function findIds(text, app) {
  // "3206 1184 6360" → "320611846360"
  const joined = String(text || "").replace(/(\d)[ ](?=\d)/g, "$1");
  const utr = joined.match(new RegExp(UTR_LABEL + TWELVE, "i"))?.[1]
    || joined.match(new RegExp(OTHER_ID_LABEL + TWELVE, "i"))?.[1]
    || joined.match(/(?<![0-9A-Za-z])([0-9]{12})(?![0-9])/)?.[1]
    || null;

  let appId = null;
  let appLabel = null;
  // PhonePe: T + 22 digits, e.g. T2609291346455865133796 (OCR may read the T as 7, 1 or I, or drop it).
  const phonepe = joined.match(/phone\s*pe\s*transaction\s*id[\s:]*\n?\s*([T7I1l]?\d{21,23})\b/i) || joined.match(/\b(T\d{21,23})\b/);
  if (phonepe) {
    const raw = phonepe[1];
    appId = /^[T7I1l]\d{22}$/.test(raw) ? `T${raw.slice(1)}` : /^\d{22}$/.test(raw) ? `T${raw}` : raw;
    appLabel = "PhonePe transaction ID";
  }
  const google = !appId && joined.match(/google\s*transaction\s*id[\s:]*\n?\s*([A-Za-z0-9]{10,24})\b/i);
  if (google) {
    appId = google[1];
    appLabel = "Google transaction ID";
  }
  // Paytm and others: a long order / transaction ID that isn't the 12-digit UPI reference.
  const other = !appId && joined.match(/(?:order\s*id|paytm\s*transaction\s*id|transaction\s*id|txn\s*id)[\s.:#-]*\n?\s*([A-Za-z0-9]{14,32})\b/i);
  if (other && other[1] !== utr) {
    appId = other[1];
    appLabel = `${app || "App"} ${/order/i.test(other[0]) ? "order ID" : "transaction ID"}`;
  }
  return { utr, app_txn_id: appId, app_txn_label: appLabel };
}

/* ---------- Amount ----------
   The English OCR model has no ₹ sign, so it reads it as another character: "R25", "¥25",
   "%25", or even a digit ("₹25" → "325"). Every place the amount appears, in every reading
   of the screenshot, gives a vote; the amount most readings agree on wins. When they don't
   agree, or the amount is implausible for a vending machine, it is marked uncertain so it is
   checked by a person and never filled in as the refund amount automatically. */
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const RUPEE = "(₹|rs\\.?|inr|[rzxft%<&$€£¥?])";
const NUMBER = "(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d{1,6}(?:\\.\\d{1,2})?)";
// Most vending purchases are small; a bigger amount is shown but always checked by a person.
const MAX_PLAUSIBLE_AMOUNT = Number(process.env.UPI_MAX_AMOUNT) || 2000;

// "Rupees Twenty Five Only" (Paytm and others print the amount in words too).
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE_WORDS = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000 };
function editDistanceSmall(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
function closeWord(word, list) {
  if (list[word] !== undefined) return word;
  if (word.length < 4) return null;
  // One OCR slip allowed: "flve", "twentv".
  return Object.keys(list).find((known) => Math.abs(known.length - word.length) <= 1 && editDistanceSmall(known, word) <= 1) || null;
}
export function amountFromWords(text) {
  const match = String(text || "").match(/\brupees?\b([a-z\s-]{3,120}?)\bonly\b/i);
  if (!match) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const raw of match[1].toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (raw === "and") continue;
    const number = closeWord(raw, NUMBER_WORDS);
    const scale = !number && closeWord(raw, SCALE_WORDS);
    if (number) { current += NUMBER_WORDS[number]; seen = true; }
    else if (scale === "hundred") { current = (current || 1) * 100; seen = true; }
    else if (scale) { total += (current || 1) * SCALE_WORDS[scale]; current = 0; seen = true; }
    else if (raw === "paise" || raw === "paisa") break;
    else return null; // a word we don't understand: don't guess
  }
  return seen ? total + current : null;
}

function amountValue(raw) {
  const value = Number(String(raw || "").replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 && value < 100000 ? value : null;
}

// "₹25" read as "325": the number without its first digit is a (weaker) candidate too.
function withoutMisreadRupee(raw) {
  const [whole, paise] = String(raw).replace(/,/g, "").split(".");
  if (whole.length < 2 || !/^[237]/.test(whole) || whole[1] === "0") return null;
  return amountValue(`${whole.slice(1)}${paise ? `.${paise}` : ""}`);
}

function amountVotes(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const votes = [];
  const add = (value, weight) => { if (value != null) votes.push({ value, weight }); };
  const phrase = new RegExp(`\\b(?:payment of|amount paid|you paid|paid|amount|debited|sent|total)\\b\\s*:?\\s*${RUPEE}?\\s?${NUMBER}(?![\\d:])(?!\\s*(?:${MONTHS}|am\\b|pm\\b|%))`, "i");
  const realRupee = new RegExp(`(?:₹|\\brs\\.?|\\binr)\\s?${NUMBER}(?![\\d:])`, "gi");
  // The big amount on its own line; icons beside it (a tick badge read as "&", "©", "@") are allowed.
  const alone = new RegExp(`^${RUPEE}?\\s?${NUMBER}(?:\\s+(?:[^\\w\\s]{1,3}|[a-z]))?$`, "i");

  // The amount in words is the most reliable reading there is.
  const inWords = amountFromWords(lines.join(" "));
  if (inWords) add(amountValue(String(inWords)), 4);

  lines.forEach((line, index) => {
    // "Payment of ₹25 completed", "Paid ₹25", "Amount: ₹25", "₹25 debited".
    const worded = line.match(phrase);
    if (worded) {
      if (worded[1]) add(amountValue(worded[2]), 3);
      else {
        add(amountValue(worded[2]), 2);
        add(withoutMisreadRupee(worded[2]), 1.5);
      }
    }
    // A ₹ or Rs that OCR did read correctly.
    for (const match of line.matchAll(realRupee)) add(amountValue(match[1]), 3);
    // The big amount on its own line.
    const big = !worded && line.match(alone);
    if (big) {
      const raw = big[2];
      const digits = raw.replace(/[,.]/g, "");
      const value = amountValue(raw);
      // Not an amount: account suffixes ("0548", or 4 digits under the bank's name) and years.
      const accountSuffix = /^0/.test(raw) || (digits.length === 4 && /\bbank\b/i.test(lines[index - 1] || ""));
      const year = !big[1] && value >= 2000 && value <= 2100 && Number.isInteger(value);
      // A lone single digit is usually an icon read as text, not an amount.
      const iconNoise = !big[1] && digits.length === 1;
      // "Paid" / "Payment successful" just above it, or paise ("25.00"), make it the payment's amount.
      const statusAbove = /\b(paid|paid successfully|payment successful|successful|success|sent|received|debited|completed|amount)\W*$/i.test(lines[index - 1] || "");
      const paise = /\.\d{2}$/.test(raw);
      if (!accountSuffix && !year && !iconNoise && digits.length <= 6) {
        if (big[1]) add(value, statusAbove ? 3.5 : 2.5);
        else {
          add(value, statusAbove ? 3 : paise ? 1.5 : 1);
          add(withoutMisreadRupee(raw), 0.5);
        }
      }
    }
  });
  return votes;
}

// texts: every OCR reading of the same screenshot.
export function voteAmount(texts) {
  // The amount in words, confirmed by the digits (the big "₹120 ✓" is often read as "31200"
  // or "120@", which still contain 120), is certain whatever else was read.
  const inWords = texts.map(amountFromWords).find(Boolean);
  if (inWords) {
    const digitRuns = texts.flatMap((text) => String(text || "").replace(/,/g, "").match(/\d+/g) || []);
    // Only a number of about the same length confirms it (not a 12-digit UTR that happens to contain "5").
    const confirms = (run) => run.includes(String(inWords)) && run.length <= String(inWords).length + 2;
    if (digitRuns.some(confirms)) return { amount: inWords, uncertain: false, options: [inWords] };
  }

  const totals = new Map();
  let all = 0;
  for (const text of texts) {
    for (const { value, weight } of amountVotes(text)) {
      totals.set(value, (totals.get(value) || 0) + weight);
      all += weight;
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { amount: null, uncertain: false, options: [] };
  const [amount, score] = ranked[0];
  const uncertain = score / all < 0.6 || score < 2.5 || amount > MAX_PLAUSIBLE_AMOUNT;
  return { amount, uncertain, options: ranked.slice(0, 3).map(([value]) => value) };
}

function findAmount(lines) {
  return voteAmount([lines.join("\n")]).amount;
}

/* A ₹ sign read as a digit ("₹25" → "325") is told apart from a real 2, 3 or 7 by its shape:
   ₹ has bars across the top and a leg that ends in the middle, so its lower-left corner and
   middle-right are empty, where a 2 or 3 has ink (and a 7 has no second bar on the left). */
async function inkGrid(image, bbox, lightInk) {
  const meta = await sharp(image).metadata();
  const left = Math.max(0, bbox.x0);
  const top = Math.max(0, bbox.y0);
  const width = Math.min(meta.width, bbox.x1) - left;
  const height = Math.min(meta.height, bbox.y1) - top;
  if (width < 4 || height < 6) return null;
  const { data, info } = await sharp(image).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const ink = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const cells = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const value = data[(y * info.width + x) * info.channels];
      const row = Math.min(3, Math.floor((y / info.height) * 4));
      const col = Math.min(3, Math.floor((x / info.width) * 4));
      cells[row][col] += 1;
      if (lightInk ? value > 128 : value < 128) ink[row][col] += 1;
    }
  }
  return ink.map((row, r) => row.map((count, c) => count / cells[r][c]));
}

function looksLikeRupee(grid) {
  if (!grid) return false;
  return grid[3][0] < 0.12 // lower-left corner empty (a 2 or 3 curls into it)
    && grid[2][2] < 0.15 && grid[2][3] < 0.15 // middle-right empty (a 3 bulges there)
    && grid[1][0] + grid[1][1] > 0.3 // second bar reaches the left (a 7 has none)
    && grid[0][1] + grid[0][2] > 1.0; // bar across the top
}

// Whether the text in this box is light on dark (white on a green BHIM banner in an otherwise
// white screenshot): decided by the pixels just around the word, not by the whole screenshot.
async function isLightInk(image, bbox) {
  const meta = await sharp(image).metadata();
  const pad = 6;
  const left = Math.max(0, bbox.x0 - pad);
  const top = Math.max(0, bbox.y0 - pad);
  const width = Math.min(meta.width, bbox.x1 + pad) - left;
  const height = Math.min(meta.height, bbox.y1 + pad) - top;
  const { data, info } = await sharp(image).extract({ left, top, width, height }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let count = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (y >= pad && y < info.height - pad && x >= pad && x < info.width - pad) continue;
      sum += data[(y * info.width + x) * info.channels];
      count += 1;
    }
  }
  return count > 0 && sum / count < 128;
}

// Numbers in one OCR reading whose first "digit" is really ₹: { "325" → "₹25" }.
async function rupeeFixes(image, data) {
  const fixes = new Map();
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = String(word.text || "");
          if (!/^[237][\d,]*\d(?:\.\d{1,2})?$/.test(text) || (word.symbols || []).length < 2) continue;
          const lightInk = await isLightInk(image, word.bbox).catch(() => false);
          if (looksLikeRupee(await inkGrid(image, word.symbols[0].bbox, lightInk).catch(() => null))) fixes.set(text, `₹${text.slice(1)}`);
        }
      }
    }
  }
  return fixes;
}

function applyFixes(text, fixes) {
  let fixed = String(text || "");
  for (const [wrong, right] of fixes) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    fixed = fixed.replace(new RegExp(`(^|[^\\d,.])${escaped}(?![\\d,])`, "g"), `$1${right}`);
  }
  return fixed;
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
    ...findIds(text, APPS.find(([, pattern]) => pattern.test(text))?.[0] || null),
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
  if (result.amount != null && result.amount_uncertain) {
    const others = (result.amount_options || []).filter((value) => value !== result.amount).map((value) => `₹${value}`);
    flags.push(`Amount not clear on the screenshot: probably ₹${result.amount}${others.length ? ` (could be ${others.join(" or ")})` : ""}. Check it and enter the refund amount yourself.`);
  }
  const typed = String(ticket.upi_id || "").trim().toLowerCase();
  const visible = String(result.payer_upi || "").replace(/^••••/, "");
  const matchesTyped = result.payer_upi?.startsWith("••••") ? typed.endsWith(visible) : typed === result.payer_upi;
  if (typed.includes("@") && result.payer_upi && !matchesTyped) flags.push(`Customer typed UPI ID ${typed}, screenshot shows ${result.payer_upi}.`);
  if (result.utr) {
    const duplicate = await db.query(
      `SELECT id, phone FROM tickets
       WHERE id <> $2 AND (upi_utr = $1
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(payments, '[]'::jsonb)) p WHERE p->>'utr' = $1))
       ORDER BY id LIMIT 3`,
      [result.utr, ticket.id]
    );
    if (duplicate.rows.length) flags.push(`Same transaction already used in ticket ${duplicate.rows.map((row) => `#${row.id} (${row.phone})`).join(", ")}.`);
  }
  return flags;
}

// Reads one screenshot. Details come from the first pass; the second only fills what the first missed.
export async function readUpiImage(buffer) {
  const worker = await getWorker();
  const passes = [];
  const fixes = new Map();
  for (const prepared of await prepareImages(buffer)) {
    // Word and letter boxes too, to check the shape of an amount's first character.
    const { data } = await worker.recognize(prepared, {}, { text: true, blocks: true });
    passes.push(data);
    for (const [wrong, right] of await rupeeFixes(prepared, data).catch(() => new Map())) fixes.set(wrong, right);
  }
  const [first, second] = passes.map((data) => parseUpiText(data.text));
  const result = Object.fromEntries(Object.entries(first).map(([key, value]) => [key, (Array.isArray(value) ? value.length : value != null) ? value : second[key]]));
  // The amount is voted on across the readings (see voteAmount). If it's still unclear, the
  // screenshot is read once more for white text on a coloured banner.
  let vote = voteAmount(passes.map((pass) => applyFixes(pass.text, fixes)));
  if (vote.uncertain || vote.amount == null) {
    const banner = await prepareBannerImage(buffer).catch(() => null);
    if (banner) {
      const { data } = await worker.recognize(banner, {}, { text: true, blocks: true });
      passes.push(data);
      for (const [wrong, right] of await rupeeFixes(banner, data).catch(() => new Map())) fixes.set(wrong, right);
      vote = voteAmount(passes.map((pass) => applyFixes(pass.text, fixes)));
    }
  }
  result.amount = vote.amount;
  result.amount_uncertain = vote.uncertain;
  result.amount_options = vote.options;
  return { result, data: { text: passes.map((pass) => pass.text).join("\n-----\n"), confidence: passes[0].confidence } };
}

async function scanNow(ticketId) {
  const { rows } = await db.query(
    `SELECT id, phone, upi_id, upi_image, refund_amount::text AS refund_amount, upi_scan->>'amount' AS old_amount,
       jsonb_array_length(COALESCE(payments, '[]'::jsonb)) AS payment_count
     FROM tickets WHERE id = $1`,
    [ticketId]
  );
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
    v: SCAN_VERSION,
    confidence: Math.round(data.confidence || 0),
    flags: await buildFlags(ticket, result),
    text: String(data.text || "").slice(0, 4000),
    image: ticket.upi_image,
    ms: Date.now() - started,
  };
  // The customer's UPI ID from the screenshot is shown on the dashboard. The ticket's own
  // upi_id column holds the transaction ID the customer gave, so it is never overwritten.
  // The amount paid also becomes the refund amount when nobody has set one yet (editable on the
  // dashboard), but only when the reading is sure. A refund amount that an earlier reading
  // filled in (it still equals that reading) follows the new reading; one a person typed is kept.
  // "Charged more than once" tickets have several payments: their refund is worked out from all of them.
  const current = Number(String(ticket.refund_amount || "").trim() || 0);
  const autoFilled = !ticket.payment_count && (!current || (ticket.old_amount != null && current === Number(ticket.old_amount)));
  const newRefund = result.amount != null && !result.amount_uncertain ? String(result.amount) : null;
  const saveScan = () => db.query(
    `UPDATE tickets SET upi_scan = $1, upi_utr = $2, screenshot_upi_id = $3, upi_scanned_at = NOW(),
       refund_amount = CASE WHEN $5 THEN $6 ELSE refund_amount END
     WHERE id = $4`,
    [JSON.stringify(scan), result.utr, result.payer_upi, ticketId, autoFilled && (newRefund !== null || current > 0), newRefund]
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
  // The machine paid ("paid to snackitvv00002") sets the ticket's location (see machines.js).
  const machine = await applyPaidMachine(ticketId, [...(result.upi_ids || []), data.text].join("\n")).catch((err) => { console.log(`MACHINE READ ticket #${ticketId}:`, err.message); return null; });
  if (machine) {
    scan.machine = machine.code;
    await db.query("UPDATE tickets SET upi_scan = jsonb_set(upi_scan, '{machine}', to_jsonb($2::text)) WHERE id = $1", [ticketId, machine.code]).catch(() => {});
  }
  console.log(`🔎 UPI scan ticket #${ticketId}: UTR ${result.utr || "-"}, ₹${result.amount ?? "-"}, ${result.payer_upi || "no UPI ID"}${machine ? `, machine ${machine.code} (${machine.location})` : ""} (${scan.ms}ms)`);
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
  const job = queue.then(() => scanNow(ticketId)).then((scan) => { if (scan) scanListener?.(); return scan; }).finally(closeWhenIdle);
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
         AND COALESCE(upi_scan->>'amount_uncertain', 'false') <> 'true'
         AND jsonb_array_length(COALESCE(payments, '[]'::jsonb)) = 0
       RETURNING id`
    ).catch((err) => { console.log("REFUND AMOUNT FILL SKIPPED:", err.message); return { rows: [] }; });
    if (filled.rows.length) console.log(`💰 Refund amount filled from screenshots on ${filled.rows.length} ticket(s)`);
    // Never read, or (for tickets still open) read by an older, less accurate version.
    const { rows } = await db.query(
      `SELECT id FROM tickets
       WHERE upi_image IS NOT NULL AND images_deleted_at IS NULL AND created_at > NOW() - INTERVAL '30 days'
         AND (upi_scan IS NULL OR (
           COALESCE(upi_scan->>'v', '1') <> $2
           AND COALESCE(state, '') <> 'CLOSED'
           AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'auto_closed', 'resolved', 'refunded', 'auto_refunded')
         ))
       ORDER BY id DESC LIMIT $1`,
      [limit, String(SCAN_VERSION)]
    ).catch(() => db.query(
      `SELECT id FROM tickets WHERE upi_image IS NOT NULL AND upi_scan IS NULL AND created_at > NOW() - INTERVAL '30 days'
       ORDER BY id DESC LIMIT $1`,
      [limit]
    ));
    if (rows.length) console.log(`🔎 Reading ${rows.length} UPI screenshot(s) (missed, or read by an older version)`);
    for (const row of rows) scanUpiScreenshot(row.id).catch(() => {});
  } catch (err) {
    console.log("UPI BACKFILL ERROR:", err.message);
  }
}

export function registerUpiScanRoutes(app, { auth, onScanned }) {
  scanListener = onScanned || null;

  // The full text read from a screenshot ("Show all text read"); the tickets list leaves it out.
  app.get("/tickets/:id/scan-text", auth, async (req, res) => {
    const { rows } = await db.query("SELECT upi_scan->>'text' AS text FROM tickets WHERE id = $1", [req.params.id]).catch(() => ({ rows: [] }));
    res.json({ text: rows[0]?.text || "" });
  });

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
