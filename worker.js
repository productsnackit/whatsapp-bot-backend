import dotenv from "dotenv";
dotenv.config();

import { Worker } from "bullmq";
import connection from "./redis.js";
import axios from "axios";
import db from "./db.js";

/* ================= CLOUDINARY ================= */
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadToCloudinary(url, type = "image") {
  try {
    if (!url) return null;

    const result = await cloudinary.uploader.upload(url, {
      resource_type: type,
    });

    return result.secure_url;
  } catch (err) {
    console.log("Cloudinary Upload Error:", err.message);
    return null;
  }
}

/* ================= HELPERS ================= */
function cleanText(text) {
  return (text || "").trim().toLowerCase();
}

/* ================= 🔥 FIX: WHATSAPP MEDIA FETCH ================= */
async function fetchWhatsAppMedia(mediaId) {
  try {
    if (!mediaId) return null;

    // Step 1: get media URL from WhatsApp
    const meta = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      }
    );

    const mediaUrl = meta.data.url;
    if (!mediaUrl) return null;

    // Step 2: download file
    const file = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      responseType: "arraybuffer",
    });

    const base64 = Buffer.from(file.data).toString("base64");

    // Step 3: upload to cloudinary
    const uploaded = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      { resource_type: "image" }
    );

    return uploaded.secure_url;
  } catch (err) {
    console.log("Media Fetch Error:", err.message);
    return null;
  }
}

/* ================= MEDIA (ONLY FIXED) ================= */
function extractMedia(jobData) {
  return {
    isImage: Boolean(jobData?.isImage),

    // 🔥 IMPORTANT FIX: WhatsApp sends image.id, not url
    mediaId:
      jobData?.mediaId ||
      jobData?.imageId ||
      jobData?.id ||
      null,
  };
}

/* ================= WHATSAPP ================= */
async function sendWhatsApp(to, message) {
  try {
    const cleanNumber = (to || "").replace(/\D/g, "");

    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: cleanNumber,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.log("WhatsApp Error:", err.response?.data || err.message);
  }
}

/* ================= DB UPDATE ================= */
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

/* ================= WORKER ================= */
const worker = new Worker(
  "ticketQueue",
  async (job) => {
    console.log("🔥 JOB RECEIVED:", job.data);

    try {
      const { ticketId, from, text } = job.data || {};

      if (!ticketId || !from) {
        console.log("❌ Invalid job data");
        return;
      }

      const { isImage, mediaId } = extractMedia(job.data);

      const message = cleanText(text);

      const res = await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId]);
      if (!res.rows.length) return;

      const ticket = res.rows[0];

      let state = ticket.state;
      let category = ticket.category;
      let subIssue = ticket.sub_issue;

      /* ================= MENU ================= */
      if (!category) {
        await updateTicket(ticketId, { category: "MENU" });

        return sendWhatsApp(
          from,
          `👋 Welcome

1️⃣ Refund  
2️⃣ Product  
3️⃣ Feedback`
        );
      }

      if (category === "MENU") {
        if (message === "1") {
          await updateTicket(ticketId, { category: "REFUND", state: "MAIN" });

          return sendWhatsApp(from,
            `Refund options:

1 Product not dispensed  
2 Expired  
3 Wrong price  
4 Damaged`
          );
        }

        if (message === "2") {
          await updateTicket(ticketId, { category: "PRODUCT", state: "OPTIONS" });

          return sendWhatsApp(from,
            `Product options:

1 Brand Enquiry  
2 New Product Collaboration`
          );
        }

        if (message === "3") {
          await updateTicket(ticketId, { category: "FEEDBACK", state: "RATING" });

          return sendWhatsApp(from, "⭐ Please rate your experience (1 to 5)");
        }

        return sendWhatsApp(from, "Reply 1, 2 or 3");
      }

      /* ================= PRODUCT ================= */
      if (category === "PRODUCT") {
        if (state === "OPTIONS") {
          if (message === "1") {
            await db.query(
              `INSERT INTO product_leads (phone, type, created_at)
               VALUES ($1, $2, NOW())`,
              [from, "Brand Enquiry"]
            );

            await updateTicket(ticketId, { state: "DONE", status: "done" });

            return sendWhatsApp(from, `🏢 About Snackit...`);
          }

          if (message === "2") {
            await db.query(
              `INSERT INTO product_leads (phone, type, created_at)
               VALUES ($1, $2, NOW())`,
              [from, "Collaboration"]
            );

            await updateTicket(ticketId, { state: "DONE", status: "done" });

            return sendWhatsApp(from, `🤝 Collaboration accepted.`);
          }

          return sendWhatsApp(from, "Reply 1 or 2");
        }
      }

      /* ================= FEEDBACK ================= */
      if (category === "FEEDBACK") {
        if (state === "RATING") {
          const rating = parseInt(message);

          if (!rating || rating < 1 || rating > 5)
            return sendWhatsApp(from, "Enter rating 1-5");

          await updateTicket(ticketId, {
            state: "COMMENT",
            rating,
          });

          return sendWhatsApp(from, "📝 Enter your feedback");
        }

        if (state === "COMMENT") {
          await db.query(
            `INSERT INTO feedback (phone, rating, comment, created_at)
             VALUES ($1, $2, $3, NOW())`,
            [from, ticket.rating || 0, text]
          );

          await updateTicket(ticketId, { state: "DONE", status: "done" });

          return sendWhatsApp(from, "🙏 Thank you!");
        }
      }

      /* ================= REFUND ================= */
      if (category === "REFUND") {
        if (state === "MAIN") {
          const map = {
            "1": "Product not dispensed",
            "2": "Expired",
            "3": "Wrong price",
            "4": "Damaged",
          };

          if (!map[message]) return sendWhatsApp(from, "Choose 1-4");

          subIssue = map[message];

          await updateTicket(ticketId, {
            main_issue: "Refund",
            sub_issue: subIssue,
            state: "LOCATION",
          });

          return sendWhatsApp(from, "Enter machine location");
        }

        if (state === "LOCATION") {
          if (isImage && mediaId) {
            const uploaded = await fetchWhatsAppMedia(mediaId);

            await updateTicket(ticketId, {
              image: uploaded || null,
            });
          }

          await updateTicket(ticketId, {
            location: text,
            state: "STEP1",
          });

          if (subIssue === "Product not dispensed")
            return sendWhatsApp(from, "Send product stuck image");

          return sendWhatsApp(from, "Enter UPI ID");
        }

        if (subIssue === "Product not dispensed") {
          if (state === "STEP1") {
            if (!isImage) return sendWhatsApp(from, "Send image");

            if (isImage && mediaId) {
              const uploaded = await fetchWhatsAppMedia(mediaId);

              await updateTicket(ticketId, {
                image: uploaded || null,
              });
            }

            await updateTicket(ticketId, { state: "STEP2" });
            return sendWhatsApp(from, "Enter UPI ID");
          }

          if (state === "STEP2") {
            await updateTicket(ticketId, {
              upi_id: text,
              state: "STEP3",
            });

            return sendWhatsApp(from, "Send UPI screenshot");
          }

          if (state === "STEP3") {
            if (!isImage) return sendWhatsApp(from, "Send image");

            if (isImage && mediaId) {
              const uploaded = await fetchWhatsAppMedia(mediaId);

              await updateTicket(ticketId, {
                upi_image: uploaded || null,
              });
            }

            await updateTicket(ticketId, { state: "DONE" });
            return sendWhatsApp(from, "✅ Done");
          }
        }
      }

    } catch (err) {
      console.log("Worker Error:", err.message);
    }
  },
  { connection }
);

console.log("✅ Worker running...");