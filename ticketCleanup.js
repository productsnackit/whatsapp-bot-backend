/* =========================================================
    DELETE A NUMBER'S TICKETS (admins only)
    For test numbers: removes every ticket of one phone number for good,
    with its chat messages, ratings and photos (Cloudinary). The dashboard
    first shows exactly what will be deleted; the delete only goes ahead if
    the same tickets are still there.
========================================================= */
import { destroyFiles } from "./imageRetention.js";

const last10 = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);
const SAME_NUMBER = "RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1";

export function registerTicketCleanupRoutes(app, { auth, db, onChanged }) {
  const adminOnly = (req, res, next) => (req.user?.isAdmin ? next() : res.status(403).json({ error: "Admin access required" }));

  async function find(key) {
    const { rows: tickets } = await db.query(
      `SELECT id, created_at, status, state, sub_issue, location, image, upi_image, payments FROM tickets WHERE ${SAME_NUMBER} ORDER BY id DESC`,
      [key]
    );
    const ids = tickets.map((ticket) => ticket.id);
    const [messages, feedback] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS n, ARRAY_REMOVE(ARRAY_AGG(media_url), NULL) AS media FROM messages WHERE ticket_id = ANY($1)", [ids]),
      db.query(`SELECT COUNT(*)::int AS n FROM feedback WHERE ticket_id = ANY($2) OR ${SAME_NUMBER}`, [key, ids]).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    const photos = [...new Set([...tickets.flatMap((ticket) => [ticket.image, ticket.upi_image, ...(ticket.payments || []).map((payment) => payment.image)]), ...(messages.rows[0].media || [])])].filter((url) => /^https?:\/\//.test(url || ""));
    return { tickets, ids, messages: messages.rows[0].n, feedback: feedback.rows[0].n, photos };
  }

  // What would be deleted for this number.
  app.get("/admin/number-tickets", auth, adminOnly, async (req, res) => {
    try {
      const key = last10(req.query.phone);
      if (key.length !== 10) return res.status(400).json({ error: "Enter a 10-digit phone number" });
      const found = await find(key);
      res.json({
        phone: key,
        tickets: found.tickets.map(({ image, upi_image: upiImage, payments, ...ticket }) => ticket),
        messages: found.messages,
        feedback: found.feedback,
        photos: found.photos.length,
      });
    } catch (err) {
      console.log("NUMBER TICKETS ERROR:", err.message);
      res.status(500).json({ error: "Could not look up the tickets" });
    }
  });

  app.post("/admin/number-tickets/delete", auth, adminOnly, async (req, res) => {
    try {
      const key = last10(req.body?.phone);
      if (key.length !== 10) return res.status(400).json({ error: "Enter a 10-digit phone number" });
      const found = await find(key);
      // Only what the person saw: new tickets that arrived since then are not deleted.
      const shown = new Set((req.body?.ticket_ids || []).map(Number));
      if (!found.ids.length) return res.json({ deleted: 0, messages: 0, feedback: 0, photos: 0 });
      if (found.ids.some((id) => !shown.has(id)) || shown.size !== found.ids.length) {
        return res.status(409).json({ error: "This number's tickets changed since you looked. Search again, then delete." });
      }
      // One statement, so tickets, their messages and ratings go together (or not at all).
      const { rows } = await db.query(
        `WITH f AS (DELETE FROM feedback WHERE ticket_id = ANY($2) OR ${SAME_NUMBER} RETURNING 1),
              m AS (DELETE FROM messages WHERE ticket_id = ANY($2) RETURNING 1),
              t AS (DELETE FROM tickets WHERE id = ANY($2) RETURNING 1)
         SELECT (SELECT COUNT(*) FROM t)::int AS tickets, (SELECT COUNT(*) FROM m)::int AS messages, (SELECT COUNT(*) FROM f)::int AS feedback`,
        [key, found.ids]
      );
      await db.query(`DELETE FROM customer_risk WHERE ${SAME_NUMBER}`, [key]).catch(() => {});
      // The bot's memory of this number's conversation, so it starts fresh.
      for (const store of [global.feedbackTargetTicket, global.upiActive, global.adminTakeover, global.feedbackActive]) {
        for (const phone of Object.keys(store || {})) if (last10(phone) === key) delete store[phone];
      }
      // Photos last: a Cloudinary hiccup never stops the delete.
      let photos = 0;
      if (found.photos.length) photos = await destroyFiles(found.photos).catch((err) => { console.log("NUMBER TICKETS PHOTO DELETE:", err.message); return 0; });
      const result = { deleted: rows[0].tickets, messages: rows[0].messages, feedback: rows[0].feedback, photos };
      console.log(`🗑 Deleted ${result.deleted} ticket(s) of ${key}: ${result.messages} messages, ${result.feedback} ratings, ${photos} photos`);
      res.locals.activity = { section: "Tickets", action: `Deleted all ${result.deleted} tickets of ${key} (tickets ${found.ids.map((id) => `#${id}`).join(", ")})` };
      onChanged?.();
      res.json(result);
    } catch (err) {
      console.log("NUMBER TICKETS DELETE ERROR:", err.message);
      res.status(500).json({ error: "Could not delete the tickets" });
    }
  });
}
