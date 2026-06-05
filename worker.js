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

/* ================= MEDIA ================= */
function extractMedia(jobData) {
  return {
    isImage: Boolean(jobData?.isImage),
    mediaUrl:
      jobData?.mediaUrl ||
      jobData?.url ||
      jobData?.image ||
      jobData?.file ||
      null,
    mediaType: jobData?.mediaType || null,
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

/* ================= FINAL MESSAGE ================= */
const FINAL_MSG =
  "🎉 Ticket has been raised, we will process your concern soon.";

/* ================= WORKER ================= */
const worker = new Worker(
  "ticketQueue",
  async (job) => {
    console.log("🔥 JOB RECEIVED:", job.data);

    try {
      const { ticketId, from, text } = job.data || {};

      if (!ticketId || !from) return;

      const { isImage, mediaUrl } = extractMedia(job.data);
      const message = cleanText(text);

      const res = await db.query("SELECT * FROM tickets WHERE id=$1", [
        ticketId,
      ]);
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
          `👋 Welcome to Snackit!
How can we help you today?

1️⃣ Refund  
2️⃣ Product  
3️⃣ Feedback`
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

1 Product not dispensed  
2 Expired  
3 Wrong price  
4 Damaged`
          );
        }

        if (message === "2") {
          await updateTicket(ticketId, {
            category: "PRODUCT",
            state: "OPTIONS",
          });

          return sendWhatsApp(from, `Product options:\n1 Brand Enquiry\n2 Collaboration`);
        }

        if (message === "3") {
          await updateTicket(ticketId, {
            category: "FEEDBACK",
            state: "RATING",
          });

          return sendWhatsApp(from, "⭐ Rate us 1-5");
        }

        return sendWhatsApp(from, "Reply 1, 2 or 3");
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

        /* ================= PRODUCT NOT DISPENSED ================= */
        if (subIssue === "Product not dispensed") {
          if (state === "LOCATION") {
            await updateTicket(ticketId, { location: text, state: "STEP1" });
            return sendWhatsApp(from, "Send product image");
          }

          if (state === "STEP1") {
            if (isImage && mediaUrl) {
              const uploaded = await uploadToCloudinary(mediaUrl);
              await updateTicket(ticketId, {
                image: uploaded || mediaUrl,
                state: "STEP2",
              });
            }
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
            if (isImage && mediaUrl) {
              const uploaded = await uploadToCloudinary(mediaUrl);
              await updateTicket(ticketId, {
                upi_image: uploaded || mediaUrl,
                state: "DONE",
              });
            }

            await updateTicket(ticketId, { state: "DONE" });
            return sendWhatsApp(from, FINAL_MSG);
          }
        }

        /* ================= EXPIRY ================= */
        if (subIssue === "Expired") {
          if (state === "LOCATION") {
            await updateTicket(ticketId, { state: "EXP_IMG" });
            return sendWhatsApp(from, "Send expiry image");
          }

          if (state === "EXP_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              image: uploaded || mediaUrl,
              state: "EXP_UPI",
            });

            return sendWhatsApp(from, "Enter UPI ID");
          }

          if (state === "EXP_UPI") {
            await updateTicket(ticketId, {
              upi_id: text,
              state: "EXP_UPI_IMG",
            });

            return sendWhatsApp(from, "Send UPI screenshot");
          }

          if (state === "EXP_UPI_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              upi_image: uploaded || mediaUrl,
              state: "DONE",
            });

            return sendWhatsApp(from, FINAL_MSG);
          }
        }

        /* ================= WRONG PRICE ================= */
        if (subIssue === "Wrong price") {
          if (state === "LOCATION") {
            await updateTicket(ticketId, { state: "PRICE_IMG" });
            return sendWhatsApp(from, "Send product price image");
          }

          if (state === "PRICE_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              image: uploaded || mediaUrl,
              state: "PRICE_UPI",
            });

            return sendWhatsApp(from, "Enter UPI ID");
          }

          if (state === "PRICE_UPI") {
            await updateTicket(ticketId, {
              upi_id: text,
              state: "PRICE_UPI_IMG",
            });

            return sendWhatsApp(from, "Send UPI screenshot");
          }

          if (state === "PRICE_UPI_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              upi_image: uploaded || mediaUrl,
              state: "DONE",
            });

            return sendWhatsApp(from, FINAL_MSG);
          }
        }

        /* ================= DAMAGED ================= */
        if (subIssue === "Damaged") {
          if (state === "LOCATION") {
            await updateTicket(ticketId, { state: "DAM_IMG" });
            return sendWhatsApp(from, "Send damaged product image");
          }

          if (state === "DAM_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              image: uploaded || mediaUrl,
              state: "DAM_UPI",
            });

            return sendWhatsApp(from, "Enter UPI ID");
          }

          if (state === "DAM_UPI") {
            await updateTicket(ticketId, {
              upi_id: text,
              state: "DAM_UPI_IMG",
            });

            return sendWhatsApp(from, "Send UPI screenshot");
          }

          if (state === "DAM_UPI_IMG") {
            const uploaded = isImage
              ? await uploadToCloudinary(mediaUrl)
              : null;

            await updateTicket(ticketId, {
              upi_image: uploaded || mediaUrl,
              state: "DONE",
            });

            return sendWhatsApp(from, FINAL_MSG);
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