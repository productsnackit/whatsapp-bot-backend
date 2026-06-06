import "dotenv/config";
import "./worker.js";

/* ================= IMPORTS ================= */
import express from "express";
import cors from "cors";
import path from "path";
import axios from "axios";

import redis from "./redis.js";
import ticketQueue from "./queue.js";
import { getOrCreateTicket } from "./ticketService.js";
import db from "./db.js";
import { sendWhatsApp } from "./whatsapp.js";

/* ================= INIT ================= */
const app = express();
app.use(cors());
app.use(express.json());

/* ================= FIX: SERVE UPLOADS ================= */
app.use("/uploads", express.static("uploads"));

/* ================= GLOBAL STATE ================= */
if (!global.feedbackActive) global.feedbackActive = {};
if (!global.upiActive) global.upiActive = {};

/* ================= AUTH CONFIG ================= */
const SECRET_TOKEN = "mysecrettoken123";
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin";

/* =========================================================
   🔐 AUTH MIDDLEWARE
========================================================= */
function auth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) return res.status(401).json({ error: "Unauthorized" });
    if (!header.startsWith("Bearer "))
      return res.status(401).json({ error: "Unauthorized" });

    const token = header.split(" ")[1];

    if (!token || token === "undefined") {
      return res.status(401).json({ error: "Session expired" });
    }

    if (token !== SECRET_TOKEN) {
      return res.status(401).json({ error: "Invalid token" });
    }

    next();
  } catch (err) {
    console.log("AUTH ERROR:", err.message);
    res.status(500).json({ error: "Auth failure" });
  }
}

/* =========================================================
   🔑 LOGIN
========================================================= */
app.post("/login", (req, res) => {
  try {
    const { username, password } = req.body;

    if (username === ADMIN_USER && password === ADMIN_PASS) {
      return res.json({ token: SECRET_TOKEN });
    }

    res.status(401).json({ error: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   📄 GET REFUND TICKETS ONLY
========================================================= */
app.get("/tickets", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id, phone,
        category,
        main_issue,
        sub_issue,
        issue,
        location,
        upi_id,
        image,
        upi_image,
        status,
        state,
        created_at,
        updated_at
      FROM tickets
      WHERE category = 'REFUND'
      ORDER BY id DESC
    `);

    const rows = result.rows.map((t) => ({
      ...t,
      image: t.image
        ? t.image.startsWith("http")
          ? t.image
          : `https://whatsapp-bot-1x9v.onrender.com/${t.image}`
        : null,

      upi_image: t.upi_image
        ? t.upi_image.startsWith("http")
          ? t.upi_image
          : `https://whatsapp-bot-1x9v.onrender.com/${t.upi_image}`
        : null,
    }));

    res.json(rows);
  } catch (err) {
    console.log("FETCH ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   📝 GET FEEDBACK
========================================================= */
app.get("/feedback", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, phone, rating, comment, created_at
      FROM feedback
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.log("FEEDBACK ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   📦 GET PRODUCT LEADS
========================================================= */
app.get("/product-leads", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, phone, type, created_at
      FROM product_leads
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.log("PRODUCT LEADS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ⚙️ TICKET ACTION
========================================================= */
app.post("/ticket/action", auth, async (req, res) => {
  try {
    const { ticketId, action } = req.body;

    if (!ticketId || !action) {
      return res.status(400).json({ error: "Missing data" });
    }

    const result = await db.query(
      "SELECT * FROM tickets WHERE id=$1",
      [ticketId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const ticket = result.rows[0];

    let message, status;

    switch (action) {
      case "REFUNDED":
        message = "Refund processed Now. Please check your bank in 5–10 minutes.";
        status = "refunded";
        break;

      case "AUTO_REFUNDED":
        message = "Amount was already credited. Please check your bank statement.";
        status = "auto_refunded";
        break;

      case "RESOLVED":
        message = "Your Issue was resolved. Thank you for contacting Snackit!";
        status = "resolved";
        break;

      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    if (ticket.phone) {
      await sendWhatsApp(ticket.phone, message);
    }

    await db.query(
      `
      UPDATE tickets 
      SET status=$1, state='CLOSED', updated_at=NOW()
      WHERE id=$2
      `,
      [status, ticketId]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("ACTION ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   🗑️ CLOSE TICKET
========================================================= */
app.delete("/tickets/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;

    await db.query(
      `
      UPDATE tickets 
      SET state='CLOSED', status='closed', updated_at=NOW()
      WHERE id=$1
      `,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("DELETE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   📊 ANALYTICS (ONLY ADDED - NOTHING MODIFIED)
========================================================= */

/* Daily Product Not Dispensed */
app.get("/analytics/product-not-dispensed", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM tickets
      WHERE main_issue = 'Product Not Dispensed'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* Issues by Category */
app.get("/analytics/category", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT category, COUNT(*) as count
      FROM tickets
      GROUP BY category
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* Monthly Tickets */
app.get("/analytics/monthly", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count
      FROM tickets
      GROUP BY month
      ORDER BY month
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   🔗 WEBHOOK VERIFY
========================================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verification failed");
  res.sendStatus(403);
});

/* =========================================================
   📩 WEBHOOK RECEIVE
========================================================= */
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;

    let text = "";
    let isImage = false;
    let mediaUrl = null;
    let mediaType = null;

    if (type === "text") {
      text = msg.text?.body || "";
    }

    if (type === "image" || type === "video") {
      isImage = true;
      mediaType = type;

      const mediaId = type === "image" ? msg.image?.id : msg.video?.id;

      if (mediaId) {
        try {
          const mediaRes = await axios.get(
            `https://graph.facebook.com/v19.0/${mediaId}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              },
            }
          );

          mediaUrl = mediaRes.data?.url || null;
        } catch (err) {
          console.log("MEDIA URL ERROR:", err.response?.data || err.message);
        }
      }
    }

    console.log("📩 Incoming:", { from, text, type, isImage, mediaUrl });

    const ticket = await getOrCreateTicket(from);

    await ticketQueue.add("process", {
      ticketId: ticket ? ticket.id : null,
      from,
      text,
      isImage,
      mediaUrl,
      mediaType,
      timestamp: Number(msg.timestamp || Date.now()),
    });

    res.sendStatus(200);
  } catch (err) {
    console.log("❌ WEBHOOK ERROR:", err.message);
    res.sendStatus(200);
  }
});

/* =========================================================
   ❤️ HEALTH CHECK
========================================================= */
app.get("/", (req, res) => {
  res.send("Snackit backend running");
});

/* =========================================================
   🚀 START SERVER
========================================================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});