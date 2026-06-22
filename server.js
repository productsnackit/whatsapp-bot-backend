import "dotenv/config";

/* ================= IMPORTS ================= */
import express from "express";
import cors from "cors";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";

import { getOrCreateTicket } from "./ticketService.js";
import db from "./db.js";
import { sendWhatsApp } from "./whatsapp.js";

/* ================= CLOUDINARY ================= */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

/* ================= HELPERS ================= */
function cleanText(text) {
  return (text || "").trim().toLowerCase();
}

function extractMedia(jobData) {
  const mediaUrl =
    jobData?.mediaUrl ||
    jobData?.url ||
    jobData?.image ||
    jobData?.file ||
    null;

  return {
    isImage: Boolean(
      jobData?.isImage ||
        jobData?.type === "image" ||
        jobData?.mediaType === "image" ||
        jobData?.mediaType?.startsWith?.("image") ||
        mediaUrl
    ),
    mediaUrl,
    mediaType: jobData?.mediaType || null,
  };
}

async function uploadToCloudinary(url, type = "image") {
  try {
    if (!url) return null;

    let uploadSource = url;

    if (url.includes("lookaside.fbsbx.com")) {
      const mediaRes = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      });

      const contentType = mediaRes.headers["content-type"] || "image/jpeg";
      const base64 = Buffer.from(mediaRes.data).toString("base64");

      uploadSource = `data:${contentType};base64,${base64}`;
    }

    const result = await cloudinary.uploader.upload(uploadSource, {
      resource_type: type,
    });

    return result.secure_url;
  } catch (err) {
    console.log("Cloudinary Upload Error:", err.response?.data || err.message);
    return null;
  }
}

async function updateTicket(id, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);

  keys.push("updated_at");
  values.push(new Date());

  const setQuery = keys.map((key, i) => `${key}=$${i + 1}`).join(", ");

  await db.query(
    `UPDATE tickets SET ${setQuery} WHERE id=$${keys.length + 1}`,
    [...values, id]
  );
}

const FINAL_MSG =
  " Ticket has been raised, we will process your concern soon.";

