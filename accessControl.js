/* =========================================================
    ACCESS CONTROL
    Every person logs in with their own account. A role (Admin, Support
    agent, Quality auditor, Operations, Staff, Viewer) ticks the pages they
    can open, and an admin can tick/untick pages per person. Passwords are
    stored scrambled (scrypt), so nobody can read them, only reset them.
========================================================= */
import crypto from "crypto";

// Pages a person can be given. Internal Chat and Notifications are always on.
export const PAGES = {
  tickets: "Tickets & customer chat",
  feedback: "Feedback",
  products: "Product leads",
  // "operations" (inventory, clients, brands, demand, imports) is hidden on the dashboard; add it back here to offer it again.
  audit: "Refill Audit",
  findings: "Internal Audit",
  refills: "Refill Schedule",
  live_stock: "Live Stock",
  closing_stock: "Closing Stock",
  product_list: "Product List",
  supply: "Fruits & Direct Supply",
  analytics: "Refund Analytics",
  activity: "Activity log",
  settings: "Bot settings",
};
const ALL_PAGES = Object.keys(PAGES);

export const ROLE_PRESETS = {
  // A director has everything an admin has (all pages, settings, employees); only the label differs.
  director: { label: "Director", pages: ALL_PAGES, readOnly: false },
  admin: { label: "Admin", pages: ALL_PAGES, readOnly: false },
  support: { label: "Support agent", pages: ["tickets", "feedback", "products", "findings"], readOnly: false },
  quality: { label: "Quality auditor", pages: ["audit", "refills", "findings"], readOnly: false },
  operations: { label: "Operations", pages: ["audit", "refills", "live_stock", "closing_stock", "product_list", "supply", "findings"], readOnly: false },
  staff: { label: "Staff", pages: ["findings"], readOnly: false },
  viewer: { label: "Viewer (read only)", pages: ALL_PAGES.filter((page) => !["settings", "activity"].includes(page)), readOnly: true },
};

// What people had before roles existed, so nobody loses access on the first deploy.
function legacyRole(user) {
  if (user?.department === "Operations") return "operations";
  if (user?.department === "Audit") return "quality";
  return "staff";
}

export function accessFor(user) {
  const accessRole = ROLE_PRESETS[user?.accessRole] ? user.accessRole : legacyRole(user);
  const preset = ROLE_PRESETS[accessRole];
  const fullAccess = accessRole === "admin" || accessRole === "director";
  const pages = fullAccess
    ? ALL_PAGES
    : (Array.isArray(user?.pages) ? user.pages : preset.pages).filter((page) => PAGES[page]);
  return { accessRole, roleLabel: preset.label, pages, readOnly: accessRole === "viewer", isAdmin: fullAccess };
}

export function hasPage(user, page) {
  return Boolean(user?.isAdmin || user?.pages?.includes(page));
}

/* ---------- Passwords ---------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isHashed(stored) {
  return String(stored || "").startsWith("scrypt$");
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!isHashed(stored)) return String(password) === String(stored); // not migrated yet
  const [, salt, hash] = String(stored).split("$");
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

export function generatePassword() {
  return `Snackit@${crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase()}`;
}

export function newSessionToken() {
  return `s-${crypto.randomBytes(24).toString("hex")}`;
}

// Scrambles any plain-text passwords left from before; returns true if something changed.
export function migrateUserPasswords(users) {
  let changed = false;
  for (const user of users || []) {
    if (user.password && !isHashed(user.password)) {
      user.password = hashPassword(user.password);
      changed = true;
    }
  }
  return changed;
}

// A person as other people and the dashboard see them: never the password.
export function publicUser(user, { withAccess = false } = {}) {
  const { password, ...rest } = user;
  if (!withAccess) {
    const { pages, accessRole, lastLoginAt, ...basic } = rest;
    return basic;
  }
  return { ...rest, ...accessFor(user) };
}

/* ---------- Which page each API path belongs to ---------- */

const PATH_RULES = [
  [/^\/(tickets|ticket)(\/|$)/, ["tickets"]],
  [/^\/admin\/(send|takeover|release|messages|tickets|quick-replies)(\/|$)/, ["tickets"]],
  // The tickets page reads the bot settings; only "Bot settings" may change them.
  [/^\/admin\/(settings|paytm-setting)$/, (method) => (method === "GET" ? ["tickets", "settings"] : ["settings"])],
  [/^\/feedback(\/|$)/, ["feedback"]],
  [/^\/product-leads(\/|$)/, ["products"]],
  [/^\/(audit|audits)(\/|$)/, ["audit"]],
  [/^\/findings(\/|$)/, ["findings"]],
  [/^\/expiry(\/|$)/, ["expiry"]],
  [/^\/refills(\/|$)/, ["refills"]],
  // Stock: Live Stock (machines, DCs, uploads), Closing Stock (counting at a location: it also
  // reads the locations and their expected stock), Product List (products and prices).
  [/^\/stock(\/|$)/, ["live_stock"]],
  [/^\/locstock\/(closings|catalog)(\/|$)/, ["closing_stock", "live_stock"]],
  [/^\/locstock\/(overview|locations\/\d+)$/, (method) => (method === "GET" ? ["live_stock", "closing_stock"] : ["live_stock"])],
  [/^\/locstock\/warehouse$/, ["live_stock", "closing_stock"]],
  [/^\/locstock\/(products|items)(\/|$)/, ["product_list"]],
  [/^\/locstock(\/|$)/, ["live_stock"]],
  [/^\/supply(\/|$)/, ["supply"]],
  [/^\/analytics\//, ["analytics", "operations", "tickets"]],
  [/^\/(operations|machines|inventory|host-sites|brands|skus|leads)(\/|$)/, ["operations"]],
  [/^\/activity(\/|$)/, ["activity"]],
];

// Returns true if the person may call this API path.
export function canUsePath(user, method, path) {
  if (user?.isAdmin) return true;
  if (path.startsWith("/internal/") || path === "/me" || path.startsWith("/me/")) return true;
  for (const [pattern, pages] of PATH_RULES) {
    if (pattern.test(path)) {
      const needed = typeof pages === "function" ? pages(method) : pages;
      return needed.some((page) => user?.pages?.includes(page));
    }
  }
  return false; // anything else is admin-only
}
