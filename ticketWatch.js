/* =========================================================
    TICKET WATCH
    1. Reply timers: a ticket waiting for the team (the customer finished the
       bot's steps, or wrote during a takeover and nobody answered yet) shows
       how long it has waited. Past the "overdue" hours set in Admin Settings,
       the team gets a phone notification and the alert numbers a WhatsApp.
    2. Refund checks: flags tickets that may be a double or false claim
       (same transaction ID, same screenshot or same payment read from it,
       same UPI ID on another number, too many complaints from one number).
    3. Customer history for the takeover chat: past tickets, refunds and
       ratings of the same phone number.
========================================================= */
import crypto from "crypto";

const DEFAULTS = {
  sla_warn_hours: 2,
  sla_overdue_hours: 6,
  sla_alert_phones: "",
  sla_alert_push: true,
  fraud_claims_limit: 3,
  fraud_claims_days: 30,
};
const CLOSED_STATUSES = ["closed", "auto_closed", "resolved", "refunded", "auto_refunded"];
const REFUNDED = ["refunded", "auto_refunded"];
const FINGERPRINT_VERSION = "sha256:";

let db = null;
let sendText = null;
let pushToTicketTeam = null;
let alerting = false;

export async function ensureTicketWatch(database, { sendWhatsApp, pushToTeam } = {}) {
  db = database;
  sendText = sendWhatsApp || null;
  pushToTicketTeam = pushToTeam || null;
  await db.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS upi_image_hash TEXT,
      ADD COLUMN IF NOT EXISTS sla_alerted_for TIMESTAMPTZ
  `);
  await db.query("CREATE INDEX IF NOT EXISTS messages_ticket_sender_idx ON messages (ticket_id, sender)");
}

/* ---------- Settings ---------- */

export async function getWatchSettings() {
  const settings = { ...DEFAULTS };
  try {
    const { rows } = await db.query("SELECT key, value FROM app_settings WHERE key = ANY($1)", [Object.keys(DEFAULTS)]);
    for (const { key, value } of rows) {
      if (key === "sla_alert_phones") settings[key] = value;
      else if (key === "sla_alert_push") settings[key] = value === "true";
      else if (Number.isFinite(Number(value))) settings[key] = Number(value);
    }
  } catch {
    // settings table not ready yet: defaults apply
  }
  return settings;
}

const phoneKey = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const lower = (value) => String(value || "").toLowerCase();
const isClosed = (ticket) => String(ticket.state || "").toUpperCase() === "CLOSED" || CLOSED_STATUSES.includes(lower(ticket.status));

/* ---------- Reply timers ---------- */

// When the team's turn began, or null when the ticket isn't waiting for the team.
// A customer still going through the bot's steps is not waiting for anyone.
export function waitingSince(ticket, lastTeamReplyAt) {
  if (isClosed(ticket)) return null;
  const needsTeam = String(ticket.state || "").toUpperCase() === "DONE" || ticket.takeover === true || lower(ticket.status) === "processing";
  if (!needsTeam) return null;
  const customerAt = new Date(ticket.last_customer_message_at || ticket.created_at);
  if (lastTeamReplyAt && new Date(lastTeamReplyAt) >= customerAt) return null;
  return customerAt;
}

async function teamReplies(ticketIds) {
  if (!ticketIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT ticket_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at
     FROM messages WHERE sender = 'admin' AND ticket_id = ANY($1) GROUP BY ticket_id`,
    [ticketIds]
  );
  return new Map(rows.map((row) => [row.ticket_id, row]));
}

/* ---------- Screenshot fingerprint ---------- */

// The exact file: a forwarded or re-sent screenshot is byte-for-byte the same. (Look-alike
// matching isn't used: receipts from one app differ only in small text, so two different
// payments look as alike as one picture saved twice.)
export async function imageFingerprint(buffer) {
  return FINGERPRINT_VERSION + crypto.createHash("sha256").update(buffer).digest("hex");
}

