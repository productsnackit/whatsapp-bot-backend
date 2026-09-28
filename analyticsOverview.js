/* =========================================================
    ANALYTICS OVERVIEW
    One request feeds the whole Analytics page: every ticket and rating in
    the chosen period (IST calendar days) plus the equally long period just
    before it, so the page can compare the two. Rows are kept small; all
    grouping happens in the browser so filters respond instantly.
========================================================= */

const IST_MINUTES = 330;
const MAX_ROWS = 50000;

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

function istDate(date = new Date()) {
  return new Date(date.getTime() + IST_MINUTES * 60000).toISOString().slice(0, 10);
}
function istMidnightUtc(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_MINUTES * 60000);
}
function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// Amounts may be stored as text; anything that isn't a plain number counts as no amount.
const TICKET_COLUMNS = `
  id, created_at, category, main_issue, sub_issue, LOWER(COALESCE(status, '')) AS status, state, location, site_name, site_match,
  CASE WHEN refund_amount::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN refund_amount::text::numeric END AS refund_amount,
  resolved_at, COALESCE(takeover, FALSE) AS takeover`;

async function ticketsBetween(db, from, to) {
  const { rows } = await db.query(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT ${MAX_ROWS}`,
    [istMidnightUtc(from), istMidnightUtc(addDays(to, 1))]
  );
  return rows;
}

async function feedbackBetween(db, from, to) {
  const { rows } = await db.query(
    `SELECT rating::numeric AS rating, created_at, ticket_id FROM feedback
     WHERE rating IS NOT NULL AND created_at >= $1 AND created_at < $2 ORDER BY created_at LIMIT ${MAX_ROWS}`,
    [istMidnightUtc(from), istMidnightUtc(addDays(to, 1))]
  ).catch(() => ({ rows: [] }));
  return rows;
}

export function registerAnalyticsOverview(app, { db, auth }) {
  app.get("/analytics/overview", auth, async (req, res) => {
    try {
      const today = istDate();
      let to = validDate(req.query.to) ? req.query.to : today;
      let from = validDate(req.query.from) ? req.query.from : null;
      if (!from) {
        // All time: from the first ticket.
        const first = await db.query("SELECT MIN(created_at) AS first FROM tickets");
        from = first.rows[0].first ? istDate(new Date(first.rows[0].first)) : today;
      }
      if (from > to) [from, to] = [to, from];
      const days = daysBetween(from, to) + 1;
      const compare = req.query.all !== "1";
      const previous = compare ? { from: addDays(from, -days), to: addDays(from, -1) } : null;

      const [tickets, feedback, previousTickets, previousFeedback] = await Promise.all([
        ticketsBetween(db, from, to),
        feedbackBetween(db, from, to),
        previous ? ticketsBetween(db, previous.from, previous.to) : [],
        previous ? feedbackBetween(db, previous.from, previous.to) : [],
      ]);

      res.json({
        generatedAt: new Date().toISOString(),
        today,
        range: { from, to, days },
        previous,
        tickets,
        feedback,
        previousTickets,
        previousFeedback,
      });
    } catch (err) {
      console.log("ANALYTICS OVERVIEW ERROR:", err.message);
      res.status(500).json({ error: "Could not load analytics" });
    }
  });
}
