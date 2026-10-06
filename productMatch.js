/* =========================================================
    PRODUCT NAME MATCHING (Product List ↔ closing stock, DCs, Wendor sales)
    The same product is written many ways: "MAX PROTIEN CHEESE", "Max Protein Cheese & Jalapeno
    (30gms)"; "YOGABAR CRUNCH MIXED BERRIES", "Yoga Bar Crunch Mixed Berries"; "Cadboury Dairy
    Milk Silk", "Cadbury Dairy Milk silk chocolate". Names are compared word by word:
      • a word matches the same word, a small spelling slip (one letter, two in long words),
        or its start ("choco" / "chocolate");
      • two words written together match ("yoga bar" / "yogabar", "town bus" / "townbus");
      • pack sizes must agree when both names have one (30g ≠ 50g), and "MRP-29" packs are
        their own products;
      • a short name inside a longer one counts ("Healthy Master Beetroot").
    similarity() gives 0…1. sure() decides when a match is safe to take without asking.
========================================================= */

const STOP = new Set(["the", "and", "with", "of", "a", "an", "in", "new", "pack", "single", "imported", "flavour", "flavoured", "flavored", "pcs", "pc", "nos"]);
const FIX = { protien: "protein", proteins: "protein", choclate: "chocolate", chocolates: "chocolate", biscuits: "biscuit", cookies: "cookie", chips: "chip", bars: "bar", nuts: "nut", seeds: "seed", milkshakes: "milkshake" };

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = keep;
    }
  }
  return prev[b.length];
}

// "Max Protein Cheese & Jalapeno (30gms)" → { words: [max, protein, cheese, jalapeno], sizes: [30g] }
export function nameParts(raw) {
  let text = String(raw || "").toLowerCase()
    .replace(/['’`]s\b/g, "")
    .replace(/&/g, " and ")
    .replace(/\bmrp\s*[-:.]?\s*(\d+(?:\.\d+)?)/g, " mrp$1 ")
    .replace(/(\d+(?:\.\d+)?)\s*(gms|gm|grams|gram|gr|g)\b/g, " $1g ")
    .replace(/(\d+(?:\.\d+)?)\s*(mls|ml)\b/g, " $1ml ")
    .replace(/(\d+(?:\.\d+)?)\s*(ltrs|ltr|litres|litre|l)\b/g, " $1l ")
    .replace(/(\d+(?:\.\d+)?)\s*(kgs|kg)\b/g, " $1kg ")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\.(?!\d)/g, " ");
  const tokens = text.split(/\s+/).filter(Boolean);
  const words = [];
  const sizes = [];
  for (const token of tokens) {
    if (/^\d+(\.\d+)?(g|ml|l|kg)$/.test(token)) sizes.push(token.replace(/^(\d+)\.0+(?=[a-z])/, "$1"));
    else if (/^mrp\d/.test(token)) sizes.push(token);
    else if (/^\d$/.test(token)) words.push(token); // "7 in 1"
    else if (/^\d+(\.\d+)?$/.test(token)) continue; // stray numbers ("30" after a name)
    else if (!STOP.has(token)) words.push(FIX[token] || token);
  }
  return { words, sizes };
}

function wordsMatch(x, y) {
  if (x === y) return true;
  if (/\d/.test(x) || /\d/.test(y)) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length >= 4 && long.length - short.length <= 4 && long.startsWith(short)) return true; // choco / chocolate (not milk / milkshake)
  if (short.length >= 5) { // coke / cake are different
    const distance = editDistance(x, y);
    return distance <= 1 || (short.length >= 7 && distance <= 2 && x[0] === y[0]);
  }
  return false;
}

// Two words written together in one name and apart in the other.
function joined(words, other) {
  const set = new Set(other);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const pair = words[i] + (words[i + 1] || "");
    if (words[i + 1] && !set.has(words[i]) && [...set].some((word) => word === pair || (pair.length >= 7 && editDistance(word, pair) <= 1))) { out.push(pair); i += 1; }
    else out.push(words[i]);
  }
  return out;
}

export function similarity(a, b) {
  return compare(a, b).score;
}

// { score, dice }: dice = words in common over all words (how alike the whole names are).
function compare(a, b) {
  const pa = typeof a === "string" ? nameParts(a) : a;
  const pb = typeof b === "string" ? nameParts(b) : b;
  const none = { score: 0, dice: 0 };
  if (pa.sizes.length && pb.sizes.length && !pa.sizes.some((size) => pb.sizes.includes(size))) return none;
  const wa = joined(pa.words, pb.words);
  const wb = joined(pb.words, wa);
  if (!wa.length || !wb.length) return none;
  const used = new Array(wb.length).fill(false);
  let matched = 0;
  for (const word of wa) {
    const at = wb.findIndex((other, index) => !used[index] && wordsMatch(word, other));
    if (at >= 0) { used[at] = true; matched += 1; }
  }
  const dice = (2 * matched) / (wa.length + wb.length);
  const cover = matched / Math.min(wa.length, wb.length);
  const round = (value) => Math.round(value * 1000) / 1000;
  // A one-word name ("Twix", "Coke") is only as close as the whole names are.
  if (Math.min(wa.length, wb.length) === 1) return { score: round(dice), dice: round(dice) };
  // One word in common is too little to say anything.
  if (matched < 2) return { score: round(Math.min(dice, 0.4)), dice: round(dice) };
  return { score: round(0.5 * dice + 0.5 * cover), dice: round(dice) };
}

/* The best products for a name. candidates: [{ id, name, price, parts? }].
   price (optional): the price written with the name (a closing stock's MRP) — a product with the
   same price is preferred when names are equally close. */
export function bestMatches(name, candidates, { price = null, limit = 3 } = {}) {
  const parts = nameParts(name);
  return candidates
    .map((candidate) => {
      const result = compare(parts, candidate.parts || nameParts(candidate.name));
      let score = result.score;
      if (score > 0 && price != null && candidate.price != null && Number(candidate.price) === Number(price)) score = Math.min(1, score + 0.05);
      return { ...candidate, score: Math.round(score * 1000) / 1000, dice: result.dice };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

// Safe to link without asking: very close, or close and well ahead of the next one.
export function sure(matches) {
  const [first, second] = matches;
  if (!first) return null;
  const lead = first.score - (second?.score || 0);
  if (first.dice < 0.8) return null; // e.g. "Cocojal Coconut Water" vs "Cocojal Mango Tender Coconut Water": ask
  if (first.score >= 0.92 && lead >= 0.05) return first;
  if (first.score >= 0.85 && lead >= 0.15) return first;
  return null;
}