// The same payment read from two screenshots: same amount, same date and time to the
// minute, and the same customer UPI ID when both show one.
function samePaymentRead(a = {}, b = {}) {
  if (a.amount == null || b.amount == null || Number(a.amount) !== Number(b.amount)) return false;
  const time = (scan) => String(scan.paid_at || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!time(a).includes(":") || time(a) !== time(b)) return false;
  if (a.utr && b.utr && a.utr !== b.utr) return false;
  return !(a.payer_upi && b.payer_upi && a.payer_upi !== b.payer_upi);
}

/* ---------- Refund checks ---------- */

function describe(ticket) {
  if (REFUNDED.includes(lower(ticket.status))) return `#${ticket.id} (already refunded)`;
  if (isClosed(ticket)) return `#${ticket.id} (closed)`;
  return `#${ticket.id} (open)`;
}

// Checks for every ticket in the list, compared with each other. Returns id → [{ level, text, ids }].
function refundChecks(tickets, settings) {
  const checks = new Map(tickets.map((ticket) => [ticket.id, []]));
  const add = (ticket, level, text, others) => checks.get(ticket.id).push({ level, text, ids: others.map((other) => other.id) });
  const refundedAmong = (others) => others.some((other) => REFUNDED.includes(lower(other.status)));

  const groupBy = (keyOf) => {
    const groups = new Map();
    for (const ticket of tickets) {
      const key = keyOf(ticket);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ticket);
    }
    return groups;
  };

  // 1. The same UPI transaction ID on more than one ticket.
  const sameUtr = new Set();
  for (const group of groupBy((ticket) => ticket.upi_utr).values()) {
    if (group.length < 2) continue;
    for (const ticket of group) {
      const others = group.filter((other) => other.id !== ticket.id);
      others.forEach((other) => sameUtr.add(`${ticket.id}-${other.id}`));
      add(ticket, refundedAmong(others) ? "high" : "warn", `Same transaction ID as ${others.map(describe).join(", ")}`, others);
    }
  }

  // 2. The same screenshot sent again, or the same payment read from another screenshot
  //    (these catch repeats even when the transaction ID couldn't be read).
  for (const group of groupBy((ticket) => ticket.upi_image_hash).values()) {
    for (const ticket of group) {
      const others = group.filter((other) => other.id !== ticket.id && !sameUtr.has(`${ticket.id}-${other.id}`));
      others.forEach((other) => sameUtr.add(`${ticket.id}-${other.id}`));
      if (others.length) add(ticket, refundedAmong(others) ? "high" : "warn", `Same payment screenshot as ${others.map(describe).join(", ")}`, others);
    }
  }
  const read = tickets.filter((ticket) => ticket.upi_scan?.amount != null && ticket.upi_scan?.paid_at);
  for (const ticket of read) {
    const others = read.filter((other) => other.id !== ticket.id && !sameUtr.has(`${ticket.id}-${other.id}`) && samePaymentRead(ticket.upi_scan, other.upi_scan));
    if (others.length) add(ticket, refundedAmong(others) ? "high" : "warn", `Same payment (₹${ticket.upi_scan.amount}, ${ticket.upi_scan.paid_at}) as ${others.map(describe).join(", ")}`, others);
  }

  // 3. One customer UPI ID used from different phone numbers.
  for (const group of groupBy((ticket) => (ticket.screenshot_upi_id && !ticket.screenshot_upi_id.startsWith("••••") ? lower(ticket.screenshot_upi_id) : null)).values()) {
    for (const ticket of group) {
      const others = group.filter((other) => phoneKey(other.phone) !== phoneKey(ticket.phone));
      if (others.length) add(ticket, "warn", `UPI ID ${ticket.screenshot_upi_id} also used by another number on ${others.map((other) => `#${other.id}`).join(", ")}`, others);
    }
  }

  // 4. Too many complaints from one number within the set days.
  const limit = Number(settings.fraud_claims_limit) || 0;
  const windowMs = (Number(settings.fraud_claims_days) || 30) * 86400000;
  if (limit > 0) {
    const claims = tickets.filter((ticket) => ticket.sub_issue && lower(ticket.status) !== "auto_closed");
    for (const group of groupBy((ticket) => phoneKey(ticket.phone)).values()) {
      const own = group.filter((ticket) => claims.includes(ticket));
      for (const ticket of own) {
        const at = new Date(ticket.created_at).getTime();
        const earlier = own.filter((other) => other.id !== ticket.id && new Date(other.created_at).getTime() <= at && at - new Date(other.created_at).getTime() <= windowMs);
        if (earlier.length + 1 > limit) {
          const refunds = earlier.filter((other) => REFUNDED.includes(lower(other.status))).length;
          add(ticket, "warn", `Complaint number ${earlier.length + 1} from this number in ${settings.fraud_claims_days} days${refunds ? ` (${refunds} already refunded)` : ""}`, earlier);
        }
      }
    }
  }
  return checks;
}