/* ================= BOT MESSAGE PROCESSOR ================= */
async function processMessage(jobData) {
  console.log("JOB RECEIVED:", jobData);

  try {
    const { ticketId, from, text } = jobData || {};

    if (!ticketId || !from) {
      console.log("Missing ticketId or from");
      return;
    }

    const { isImage, mediaUrl } = extractMedia(jobData);
    const message = cleanText(text);

    const res = await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId]);

    if (!res.rows.length) {
      console.log("Ticket not found");
      return;
    }

    const ticket = res.rows[0];

    let state = ticket?.state || "START";
    let category = ticket?.category || null;
    let subIssue = ticket?.sub_issue || null;

    state = typeof state === "string" ? state.trim().toUpperCase() : "START";
    category =
      typeof category === "string" ? category.trim().toUpperCase() : null;
    subIssue = typeof subIssue === "string" ? subIssue.trim() : null;

    console.log("STATE:", state);
    console.log("CATEGORY:", category);
    console.log("SUB ISSUE:", subIssue);

    if (state === "DONE" || state === "CLOSED") {
      await updateTicket(ticketId, {
        category: "MENU",
        state: "START",
        main_issue: null,
        sub_issue: null,
        issue: null,
        location: null,
        upi_id: null,
        image: null,
        upi_image: null,
        status: "OPEN",
      });

      return sendWhatsApp(
        from,
        `WELCOME TO SNACKIT!
How can we help you today?

1 Refund
2 Product
3 Feedback`
      );
    }

    if (!category) {
      await updateTicket(ticketId, { category: "MENU" });

      return sendWhatsApp(
        from,
        `WELCOME TO SNACKIT!
How can we help you today?

1 Refund
2 Product
3 Feedback`
      );
    }

    if (category === "MENU") {
      if (message === "1") {
        await updateTicket(ticketId, {
          category: "REFUND",
          state: "MAIN",
        });

        return sendWhatsApp(
          from,
          `Refund options:

1 Product Not Dispensed
2 Product Issue
3 Charged Higher MRP
4 Received Damaged Product`
        );
      }

      if (message === "2") {
        await updateTicket(ticketId, {
          category: "PRODUCT",
          state: "OPTIONS",
        });

        return sendWhatsApp(
          from,
          `Product options:
1 Brand Enquiry
2 Collaboration`
        );
      }

      if (message === "3") {
        await updateTicket(ticketId, {
          category: "FEEDBACK",
          state: "RATING",
        });

        return sendWhatsApp(from, "Rate us 1-5");
      }

      return sendWhatsApp(from, "Please Reply With 1, 2 or 3");
    }

    if (category === "REFUND") {
      if (state === "MAIN") {
        const map = {
          "1": "Product Not Dispensed",
          "2": "Product Issue",
          "3": "Charged Higher MRP",
          "4": "Recieved Damaged Product",
        };

        if (!map[message]) return sendWhatsApp(from, "Choose 1-4");

        subIssue = map[message];

        await updateTicket(ticketId, {
          main_issue: "Refund",
          sub_issue: subIssue,
          state: "LOCATION",
        });

        return sendWhatsApp(
          from,
          "Enter machine location along with the company name"
        );
      }

      if (subIssue === "Product Not Dispensed") {
        if (state === "LOCATION") {
          await updateTicket(ticketId, {
            location: text,
            state: "STEP1",
          });

          return sendWhatsApp(from, "Send the product image please");
        }

        if (state === "STEP1") {
          if (!isImage || !mediaUrl) {
            return sendWhatsApp(from, "Please send product image");
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          await updateTicket(ticketId, {
            image: uploaded || mediaUrl,
            state: "STEP2",
          });

          return sendWhatsApp(from, "Enter your UPI Transaction ID please ");
        }

        if (state === "STEP2") {
          if (!text || text.trim().length < 5) {
            return sendWhatsApp(from, "Enter your UPI Transaction ID please ");
          }

          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "STEP3",
          });

          return sendWhatsApp(from, "Send your UPI Transaction image please");
        }

        if (state === "STEP3") {
          if (!isImage || !mediaUrl) {
            return sendWhatsApp(
              from,
              "Please send your UPI transaction image"
            );
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(
              from,
              "Image upload failed. Please send your UPI transaction image again."
            );
          }

          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(from, FINAL_MSG);
        }
      }

      if (subIssue === "Product Issue") {
        if (state === "LOCATION") {
          await updateTicket(ticketId, { state: "EXP_IMG" });
          return sendWhatsApp(from, "Send the expiry image please");
        }

        if (state === "EXP_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          await updateTicket(ticketId, {
            image: uploaded || mediaUrl,
            state: "EXP_UPI",
          });

          return sendWhatsApp(from, "Enter your UPI Transaction ID please");
        }

        if (state === "EXP_UPI") {
          if (!text || text.trim().length < 5) {
            return sendWhatsApp(from, "Enter your UPI Transaction ID please");
          }

          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "EXP_UPI_IMG",
          });

          return sendWhatsApp(from, "Send your UPI Transaction image please");
        }

        if (state === "EXP_UPI_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          if (!uploaded) {
            return sendWhatsApp(
              from,
              "Image upload failed. Please send your UPI transaction image again."
            );
          }

          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(from, FINAL_MSG);
        }
      }

      if (subIssue === "Charged Higher MRP") {
        if (state === "LOCATION") {
          await updateTicket(ticketId, { state: "PRICE_IMG" });
          return sendWhatsApp(from, "Send your product price image please");
        }

        if (state === "PRICE_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          await updateTicket(ticketId, {
            image: uploaded || mediaUrl,
            state: "PRICE_UPI",
          });

          return sendWhatsApp(from, "Enter your UPI Transaction  ID");
        }

        if (state === "PRICE_UPI") {
          if (!text || text.trim().length < 5) {
            return sendWhatsApp(from, "Enter your UPI Transaction ID");
          }

          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "PRICE_UPI_IMG",
          });

          return sendWhatsApp(from, "Send your UPI Transaction image please");
        }

        if (state === "PRICE_UPI_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          if (!uploaded) {
            return sendWhatsApp(
              from,
              "Image upload failed. Please send your UPI transaction image again."
            );
          }

          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(from, FINAL_MSG);
        }
      }

      if (subIssue === "Recieved Damaged Product") {
        if (state === "LOCATION") {
          await updateTicket(ticketId, { state: "DAM_IMG" });
          return sendWhatsApp(from, "Send the damaged product image please");
        }

        if (state === "DAM_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          await updateTicket(ticketId, {
            image: uploaded || mediaUrl,
            state: "DAM_UPI",
          });

          return sendWhatsApp(from, "Enter your UPI transaction ID please");
        }

        if (state === "DAM_UPI") {
          if (!text || text.trim().length < 5) {
            return sendWhatsApp(from, "Enter your UPI transaction ID please");
          }

          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "DAM_UPI_IMG",
          });

          return sendWhatsApp(from, "Send your UPI screenshot please");
        }

        if (state === "DAM_UPI_IMG") {
          const uploaded =
            isImage && mediaUrl ? await uploadToCloudinary(mediaUrl) : null;

          if (!uploaded) {
            return sendWhatsApp(
              from,
              "Image upload failed. Please send your UPI screenshot again."
            );
          }

          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(from, FINAL_MSG);
        }
      }
    }

    if (category === "PRODUCT") {
      if (state === "OPTIONS") {
        if (message === "1") {
          await db.query(
            "INSERT INTO product_leads (phone, type) VALUES ($1, $2)",
            [from, "Brand Enquiry"]
          );

          await updateTicket(ticketId, {
            main_issue: "Product",
            sub_issue: "Brand Enquiry",
            state: "CLOSED",
            status: "closed",
          });

          return sendWhatsApp(
            from,
            "Thank you for your interest in Snackit.\n\nSnackit is a fast-growing smart vending solutions company providing seamless, cashless food and beverage experiences through our automated machines across multiple locations.\n\nIf you are a brand looking to showcase or distribute your products through our vending network, we would be happy to explore opportunities with you.\n\nPlease contact us at info@snackit.in. Our team will get in touch with you shortly."
          );
        }

        if (message === "2") {
          await db.query(
            "INSERT INTO product_leads (phone, type) VALUES ($1, $2)",
            [from, "Collaboration"]
          );

          await updateTicket(ticketId, {
            main_issue: "Product",
            sub_issue: "Collaboration",
            state: "CLOSED",
            status: "closed",
          });

          return sendWhatsApp(
            from,
            "Thank you for your interest in collaborating with Snackit.\n\nSnackit partners with innovative brands to introduce new and exciting products through our smart vending machine network, helping increase product visibility and customer reach.\n\nWe are always open to mutually beneficial collaborations.\n\nPlease reach out to us at info@snackit.in. Our team will review your request and connect with you soon."
          );
        }

        return sendWhatsApp(from, "Please Choose 1 or 2");
      }
    }

    if (category === "FEEDBACK") {
      if (state === "RATING") {
        if (!["1", "2", "3", "4", "5"].includes(message)) {
          return sendWhatsApp(from, "Rate us 1-5");
        }

        if (!global.feedbackActive) global.feedbackActive = {};
        global.feedbackActive[from] = message;

        await updateTicket(ticketId, {
          main_issue: "Feedback",
          state: "COMMENT",
        });

        return sendWhatsApp(from, "Please share your feedback");
      }

      if (state === "COMMENT") {
        const rating = global.feedbackActive?.[from] || null;

        await db.query(
          "INSERT INTO feedback (phone, rating, comment) VALUES ($1, $2, $3)",
          [from, rating, text || ""]
        );

        if (global.feedbackActive) {
          delete global.feedbackActive[from];
        }

        await updateTicket(ticketId, {
          state: "CLOSED",
          status: "closed",
        });

        return sendWhatsApp(from, "Thank you for your valuable feedback.");
      }
    }
  } catch (err) {
    console.log("PROCESS MESSAGE ERROR:", err.message);
  }
}

