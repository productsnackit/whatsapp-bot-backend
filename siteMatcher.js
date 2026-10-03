/* =========================================================
    SITE MATCHING
    Customers answer "where is the machine?" in their own words ("Quay
    Building, Amagi tech park banglore", "nutanix 3rd floor", "NT-3").
    This finds which of our sites (Refill Audit → Locations) they mean,
    allowing small spelling mistakes, and saves it on the ticket next to
    what they typed, so analytics count real sites.
      - site:   one site clearly matched;
      - group:  a company with several sites (e.g. "Alorica") but not which one;
      - machine: read from the payment screenshot's machine ID (see machines.js);
      - named:  one of our machines' locations (machine list) that isn't a Refill Audit site;
      - manual: set by someone on the dashboard;
      - none:   nothing matched.
    When someone sets the site by hand they can keep the customer's wording
    as an extra name for that site, so it matches by itself next time.
========================================================= */

import { ensureMachines, allMachines, linkMachine, findMachine } from "./machines.js";

let db = null;
let cache = { at: 0, sites: [] };
let onTicketsChanged = null;

// Notes in site names that customers never type ("Awfis ebay (less sales)").
const NOTE_WORDS = new Set(["less", "sales", "average", "avg"]);
// Words that say nothing about which site it is; a remembered wording matches on the rest,
// so "Quay Building, Baghmane Tech Park Banglore" also matches "quay baghmane 3rd floor".
const GENERIC_WORDS = new Set(`bangalore banglore bengaluru bengalore bangaluru blr karnataka india pvt ltd private limited
  office floor ground first second third fourth fifth sixth 1st 2nd 3rd 4th 5th 6th 7th 8th 9th 10th tech park building bldg
  tower block wing gate lobby level area sector phase street road rd main cross layout nagar near opposite opp the in at of on
  and my our is it this machine vending snackit cafeteria cafe canteen pantry campus company side inside`.split(/\s+/).filter(Boolean));
const COMPLAINT_WORDS = /\b(money|debited|deducted|refund|payment|paid|amount|rupees|rs|not dispensed|dispense|product|stuck|received|charged|wrong|damaged|expired|help|please)\b/i;
const distinctiveWords = (text) => tokensOf(text).filter((word) => !GENERIC_WORDS.has(word) && !/^\d+$/.test(word));

export function normaliseText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    // "NT 3", "nt-3" and "NT3" are the same building.
    .replace(/\b([a-z]{1,3}) (\d{1,2})\b/g, "$1$2")
    .trim();
}
const tokensOf = (text) => normaliseText(text).split(" ").filter(Boolean);

function editDistance(a, b) {
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

// Same word, allowing a typo in longer words ("baghmane" ~ "bagmane", "caterpiller" ~ "caterpillar").
function sameWord(a, b) {
  if (a === b) return true;
  const length = Math.min(a.length, b.length);
  if (length < 5 || /\d/.test(a + b)) return false;
  return editDistance(a, b) <= (length >= 8 ? 2 : 1);
}

function phraseIn(tokens, phrase) {
  if (!phrase.length) return false;
  for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    if (phrase.every((word, offset) => sameWord(tokens[start + offset], word))) return true;
  }
  return false;
}

function describe(site) {
  const name = String(site.name || "");
  const core = tokensOf(name.replace(/\([^)]*\)/g, " ")).filter((word) => !NOTE_WORDS.has(word));
  const qualifiers = [...name.matchAll(/\(([^)]*)\)/g)].flatMap((match) => tokensOf(match[1])).filter((word) => !NOTE_WORDS.has(word));
  const aliases = (site.aliases || []).map(distinctiveWords).filter((alias) => alias.length);
  return { id: site.id, name, display: name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim() || name, core, qualifiers, aliases };
}

async function loadSites() {
  if (Date.now() - cache.at < 60000) return cache.sites;
  const { rows } = await db.query("SELECT id, name, COALESCE(aliases, '{}') AS aliases FROM audit_locations ORDER BY id").catch(() => ({ rows: [] }));
  cache = { at: Date.now(), sites: rows.map(describe).filter((site) => site.core.length || site.aliases.length) };
  return cache.sites;
}