// Adds reply-timer and refund-check fields to the tickets list.
export async function addTicketWatch(rows) {
  if (!db || !rows.length) return rows;
  try {
    const [settings, replies, hashes] = await Promise.all([
      getWatchSettings(),
      teamReplies(rows.map((row) => row.id)),
      db.query("SELECT id, upi_image_hash, last_customer_message_at FROM tickets WHERE id = ANY($1)", [rows.map((row) => row.id)]),
    ]);
    const extra = new Map(hashes.rows.map((row) => [row.id, row]));
    const full = rows.map((row) => ({ ...row, ...extra.get(row.id) }));
    const checks = refundChecks(full, settings);
    return full.map(({ upi_image_hash: _hash, ...row }) => {
      const reply = replies.get(row.id);
      return {
        ...row,
        first_response_at: reply?.first_at || null,
        waiting_since: waitingSince(row, reply?.last_at),
        refund_checks: checks.get(row.id) || [],
      };
    });
  } catch (err) {
    console.log("TICKET WATCH ERROR:", err.message);
    return rows;
  }
}

/* ---------- Overdue alerts ---------- */

function hoursLabel(ms) {
  const hours = ms / 3600000;
  return hours < 24 ? `${Math.floor(hours)}h ${Math.floor((ms % 3600000) / 60000)}m` : `${(hours / 24).toFixed(1)} days`;
}

// Runs every few minutes. Each wait is alerted once; if the customer writes again
// after the team replied, the new wait can be alerted again.
export async function alertOverdueTickets() {
  if (!db || alerting) return;
  alerting = true;
  try {
    const settings = await getWatchSettings();
    const overdueMs = Number(settings.sla_overdue_hours) * 3600000;
    if (!(overdueMs > 0)) return;
    const { rows } = await db.query(
      `SELECT id, phone, sub_issue, location, status, state, takeover, created_at, last_customer_message_at, sla_alerted_for
       FROM tickets
       WHERE category = 'REFUND' AND COALESCE(state, '') <> 'CLOSED'
         AND LOWER(COALESCE(status, '')) <> ALL($1)
         AND (state = 'DONE' OR COALESCE(takeover, FALSE) OR LOWER(COALESCE(status, '')) = 'processing')`,
      [CLOSED_STATUSES]
    );
    const replies = await teamReplies(rows.map((row) => row.id));
    const now = Date.now();
    const due = rows
      .map((row) => ({ ...row, since: waitingSince(row, replies.get(row.id)?.last_at) }))
      .filter((row) => row.since && now - row.since.getTime() >= overdueMs)
      .filter((row) => !row.sla_alerted_for || new Date(row.sla_alerted_for).getTime() !== row.since.getTime())
      .sort((a, b) => a.since - b.since);
    if (!due.length) return;

    const lines = due.slice(0, 10).map((row) => `• #${row.id} waiting ${hoursLabel(now - row.since.getTime())}${row.sub_issue ? ` · ${row.sub_issue}` : ""}${row.location ? ` · ${row.location}` : ""}`);
    if (due.length > 10) lines.push(`…and ${due.length - 10} more`);
    const heading = due.length === 1 ? "⏰ *1 ticket is overdue*" : `⏰ *${due.length} tickets are overdue*`;
    const body = `${heading}\n\nWaiting more than ${settings.sla_overdue_hours}h for a reply:\n${lines.join("\n")}\n\nPlease reply from the Snackit dashboard.`;

    if (settings.sla_alert_push && pushToTicketTeam) {
      pushToTicketTeam({
        title: due.length === 1 ? `Ticket #${due[0].id} is overdue` : `${due.length} tickets are overdue`,
        body: lines.slice(0, 4).join("\n").replace(/•\s/g, ""),
        view: "tickets",
        ticketId: due.length === 1 ? String(due[0].id) : undefined,
      });
    }
    const phones = String(settings.sla_alert_phones || "").split(/[,\s]+/).map((phone) => phone.replace(/\D/g, "")).filter((phone) => phone.length >= 10);
    for (const phone of phones) {
      await Promise.resolve(sendText?.(phone.length === 10 ? `91${phone}` : phone, body)).catch((err) => console.log("OVERDUE WHATSAPP ERROR:", err.message));
    }
    for (const row of due) {
      await db.query("UPDATE tickets SET sla_alerted_for = $1 WHERE id = $2", [row.since, row.id]);
    }
    console.log(`⏰ Overdue alert: ${due.length} ticket(s) → ${phones.length} WhatsApp number(s)${settings.sla_alert_push ? " + phone notifications" : ""}`);
  } catch (err) {
    console.log("OVERDUE ALERT ERROR:", err.message);
  } finally {
    alerting = false;
  }
}

