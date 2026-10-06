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
  // Two letters swapped ("museli" / "muesli") count as one slip.
  if (prev[b.length] === 2 && a.length === b.length) {
    const diff = [...a].map((ch, i) => (ch === b[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return 1;
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
  if (short.length === 3 && long.length === 4 && long.startsWith(short)) return true; // yum / yumm
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

// { score, dice, cover }: dice = words in common over all words (how alike the whole names are);
// cover = share of the shorter name's words found in the other.
function compare(a, b) {
  const pa = typeof a === "string" ? nameParts(a) : a;
  const pb = typeof b === "string" ? nameParts(b) : b;
  const none = { score: 0, dice: 0, cover: 0 };
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
  // The same pack size written in both names is a little closer.
  const sameSize = pa.sizes.length && pb.sizes.length ? 0.03 : 0;
  // A one-word name ("Twix", "Coke") is only as close as the whole names are.
  if (Math.min(wa.length, wb.length) === 1) return { score: round(dice), dice: round(dice), cover: round(matched / wa.length) };
  // One word in common is too little to say anything.
  if (matched < 2) return { score: round(Math.min(dice, 0.4)), dice: round(dice), cover: round(matched / wa.length) };
  // cover here: how much of the name being matched (a) is in the product (b).
  return { score: round(Math.min(1, 0.5 * dice + 0.5 * cover + sameSize)), dice: round(dice), cover: round(matched / wa.length) };
}

/* The best products for a name. candidates: [{ id, name, price, parts? }].
   price (optional): the price written with the name (a closing stock's MRP) — a product with the
   same price is preferred when names are equally close. */
export function bestMatches(name, candidates, { price = null, limit = 8 } = {}) {
  const parts = nameParts(name);
  return candidates
    .map((candidate) => {
      const result = compare(parts, candidate.parts || nameParts(candidate.name));
      let score = result.score;
      const samePrice = price != null && candidate.price != null && Number(candidate.price) === Number(price);
      if (score > 0 && samePrice) score = Math.min(1, score + 0.05);
      return { ...candidate, score: Math.round(score * 1000) / 1000, dice: result.dice, cover: result.cover, same_price: samePrice, words: parts.words.length };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

// Safe to link without asking (matches from bestMatches, best first):
//   • very close, or close and well ahead of the next one — a product listed twice (two IDs,
//     names nearly the same) is not "another one", the closest of them is taken;
//   • or every word of the name is in exactly one product, at the same price as written with the
//     name ("RITEBITE ALMOND MOCHA" ₹45 → "Rite Bite Sports Bar Almond Mocha …" ₹45).
export function sure(matches) {
  if (!matches.length) return null;
  // Prefer, among equally close ones, the same price as written with the name.
  const ordered = [...matches].sort((x, y) => y.score - x.score || (y.same_price ? 1 : 0) - (x.same_price ? 1 : 0));
  const first = ordered[0];
  const isTwin = (a, b) => similarity(a.parts || a.name, b.parts || b.name) >= 0.93;
  const rivals = ordered.slice(1).filter((other) => !isTwin(first, other));
  const lead = first.score - (rivals[0]?.score || 0);
  if (first.dice >= 0.8 && first.score >= 0.92 && lead >= 0.05) return first;
  if (first.dice >= 0.8 && first.score >= 0.85 && lead >= 0.15) return first;
  // Neck and neck, but only the first is at the written price ("DIET COKE CAN" ₹50 → "Diet Coke" ₹50).
  if (first.dice >= 0.8 && first.score >= 0.9 && first.same_price && rivals.every((other) => !other.same_price || first.score - other.score >= 0.15)) return first;
  // Every word found in one product only, at the written price, and no other product of that
  // price comes close ("Cocojal Coconut Water" ₹60 has "Cocojal" and "Cocojal Mango" at ₹60: ask).
  const whole = ordered.filter((match) => match.cover === 1 && match.words >= 2);
  const groups = [];
  for (const match of whole) if (!groups.some((group) => isTwin(group, match))) groups.push(match);
  if (groups.length !== 1) return null;
  const pick = whole.find((match) => match.same_price);
  if (!pick) return null;
  const close = ordered.filter((other) => other !== pick && !isTwin(pick, other) && other.same_price && other.score >= 0.5);
  return close.length ? null : pick;
}
