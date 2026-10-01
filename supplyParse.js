/* =========================================================
    DIRECT SUPPLY · reading orders and matching item names
    Company admins send orders as WhatsApp text or Excel. Each line becomes
    { name, qty, unit }. Names are compared after cleaning ("Lays Classic 52 gm"
    and "lays classic 52g" are the same item), and a close-but-different name is
    offered as "same item?" so the master sheet combines it once confirmed.
========================================================= */

const UNIT_WORDS = {
  pcs: ["pcs", "pc", "piece", "pieces", "nos", "no", "unit", "units", "qty"],
  dozen: ["dozen", "dozens", "dz", "doz"],
  kg: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"],
  box: ["box", "boxes", "case", "cases", "carton", "cartons", "ctn"],
  pkt: ["pkt", "pkts", "packet", "packets", "pack", "packs"],
  bottle: ["bottle", "bottles", "btl", "btls"],
  l: ["ltr", "ltrs", "litre", "litres", "liter", "liters", "l"],
  bunch: ["bunch", "bunches"],
  tray: ["tray", "trays"],
};
const UNIT_OF = Object.fromEntries(Object.entries(UNIT_WORDS).flatMap(([unit, words]) => words.map((word) => [word, unit])));
const UNIT_PATTERN = Object.values(UNIT_WORDS).flat().sort((a, b) => b.length - a.length).join("|");
export const UNITS = ["pcs", "kg", "box", "pkt", "bottle", "l", "bunch", "tray"];

// "dozen" is counted in pieces; any other unit is kept as written.
export function normaliseUnit(word, qty) {
  const unit = UNIT_OF[String(word || "").toLowerCase()] || "pcs";
  if (unit === "dozen") return { unit: "pcs", qty: qty * 12 };
  return { unit, qty };
}

// The name used for matching: lower case, sizes written one way ("52 gm" → "52g"), no punctuation.
export function cleanName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/(\d+(?:\.\d+)?)\s*(gms|gm|grams|gram|g)\b/g, "$1g")
    .replace(/(\d+(?:\.\d+)?)\s*(mls|ml)\b/g, "$1ml")
    .replace(/(\d+(?:\.\d+)?)\s*(ltrs|ltr|litres|litre|liters|liter|l)\b/g, "$1l")
    .replace(/(\d+(?:\.\d+)?)\s*(kgs|kg)\b/g, "$1kg")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// How a name is shown: tidy spacing, first letters capitalised.
export function displayName(raw) {
  const tidy = String(raw || "").replace(/\s+/g, " ").replace(/^[\s\-–•*:]+|[\s\-–•*:,]+$/g, "").trim();
  return tidy
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase())
    .replace(/(\d+(?:\.\d+)?)\s*(gms|gm|grams|gram|g)\b/gi, "$1g")
    .replace(/(\d+(?:\.\d+)?)\s*(mls|ml)\b/gi, "$1ml")
    .replace(/(\d+(?:\.\d+)?)\s*(ltrs|ltr|litres|litre|liters|liter|l)\b/gi, "$1L")
    .replace(/(\d+(?:\.\d+)?)\s*(kgs|kg)\b/gi, "$1kg");
}

const HEADER_WORDS = /^(s\.?\s*no|sl\.?\s*no|sr\.?\s*no|item|items|product|products|particulars?|description|name|qty|quantity|order|orders|total|date|unit)\b/i;
const QTY = "(\\d+(?:\\.\\d+)?)";

// One line of an order: "Lays Classic 52g - 20", "20 x Coke 300ml", "Banana 5 kg", "Kurkure 2 dozen".
export function parseLine(line) {
  let text = String(line || "").replace(/\u00a0/g, " ").trim();
  if (!text || !/[a-z]/i.test(text)) return null;
  // Copied from Excel: columns separated by tabs.
  if (text.includes("\t")) return parseCells(text.split("\t"));
  text = text.replace(/^\s*(\d{1,3}[.)]|[-*•])\s+/, "").trim(); // "1. ", "2) ", "- ", "• "
  if (HEADER_WORDS.test(text) && !/\d/.test(text)) return null;

  const atEnd = text.match(new RegExp(`^(.*?[a-z].*?)[\\s:\\-–=x×*,]+${QTY}\\s*(${UNIT_PATTERN})?\\.?\\s*$`, "i"));
  if (atEnd) return finish(atEnd[1], Number(atEnd[2]), atEnd[3]);
  const atStart = text.match(new RegExp(`^${QTY}\\s*(${UNIT_PATTERN})?\\s*(?:x|×|\\*|-|of)?\\s+(.*[a-z].*)$`, "i"));
  if (atStart) return finish(atStart[3], Number(atStart[1]), atStart[2]);
  return finish(text, null, null);
}