// Screenshots that arrived before fingerprints existed get one now (in the background).
export async function fingerprintMissedScreenshots(fetchImage, limit = 300) {
  if (!db) return;
  try {
    const { rows } = await db.query(
      `SELECT id, upi_image FROM tickets
       WHERE upi_image IS NOT NULL AND images_deleted_at IS NULL
         AND (upi_image_hash IS NULL OR upi_image_hash NOT LIKE '${FINGERPRINT_VERSION}%')
       ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    let done = 0;
    for (const row of rows) {
      try {
        const hash = await imageFingerprint(await fetchImage(row.upi_image));
        await db.query("UPDATE tickets SET upi_image_hash = $1 WHERE id = $2", [hash, row.id]);
        done += 1;
      } catch {
        // image gone or unreadable: skip it
      }
    }
    if (done) console.log(`🖼️ Fingerprinted ${done} payment screenshot(s)`);
  } catch (err) {
    console.log("SCREENSHOT FINGERPRINT ERROR:", err.message);
  }
}

/* ---------- Routes ---------- */

export function registerTicketWatchRoutes(app, { auth }) {
  const adminOnly = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: "Admin access required" }));

  // The timer colours for the tickets page.
  app.get("/tickets/watch-settings", auth, async (req, res) => {
    const settings = await getWatchSettings();
    res.json({ sla_warn_hours: settings.sla_warn_hours, sla_overdue_hours: settings.sla_overdue_hours });
  });

  // Everything we know about the customer behind a ticket.
  app.get("/tickets/:id/customer", auth, async (req, res) => {
    try {
      const current = await db.query("SELECT id, phone FROM tickets WHERE id = $1", [req.params.id]);
      if (!current.rows.length) return res.status(404).json({ error: "Ticket not found" });
      const key = phoneKey(current.rows[0].phone);
      const [tickets, feedback] = await Promise.all([
        db.query(
          `SELECT id, phone, category, main_issue, sub_issue, location, LOWER(COALESCE(status, '')) AS status, state, takeover,
                  refund_amount, upi_utr, screenshot_upi_id, upi_scan, created_at, resolved_at, last_customer_message_at
           FROM tickets WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 ORDER BY created_at DESC LIMIT 200`,
          [key]
        ),
        db.query(
          `SELECT rating, comment, created_at FROM feedback
           WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 AND rating IS NOT NULL ORDER BY created_at DESC LIMIT 50`,
          [key]
        ).catch(() => ({ rows: [] })),
      ]);
      const rows = tickets.rows;
      const refunded = rows.filter((row) => row.status === "refunded");
      const amount = (row) => (Number.isFinite(Number(row.refund_amount)) ? Number(row.refund_amount) : 0);
      const locations = new Map();
      for (const row of rows) {
        const name = String(row.location || "").trim();
        if (!name) continue;
        const seen = locations.get(name.toLowerCase()) || { name, count: 0 };
        seen.count += 1;
        locations.set(name.toLowerCase(), seen);
      }
      const monthAgo = Date.now() - 30 * 86400000;
      // A complaint is a request the customer finished; chats they abandoned half-way don't count.
      const complaints = rows.filter((row) => row.sub_issue && row.status !== "auto_closed");
      const ratings = feedback.rows.map((row) => Number(row.rating)).filter((rating) => rating >= 1 && rating <= 5);

      // The checks are made against every ticket, so a claim on another number is still found.
      const all = await db.query(
        `SELECT id, phone, sub_issue, LOWER(COALESCE(status, '')) AS status, state, upi_utr, screenshot_upi_id, upi_scan, upi_image_hash, created_at
         FROM tickets WHERE category = 'REFUND'`
      );
      const checks = refundChecks(all.rows, await getWatchSettings()).get(Number(req.params.id)) || [];

      res.json({
        phone: current.rows[0].phone,
        first_seen: rows.length ? rows[rows.length - 1].created_at : null,
        totals: {
          tickets: rows.length,
          complaints: complaints.length,
          complaints_30_days: complaints.filter((row) => new Date(row.created_at).getTime() >= monthAgo).length,
          refunds: refunded.length,
          refunded_amount: refunded.reduce((sum, row) => sum + amount(row), 0),
          auto_refunds: rows.filter((row) => row.status === "auto_refunded").length,
        },
        rating: { average: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null, count: ratings.length, last: feedback.rows[0] || null },
        top_location: [...locations.values()].sort((a, b) => b.count - a.count)[0] || null,
        checks,
        tickets: rows.map(({ upi_scan: scan, ...row }) => ({ ...row, paid_amount: scan?.amount ?? null, current: row.id === Number(req.params.id) })),
      });
    } catch (err) {
      console.log("CUSTOMER HISTORY ERROR:", err.message);
      res.status(500).json({ error: "Could not load the customer's history" });
    }
  });

  app.get("/admin/ticket-alerts", auth, adminOnly, async (req, res) => {
    res.json(await getWatchSettings());
  });

  app.put("/admin/ticket-alerts", auth, adminOnly, async (req, res) => {
    try {
      const body = req.body || {};
      const values = {};
      const number = (key, min, max, label) => {
        if (body[key] === undefined) return null;
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < min || value > max) return `${label} must be between ${min} and ${max}`;
        values[key] = String(Math.round(value * 10) / 10);
        return null;
      };
      const error = number("sla_warn_hours", 0.25, 168, "Warning time")
        || number("sla_overdue_hours", 0, 168, "Overdue time")
        || number("fraud_claims_limit", 0, 50, "Complaint limit")
        || number("fraud_claims_days", 1, 365, "Complaint period");
      if (error) return res.status(400).json({ error });
      if (body.sla_alert_phones !== undefined) {
        const phones = String(body.sla_alert_phones || "").split(/[,\s]+/).map((phone) => phone.replace(/\D/g, "")).filter(Boolean);
        if (phones.some((phone) => phone.length < 10 || phone.length > 13)) return res.status(400).json({ error: "Enter WhatsApp numbers with 10 digits (or 91 + 10 digits), separated by commas" });
        values.sla_alert_phones = phones.join(", ");
      }
      if (body.sla_alert_push !== undefined) values.sla_alert_push = String(Boolean(body.sla_alert_push));
      for (const [key, value] of Object.entries(values)) {
        await db.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, value]
        );
      }
      const settings = await getWatchSettings();
      res.locals.activity = { section: "Settings", action: `Changed ticket alerts (overdue after ${settings.sla_overdue_hours || "never"}h, complaint limit ${settings.fraud_claims_limit} in ${settings.fraud_claims_days} days)` };
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: "Could not save ticket alert settings" });
    }
  });
}