// The site a customer's text points to: { site_id, site_name, site_match }.
export function matchText(text, sites) {
  const raw = String(text || "");
  const tokens = tokensOf(raw);
  if (!tokens.length) return { site_id: null, site_name: null, site_match: "none" };
  const compact = tokens.join("");
  const found = [];
  for (const site of sites) {
    let score = 0;
    const coreCompact = site.core.join("");
    // Very short names ("NI", "ZF") only count when written in capitals, not inside ordinary words.
    const shortName = site.core.length === 1 && coreCompact.length <= 2;
    const coreHit = shortName
      ? new RegExp(`\\b${coreCompact}\\b`).test(raw.toLowerCase()) && new RegExp(`\\b${coreCompact.toUpperCase()}\\b`).test(raw)
      : phraseIn(tokens, site.core) || (coreCompact.length >= 5 && compact.includes(coreCompact));
    if (coreHit) score = 2 * site.core.length + site.qualifiers.filter((word) => tokens.some((token) => sameWord(token, word))).length;
    // A remembered wording: all of its distinctive words, in any order.
    for (const alias of site.aliases) {
      if (alias.every((word) => tokens.some((token) => sameWord(token, word)))) score = Math.max(score, 3 + 2 * alias.length);
    }
    if (score) found.push({ site, score });
  }
  // Nothing whole matched: the company name alone ("alorica" for "Alorica nitish").
  if (!found.length) {
    for (const site of sites) {
      const brand = site.core[0];
      if (brand && brand.length >= 5 && tokens.some((token) => sameWord(token, brand))) found.push({ site, score: 1 });
    }
  }
  if (!found.length) return { site_id: null, site_name: null, site_match: "none" };
  const best = Math.max(...found.map((item) => item.score));
  const top = found.filter((item) => item.score === best);
  if (top.length === 1) {
    const { site } = top[0];
    // Only the company word matched ("alorica") and the company has other sites: don't guess which.
    const brandOnly = site.core.length === 1 && best === 2;
    const siblings = sites.filter((other) => other !== site && other.core[0] === site.core[0]);
    if (!brandOnly || !siblings.length) return { site_id: site.id, site_name: site.name, site_match: "site" };
    return { site_id: null, site_name: site.display.split(" ")[0], site_match: "group" };
  }
  // Several sites of one company: keep the company ("Alorica") for analytics.
  const first = top[0].site.core;
  let shared = 0;
  while (shared < first.length && top.every((item) => item.site.core[shared] === first[shared])) shared += 1;
  if (!shared) return { site_id: null, site_name: null, site_match: "none" };
  const words = top[0].site.display.split(" ");
  return { site_id: null, site_name: words.slice(0, Math.max(1, Math.min(shared, words.length))).join(" "), site_match: "group" };
}

/* ---------- Matching on the machines' addresses ----------
   Customers often type the building or area, not the company ("Bagmane Laurel 5th floor",
   "prestige technostar", "kudlu gate"). Each machine's address is compared word by word
   (small spelling mistakes allowed); words that say nothing ("road", "bengaluru", "floor",
   pin codes) are ignored, and words found in many addresses count less. A floor the customer
   wrote ("5th floor", "ground floor") picks between machines in the same building. */
const ADDRESS_NOISE = new Set(`no sy survey plot unit level municipal ward khata katha opp opposite near behind next above adjacent junction
  bengaluru bangalore banglore karnataka hyderabad telangana mumbai maharashtra chennai tamil nadu kolkata west bengal pune goa kochi keralam kerala
  delhi haryana gurugram india hobli taluk rd road main cross street layout nagar extension stage phase block sector area industrial indst
  ground floor floors campus building bldg tower towers wing park tech business centre center office hub internal service ring outer intermediate
  pvt ltd east north south new old the and of off`.split(/\s+/).filter(Boolean));
const addressWords = (text) => [...new Set(tokensOf(text).filter((word) => word.length >= 3 && !/\d/.test(word) && !GENERIC_WORDS.has(word) && !ADDRESS_NOISE.has(word)))];
const floorOf = (text) => {
  const raw = String(text || "").toLowerCase();
  if (/\b(ground|gf|g\s*floor)\b/.test(raw)) return "ground";
  const found = raw.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:floor|flr|fl)\b/) || raw.match(/\bfloor\s*(\d{1,2})\b/);
  return found ? String(Number(found[1])) : null;
};