/* =========================================================
    AUTH MIDDLEWARE
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
    LOGIN
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
    GET REFUND TICKETS ONLY
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
          : `https://whatsapp-bot-backend-b3nb.onrender.com/${t.image}`
        : null,

      upi_image: t.upi_image
        ? t.upi_image.startsWith("http")
          ? t.upi_image
          : `https://whatsapp-bot-backend-b3nb.onrender.com/${t.upi_image}`
        : null,
    }));

    res.json(rows);
  } catch (err) {
    console.log("FETCH ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
    GET FEEDBACK
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
   GET PRODUCT LEADS
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
    TICKET ACTION
========================================================= */
app.post("/ticket/action", auth, async (req, res) => {
  try {
    const { ticketId, action } = req.body;

    if (!ticketId || !action) {
      return res.status(400).json({ error: "Missing data" });
    }

    const result = await db.query("SELECT * FROM tickets WHERE id=$1", [
      ticketId,
    ]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const ticket = result.rows[0];

    let message, status;

    switch (action) {
      case "Refund":
        message = "Refund processed Now. Please check your bank in 5-10 minutes.";
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

      case "CLOSED":
        message = "Your ticket has been closed. Thank you for contacting Snackit!";
        status = "closed";
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
  CLOSE TICKET
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
   ANALYTICS
========================================================= */
app.get("/analytics/product-not-dispensed", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COALESCE(NULLIF(sub_issue, ''), 'No Sub Issue') as sub_issue,
        COUNT(*) as count
      FROM tickets
      GROUP BY DATE(created_at), COALESCE(NULLIF(sub_issue, ''), 'No Sub Issue')
      ORDER BY date
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/category", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        COALESCE(NULLIF(main_issue, ''), NULLIF(issue, ''), 'Unknown') as main_issue,
        COALESCE(NULLIF(sub_issue, ''), 'No Sub Issue') as sub_issue,
        COUNT(*) as count
      FROM tickets
      GROUP BY 
        COALESCE(NULLIF(main_issue, ''), NULLIF(issue, ''), 'Unknown'),
        COALESCE(NULLIF(sub_issue, ''), 'No Sub Issue')
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

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
    WEBHOOK VERIFY
========================================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("Webhook verification failed");
  res.sendStatus(403);
});

/* =========================================================
   WEBHOOK RECEIVE
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

    console.log("Incoming:", { from, text, type, isImage, mediaUrl });
    console.log("Creating/getting ticket for:", from);

    const ticket = await getOrCreateTicket(from);

    console.log("Ticket result:", ticket?.id);

    if (!ticket) {
      console.log("Ticket creation failed for:", from);
      return res.sendStatus(200);
    }

    await processMessage({
      ticketId: ticket.id,
      from,
      text,
      type,
      isImage,
      mediaUrl,
      mediaType,
      timestamp: Number(msg.timestamp || Date.now()),
    });

    res.sendStatus(200);
  } catch (err) {
    console.log("WEBHOOK ERROR:", err.message);
    res.sendStatus(200);
  }
});

/* =========================================================
    HEALTH CHECK
========================================================= */
app.get("/", (req, res) => {
  res.send("Snackit backend running");
});

/* =========================================================
    START SERVER
========================================================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(` Server running on port ${PORT}`);
});