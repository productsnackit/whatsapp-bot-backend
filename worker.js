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
    if (!url) return null; // 🔥 FIX 1

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

/* ================= MEDIA FIX ================= */
function extractMedia(jobData) {
  return {
    isImage: Boolean(jobData?.isImage),

    // 🔥 IMPORTANT FIX: accept mediaId from webhook
    mediaId:
      jobData?.mediaId ||
      jobData?.imageId ||
      jobData?.url ||
      jobData?.image ||
      null,
  };
}

/* ================= GET WHATSAPP MEDIA ================= */
async function getMediaUrl(mediaId) {
  try {
    if (!mediaId) return null;

    const meta = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
      }
    );

    const file = await axios.get(meta.data.url, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      responseType: "arraybuffer",
    });

    const base64 = Buffer.from(file.data).toString("base64");

    const upload = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${base64}`,
      { resource_type: "image" }
    );

    return upload.secure_url;
  } catch (err) {
    console.log("Media fetch error:", err.message);
    return null;
  }
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

      if (!ticketId || !from) return;

      const { isImage, mediaId } = extractMedia(job.data);

      const message = cleanText(text);

      const res = await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId]);
      if (!res.rows.length) return;

      const ticket = res.rows[0];

      let state = ticket.state;
      let category = ticket.category;
      let subIssue = ticket.sub_issue;

      /* ================= REFUND ONLY FIXED PART ================= */
      if (category === "REFUND") {

        if (state === "LOCATION") {

          if (isImage && mediaId) {
            const uploaded = await getMediaUrl(mediaId); // 🔥 FIX

            if (uploaded) {
              await updateTicket(ticketId, { image: uploaded });
            }
          }

          await updateTicket(ticketId, {
            location: text,
            state: "STEP1",
          });

          return sendWhatsApp(from, "Enter UPI ID");
        }

        if (subIssue === "Product not dispensed") {

          if (state === "STEP1") {

            if (isImage && mediaId) {
              const uploaded = await getMediaUrl(mediaId);

              if (uploaded) {
                await updateTicket(ticketId, { image: uploaded });
              }
            }

            await updateTicket(ticketId, { state: "STEP2" });
            return sendWhatsApp(from, "Enter UPI ID");
          }

          if (state === "STEP3") {

            if (isImage && mediaId) {
              const uploaded = await getMediaUrl(mediaId);

              if (uploaded) {
                await updateTicket(ticketId, { upi_image: uploaded });
              }
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