function matchAddress(text, machines) {
  const typed = addressWords(text);
  if (!typed.length) return null;
  // How many different addresses each word appears in (rarer words say more).
  const addresses = [...new Set(machines.map((machine) => machine.address).filter(Boolean))];
  const seen = new Map();
  for (const address of addresses) for (const word of addressWords(address)) seen.set(word, (seen.get(word) || 0) + 1);
  const scored = [];
  for (const machine of machines) {
    if (!machine.address) continue;
    const words = addressWords(machine.address);
    let score = 0;
    let hits = 0;
    let rareHit = false;
    for (const word of words) {
      if (!typed.some((token) => sameWord(token, word))) continue;
      hits += 1;
      const spread = seen.get(word) || 1;
      score += 1 / spread;
      if (spread === 1 && word.length >= 3) rareHit = true;
    }
    // Sure enough: two address words, or one word found in only one address.
    if (hits >= 2 || rareHit) scored.push({ machine, score });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((item) => item.score));
  let top = scored.filter((item) => item.score >= best - 1e-9).map((item) => item.machine);
  // Several machines in that building: the floor they wrote picks one.
  const floor = floorOf(text);
  if (top.length > 1 && floor) {
    const onFloor = top.filter((machine) => floorOf(machine.location) === floor);
    if (onFloor.length) top = onFloor;
  }
  if (top.length === 1) return { machine: top[0] };
  // Still several: one company ("PWC") is still useful; different companies are not.
  const company = (machine) => tokensOf(machine.location)[0];
  if (top.every((machine) => company(machine) === company(top[0]))) return { group: machine0Name(top) };
  return null;
}
const machine0Name = (machines) => {
  const words = machines.map((machine) => String(machine.location).split(/\s+/));
  let shared = 0;
  while (words.every((list) => list[shared] && list[shared].toLowerCase() === words[0][shared].toLowerCase())) shared += 1;
  return words[0].slice(0, Math.max(1, shared)).join(" ").replace(/[-–]+$/, "");
};

// A machine's location: its Refill Audit site when linked, else the machine list's name.
const fromMachine = (machine, how) => ({ site_id: machine.site_id || null, site_name: machine.site_name || machine.location, site_match: how === "screenshot" ? "machine" : machine.site_id ? "site" : "named" });

export async function matchSite(text) {
  if (!db) return { site_id: null, site_name: null, site_match: "none" };
  // A machine ID typed by the customer ("vv00017") says exactly where.
  const typedMachine = await findMachine(text).catch(() => null);
  if (typedMachine) return fromMachine(typedMachine, "typed");
  const result = matchText(text, await loadSites());
  if (result.site_match === "site") return result;
  const machines = await allMachines();
  // The machine list's location names ("Sony 3rd floor", "Refyne").
  const named = matchText(text, machines.map((machine) => describe({ id: machine.code, name: machine.location, aliases: [] })).filter((site) => site.core.length));
  if (named.site_match === "site") return fromMachine(machines.find((machine) => machine.code === named.site_id), "typed");
  // Only the company was clear ("Alorica"): its machines' addresses and floors may say which one.
  const groupName = result.site_match === "group" ? result.site_name : named.site_match === "group" ? named.site_name : null;
  if (groupName) {
    const key = normaliseText(groupName);
    const ofCompany = machines.filter((machine) => normaliseText(machine.location).startsWith(key));
    const picked = ofCompany.length ? matchAddress(text, ofCompany) : null;
    if (picked?.machine) return fromMachine(picked.machine, "typed");
    const floor = floorOf(text);
    const onFloor = floor ? ofCompany.filter((machine) => floorOf(machine.location) === floor) : [];
    if (onFloor.length === 1) return fromMachine(onFloor[0], "typed");
    return result.site_match === "group" ? result : { site_id: null, site_name: groupName, site_match: "group" };
  }
  // The building or area they typed, from the machines' addresses.
  const byAddress = matchAddress(text, machines);
  if (byAddress?.machine) return fromMachine(byAddress.machine, "typed");
  if (byAddress?.group) return { site_id: null, site_name: byAddress.group, site_match: "group" };
  return result;
}

/* The payment screenshot names the machine paid (snackitvv00002): that sets the ticket's site,
   unless someone set it by hand. Returns the machine or null. */
export async function applyPaidMachine(ticketId, text) {
  if (!db) return null;
  const machine = await findMachine(text);
  if (!machine) return null;
  const site = fromMachine(machine, "screenshot");
  const { rowCount } = await db.query(
    `UPDATE tickets SET paid_machine = $2, site_id = $3, site_name = $4, site_match = $5
     WHERE id = $1 AND COALESCE(site_match, '') <> 'manual'`,
    [ticketId, machine.code, site.site_id, site.site_name, site.site_match]
  );
  if (!rowCount) await db.query("UPDATE tickets SET paid_machine = $2 WHERE id = $1", [ticketId, machine.code]);
  onTicketsChanged?.();
  return machine;
}