function finish(rawName, qty, unitWord) {
  const name = displayName(rawName);
  if (!name || !/[a-z]/i.test(name)) return null;
  if (qty == null) return { name, qty: 0, unit: "pcs", problem: "Quantity missing" };
  const unit = normaliseUnit(unitWord, qty);
  return { name, qty: unit.qty, unit: unit.unit };
}

// A row of cells (Excel or tab-separated): the first text cell is the item, the first number after it the quantity.
export function parseCells(cells, columns = null) {
  const values = cells.map((cell) => String(cell ?? "").trim());
  if (columns) {
    const name = values[columns.name];
    const qtyText = String(values[columns.qty] ?? "").replace(/,/g, "");
    if (!name || !/[a-z]/i.test(name)) return null;
    const qtyMatch = qtyText.match(new RegExp(`^${QTY}\\s*(${UNIT_PATTERN})?`, "i"));
    const unitWord = columns.unit != null ? values[columns.unit] : qtyMatch?.[2];
    return qtyMatch ? finish(name, Number(qtyMatch[1]), unitWord) : finish(name, null, null);
  }
  const nameIndex = values.findIndex((value) => /[a-z]/i.test(value) && !/^\d+(\.\d+)?$/.test(value));
  if (nameIndex < 0) return null;
  if (HEADER_WORDS.test(values[nameIndex]) && !values.some((value, index) => index > nameIndex && /^\d/.test(value))) return null;
  for (let index = nameIndex + 1; index < values.length; index += 1) {
    const match = values[index].replace(/,/g, "").match(new RegExp(`^${QTY}\\s*(${UNIT_PATTERN})?$`, "i"));
    if (match) {
      const next = values[index + 1];
      const unitWord = match[2] || (next && UNIT_OF[next.toLowerCase()] ? next : null);
      return finish(values[nameIndex], Number(match[1]), unitWord);
    }
  }
  return parseLine(values.filter(Boolean).join(" "));
}

// Pasted text (WhatsApp message or copied Excel): one item per line.
export function parseText(text) {
  return String(text || "").split(/\r?\n/).map(parseLine).filter(Boolean);
}

// Excel or CSV rows (arrays of cells): a header row, if there is one, says which column is what.
export function parseRows(rows) {
  const headerIndex = rows.slice(0, 10).findIndex((row) => row.some((cell) => /^(item|product|particulars?|description|name|item name|product name)\b/i.test(String(cell).trim()))
    && row.some((cell) => /^(qty|quantity|qnty|nos|count|order qty|required)\b/i.test(String(cell).trim())));
  let columns = null;
  if (headerIndex >= 0) {
    const header = rows[headerIndex].map((cell) => String(cell).trim().toLowerCase());
    columns = {
      name: header.findIndex((cell) => /^(item|product|particulars?|description|name|item name|product name)\b/.test(cell)),
      qty: header.findIndex((cell) => /^(qty|quantity|qnty|nos|count|order qty|required)\b/.test(cell)),
      unit: header.findIndex((cell) => /^(unit|uom|units)\b/.test(cell)),
    };
    if (columns.unit < 0) columns.unit = null;
  }
  return rows.slice(headerIndex + 1).map((row) => parseCells(row, columns)).filter(Boolean);
}

/* ---------- Matching against known items ---------- */

const numbersIn = (name) => (name.match(/\d+(?:\.\d+)?[a-z]*/g) || []).sort().join(" ");

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

// 0..1: how alike two cleaned names are. Different sizes ("52g" vs "90g") never count as alike.
export function likeness(a, b) {
  if (a === b) return 1;
  if (numbersIn(a) !== numbersIn(b)) return 0;
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  const jaccard = shared / new Set([...wordsA, ...wordsB]).size;
  const spelling = 1 - editDistance(a.replace(/ /g, ""), b.replace(/ /g, "")) / Math.max(a.length, b.length);
  return Math.max(jaccard, spelling);
}

/* products: [{ id, key, aliases: [keys] }]. Returns { product_id } for a sure match,
   { suggestion_id } for a likely one, or {} for a new item. */
export function matchName(name, products) {
  const key = cleanName(name);
  const exact = products.find((product) => product.key === key || (product.aliases || []).includes(key));
  if (exact) return { product_id: exact.id, key };
  let best = null;
  for (const product of products) {
    for (const candidate of [product.key, ...(product.aliases || [])]) {
      const score = likeness(key, candidate);
      if (score >= 0.72 && (!best || score > best.score)) best = { id: product.id, score };
    }
  }
  return best ? { suggestion_id: best.id, key } : { key };
}