// Matches again every ticket not set by hand (after sites or their extra names change).
export async function rematchTickets() {
  if (!db) return 0;
  const { rows } = await db.query(
    `SELECT id, location, site_id, site_name, site_match FROM tickets
     WHERE NULLIF(TRIM(COALESCE(location, '')), '') IS NOT NULL AND COALESCE(site_match, '') NOT IN ('manual', 'machine')`
  );
  let changed = 0;
  for (const ticket of rows) {
    const result = await matchSite(ticket.location);
    if (result.site_id === ticket.site_id && result.site_name === ticket.site_name && result.site_match === ticket.site_match) continue;
    await db.query("UPDATE tickets SET site_id = $2, site_name = $3, site_match = $4 WHERE id = $1", [ticket.id, result.site_id, result.site_name, result.site_match]);
    changed += 1;
  }
  if (changed) {
    console.log(`📍 Site matching: ${changed} ticket(s) updated`);
    onTicketsChanged?.();
  }
  return changed;
}

export async function ensureSiteMatching(database, { onChanged } = {}) {
  db = database;
  onTicketsChanged = onChanged || null;
  await db.query("ALTER TABLE audit_locations ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}'");
  await db.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS site_id INTEGER,
      ADD COLUMN IF NOT EXISTS site_name TEXT,
      ADD COLUMN IF NOT EXISTS site_match TEXT
  `);
  cache.at = 0;
  // The machine list, each machine linked to the Refill Audit site with its name (when clear).
  await ensureMachines(db).catch((err) => console.log("MACHINES SETUP ERROR:", err.message));
  const sites = await loadSites();
  let linked = 0;
  for (const machine of await allMachines()) {
    if (machine.site_id) continue;
    const result = matchText(machine.location, sites);
    if (result.site_match !== "site") continue;
    // "Sony 2nd Floor" is not the site "Sony (3rd floor)".
    const machineFloor = floorOf(machine.location);
    const siteFloor = floorOf(result.site_name);
    if (machineFloor && siteFloor && machineFloor !== siteFloor) continue;
    await linkMachine(machine.code, result.site_id);
    linked += 1;
  }
  if (linked) console.log(`🔢 Machines: ${linked} linked to Refill Audit locations`);
  await rematchTickets();
}

export function registerSiteRoutes(app, { auth }) {
  // Sites to choose from on the tickets page.
  app.get("/tickets/sites", auth, async (req, res) => {
    const { rows } = await db.query("SELECT id, name, COALESCE(aliases, '{}') AS aliases FROM audit_locations ORDER BY name").catch(() => ({ rows: [] }));
    res.json(rows);
  });

  // Sets a ticket's site by hand; "remember" keeps the customer's wording as another name for it.
  app.post("/tickets/:id/site", auth, async (req, res) => {
    try {
      const { rows } = await db.query("SELECT id, location FROM tickets WHERE id = $1", [req.params.id]);
      const ticket = rows[0];
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      const siteId = Number(req.body?.site_id) || null;
      if (!siteId) {
        // Back to automatic matching.
        const result = await matchSite(ticket.location);
        await db.query("UPDATE tickets SET site_id = $2, site_name = $3, site_match = $4 WHERE id = $1", [ticket.id, result.site_id, result.site_name, result.site_match]);
        onTicketsChanged?.();
        return res.json(result);
      }
      const site = (await db.query("SELECT id, name, COALESCE(aliases, '{}') AS aliases FROM audit_locations WHERE id = $1", [siteId])).rows[0];
      if (!site) return res.status(400).json({ error: "That site doesn't exist" });
      await db.query("UPDATE tickets SET site_id = $2, site_name = $3, site_match = 'manual' WHERE id = $1", [ticket.id, site.id, site.name]);
      let remembered = null;
      const wording = String(ticket.location || "").trim().replace(/\s+/g, " ").slice(0, 120);
      // Never remembered: wordings of only generic words (they'd match everything) and complaints
      // typed into the location question ("Money has been debited from my account").
      const worthRemembering = distinctiveWords(wording).length && !COMPLAINT_WORDS.test(wording);
      if (req.body?.remember && worthRemembering && !site.aliases.some((alias) => normaliseText(alias) === normaliseText(wording))) {
        await db.query("UPDATE audit_locations SET aliases = array_append(COALESCE(aliases, '{}'), $2) WHERE id = $1", [site.id, wording]);
        remembered = wording;
        cache.at = 0;
        rematchTickets().catch(() => {});
      }
      res.locals.activity = { section: "Tickets", action: `Set ticket #${ticket.id}'s site to ${site.name}${remembered ? ` (remembered "${remembered}")` : ""}` };
      onTicketsChanged?.();
      res.json({ site_id: site.id, site_name: site.name, site_match: "manual", remembered });
    } catch (err) {
      console.log("SET SITE ERROR:", err.message);
      res.status(500).json({ error: "Could not set the site" });
    }
  });
}
