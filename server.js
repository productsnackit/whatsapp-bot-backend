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
if (!global.adminTakeover) global.adminTakeover = {};
if (!global.retryCount) global.retryCount = {}; // Track retry attempts

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

async function updateTicketByPhone(phone, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);

  const setQuery = keys.map((key, i) => `${key}=$${i + 1}`).join(", ");

  await db.query(
    `UPDATE tickets SET ${setQuery} WHERE phone=$${keys.length + 1}`,
    [...values, phone]
  );
}

async function saveMessageByPhone(phone, sender, message) {
  try {
    const res = await db.query(
      "SELECT id FROM tickets WHERE phone = $1",
      [phone]
    );

    if (!res.rows.length) return;

    const ticketId = res.rows[0].id;

    await db.query(
      "INSERT INTO messages (ticket_id, sender, message) VALUES ($1, $2, $3)",
      [ticketId, sender, message]
    );

  } catch (err) {
    console.error("Error saving message:", err);
  }
}

async function saveMessage(ticketId, sender, message) {
  try {
    if (!ticketId) return;
    await db.query(
      "INSERT INTO messages (ticket_id, sender, message) VALUES ($1, $2, $3)",
      [ticketId, sender, message]
    );
  } catch (err) {
    console.error("Error saving message:", err);
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

/* ================= VALIDATION FUNCTIONS (NEXT LEVEL) ================= */

// Validate UPI ID format
function validateUPIId(upiId) {
  if (!upiId || upiId.length < 5) return false;
  
  // UPI format: username@bankname or phone@bankname
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/;
  return upiRegex.test(upiId);
}

// Check if input is alphabetic (invalid for UPI)
function isAlphabetOnly(text) {
  return /^[a-zA-Z\s]+$/.test(text);
}

// Check if it's a valid transaction ID format (alphanumeric, no special chars)
function isValidTransactionId(text) {
  return /^[a-zA-Z0-9]{5,}$/.test(text);
}

// Validate image media type
function isValidImage(mediaType) {
  return mediaType === "image" || (mediaType && mediaType.startsWith("image/"));
}

// Validate if it's video (should reject for image upload)
function isVideo(mediaType) {
  return mediaType === "video" || (mediaType && mediaType.startsWith("video/"));
}

// Get retry key for a user
function getRetryKey(ticketId, step) {
  return `${ticketId}-${step}`;
}

// Increment retry count
function incrementRetry(key) {
  if (!global.retryCount[key]) global.retryCount[key] = 0;
  global.retryCount[key]++;
  return global.retryCount[key];
}

// Reset retry count
function resetRetry(key) {
  delete global.retryCount[key];
}

// Get retry count
function getRetryCount(key) {
  return global.retryCount[key] || 0;
}

const FINAL_MSG = "✅ Ticket has been raised, we will process your concern soon.";
const MAX_RETRIES = 3;

/* ================= BOT MESSAGE PROCESSOR - NEXT LEVEL ================= */
async function processMessage(jobData) {
  console.log("JOB RECEIVED:", jobData);

  try {
    const { ticketId, from, text } = jobData || {};

    if (!ticketId || !from) {
      console.log("Missing ticketId or from");
      return;
    }

    const { isImage, mediaUrl, mediaType } = extractMedia(jobData);
    const message = cleanText(text);

    const res = await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId]);

    if (!res.rows.length) {
      console.log("Ticket not found");
      return;
    }

    const existingTicket = res.rows[0];

    // ADMIN TAKEOVER CHECK
    if (existingTicket.takeover === true || existingTicket.takeover === "true") {
      console.log("Admin handling this chat");
      return;
    }

    let state = existingTicket.state || "START";
    let category = existingTicket.category || null;
    let subIssue = existingTicket.sub_issue || null;

    state = typeof state === "string" ? state.trim().toUpperCase() : "START";
    category = typeof category === "string" ? category.trim().toUpperCase() : null;
    subIssue = typeof subIssue === "string" ? subIssue.trim() : null;

    console.log("STATE:", state);
    console.log("CATEGORY:", category);
    console.log("SUB ISSUE:", subIssue);

    // Already closed or done states
    if (state === "DONE") {
      return sendWhatsApp(
        from,
        "✅ Your ticket is already raised. Our team will assist you shortly."
      );
    }

    if (state === "CLOSED") {
      return sendWhatsApp(
        from,
        "🔄 Your previous ticket is closed. Please type *1* to create a new request."
      );
    }

    // INITIAL MENU
    if (!category) {
      await updateTicket(ticketId, { category: "MENU" });

      return sendWhatsApp(
        from,
        `👋 *WELCOME TO SNACKIT!*

How can we help you today?

1️⃣ Refund Issues
2️⃣ Product Enquiry
3️⃣ Share Feedback

Please reply with the number (1, 2, or 3)`
      );
    }

    // CATEGORY SELECTION
    if (category === "MENU") {
      if (message === "1") {
        await updateTicket(ticketId, {
          category: "REFUND",
          state: "MAIN",
        });

        return sendWhatsApp(
          from,
          `💰 *REFUND OPTIONS*

What's your refund issue?

1️⃣ Product Not Dispensed
2️⃣ Product Issue
3️⃣ Charged Higher Price
4️⃣ Received Damaged Product

Please reply with the number (1-4)`
        );
      }

      if (message === "2") {
        await updateTicket(ticketId, {
          category: "PRODUCT",
          state: "OPTIONS",
        });

        return sendWhatsApp(
          from,
          `🛍️ *PRODUCT ENQUIRY*

What would you like to do?

1️⃣ Brand Enquiry
2️⃣ Partnership/Collaboration

Please reply with the number (1 or 2)`
        );
      }

      if (message === "3") {
        await updateTicket(ticketId, {
          category: "FEEDBACK",
          state: "RATING",
        });

        return sendWhatsApp(
          from,
          `⭐ *RATE YOUR EXPERIENCE*

Please rate us on a scale of 1-5:
1️⃣ Very Bad
2️⃣ Bad
3️⃣ Average
4️⃣ Good
5️⃣ Excellent

Reply with your rating (1-5)`
        );
      }

      return sendWhatsApp(
        from,
        `❌ Invalid option. Please reply with *1*, *2*, or *3* only.`
      );
    }

    // ===== REFUND LOGIC =====
    if (category === "REFUND") {
      if (state === "MAIN") {
        const map = {
          "1": "Product Not Dispensed",
          "2": "Product Issue",
          "3": "Charged Higher MRP",
          "4": "Received Damaged Product",
        };

        if (!map[message]) {
          return sendWhatsApp(
            from,
            `❌ Invalid choice. Please reply with *1*, *2*, *3*, or *4* only.`
          );
        }

        subIssue = map[message];

        await updateTicket(ticketId, {
          main_issue: "Refund",
          sub_issue: subIssue,
          state: "LOCATION",
        });

        return sendWhatsApp(
          from,
          `📍 *MACHINE LOCATION REQUIRED*

Please share the machine location along with the company/store name.

Example: "Bangalore Airport Terminal 2, TCS Canteen"`
        );
      }

      // PRODUCT NOT DISPENSED
      if (subIssue === "Product Not Dispensed") {
        if (state === "LOCATION") {
          if (!text || text.length < 5) {
            return sendWhatsApp(
              from,
              `❌ Please provide a valid location. Include store name and city.`
            );
          }

          await updateTicket(ticketId, {
            location: text,
            state: "STEP1",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND PRODUCT IMAGE*

Please send a clear photo of the product/machine where issue occurred.

⚠️ Make sure:
✓ Image is clear and visible
✓ You can see the product/machine clearly`
          );
        }

        if (state === "STEP1") {
          const retryKey = getRetryKey(ticketId, "STEP1_IMAGE");

          // Check if it's a video (reject)
          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP1" });
              return sendWhatsApp(
                from,
                `❌ Maximum attempts exceeded for image upload. Please type *1* to restart or contact support.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Please send an *IMAGE*, not a video.

Attempt ${retries}/${MAX_RETRIES}

Send a clear photo of the product/machine.`
            );
          }

          // Check if it's a valid image
          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP1" });
              return sendWhatsApp(
                from,
                `❌ Could not process image. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Image not received properly.

Attempt ${retries}/${MAX_RETRIES}

Please send a clear photo.`
            );
          }

          // Upload image
          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP1" });
              return sendWhatsApp(
                from,
                `❌ Image upload failed multiple times. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Upload failed. Attempt ${retries}/${MAX_RETRIES}

Please try again.`
            );
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            image: uploaded,
            state: "STEP2",
          });

          return sendWhatsApp(
            from,
            `✅ Image received!

💳 *ENTER UPI TRANSACTION ID*

Share the UPI Transaction ID (found in your payment app).

Example: "1234567890566654"`
          );
        }

        if (state === "STEP2") {
          const retryKey = getRetryKey(ticketId, "STEP2_UPI");

          // Check if it's alphabetic only
          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            return sendWhatsApp(
              from,
              `❌ UPI ID contains only letters. This is invalid.

Attempt ${retries}/${MAX_RETRIES}

UPI ID should have numbers.Example: "36263772828822"`
            );
          }

          // Validate UPI format
          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP2" });
              return sendWhatsApp(
                from,
                `❌ Invalid Transaction ID format after multiple attempts. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Invalid UPI Transaction ID.

Attempt ${retries}/${MAX_RETRIES}

Transaction ID should be alphanumeric (numbers & letters only, no spaces).

Example: "UTR123456789ABC"`
            );
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "STEP3",
          });

          return sendWhatsApp(
            from,
            `💾 UPI ID received!

📸 *SEND UPI TRANSACTION SCREENSHOT*

Please send a screenshot of the UPI transaction from your payment app.

⚠️ Make sure:
✓ Screenshot shows date & time
✓ Transaction amount is visible
✓ Status is clear`
          );
        }

        if (state === "STEP3") {
          const retryKey = getRetryKey(ticketId, "STEP3_IMAGE");

          // Check if it's a video (reject)
          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP3" });
              return sendWhatsApp(
                from,
                `❌ Maximum attempts exceeded. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Please send an *IMAGE*, not a video.

Attempt ${retries}/${MAX_RETRIES}

Send your UPI screenshot.`
            );
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP3" });
              return sendWhatsApp(
                from,
                `❌ Image could not be processed. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Screenshot not received.

Attempt ${retries}/${MAX_RETRIES}

Please send your UPI transaction screenshot.`
            );
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            if (retries >= MAX_RETRIES) {
              await updateTicket(ticketId, { state: "FAILED_STEP3" });
              return sendWhatsApp(
                from,
                `❌ Upload failed multiple times. Please type *1* to restart.`
              );
            }

            return sendWhatsApp(
              from,
              `❌ Upload failed. Attempt ${retries}/${MAX_RETRIES}

Try again.`
            );
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(
            from,
            `✅ *TICKET SUBMITTED SUCCESSFULLY!*

📋 Your refund request has been received.

🕐 Processing time: 1 working day

Our team will review and contact you soon.

Thank you for choosing Snackit!`
          );
        }
      }

      // PRODUCT EXPIRED/DAMAGED
      if (subIssue === "Product Expired/Damaged") {
        if (state === "LOCATION") {
          if (!text || text.length < 5) {
            return sendWhatsApp(
              from,
              `❌ Please provide a valid location.`
            );
          }

          await updateTicket(ticketId, {
            location: text,
            state: "EXP_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND PRODUCT IMAGE*

Please send a clear photo showing the expiry date or damage.`
          );
        }

        if (state === "EXP_IMG") {
          const retryKey = getRetryKey(ticketId, "EXP_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Image not received. Please try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Please try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            image: uploaded,
            state: "EXP_UPI",
          });

          return sendWhatsApp(
            from,
            `✅ Image received!

💳 *ENTER UPI TRANSACTION ID*

Share your UPI Transaction ID.`
          );
        }

        if (state === "EXP_UPI") {
          const retryKey = getRetryKey(ticketId, "EXP_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ UPI ID should contain numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ Invalid UPI ID format. Try again.`
            );
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "EXP_UPI_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND UPI SCREENSHOT*

Please send your transaction screenshot.`
          );
        }

        if (state === "EXP_UPI_IMG") {
          const retryKey = getRetryKey(ticketId, "EXP_UPI_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Screenshot not received. Try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(
            from,
            `✅ *TICKET SUBMITTED!*

Your request has been received. We'll review within short time.

Thank you!`
          );
        }
      }

      // CHARGED HIGHER MRP
      if (subIssue === "Charged Higher MRP") {
        if (state === "LOCATION") {
          if (!text || text.length < 5) {
            return sendWhatsApp(
              from,
              `❌ Please provide a valid location.`
            );
          }

          await updateTicket(ticketId, {
            location: text,
            state: "PRICE_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND PRODUCT PRICE IMAGE*

Show the product with its price tag clearly visible.`
          );
        }

        if (state === "PRICE_IMG") {
          const retryKey = getRetryKey(ticketId, "PRICE_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Image not received. Try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            image: uploaded,
            state: "PRICE_UPI",
          });

          return sendWhatsApp(
            from,
            `✅ Image received!

💳 *ENTER UPI TRANSACTION ID*`
          );
        }

        if (state === "PRICE_UPI") {
          const retryKey = getRetryKey(ticketId, "PRICE_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ UPI ID should have numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Invalid UPI ID format. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "PRICE_UPI_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND UPI SCREENSHOT*`
          );
        }

        if (state === "PRICE_UPI_IMG") {
          const retryKey = getRetryKey(ticketId, "PRICE_UPI_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Screenshot not received. Try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(
            from,
            `✅ *TICKET SUBMITTED!*

We've received your complaint. Expected resolution: 1 working day.

Thank you!`
          );
        }
      }

      // RECEIVED DAMAGED PRODUCT
      if (subIssue === "Received Damaged Product") {
        if (state === "LOCATION") {
          if (!text || text.length < 5) {
            return sendWhatsApp(
              from,
              `❌ Please provide a valid location.`
            );
          }

          await updateTicket(ticketId, {
            location: text,
            state: "DAM_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND DAMAGED PRODUCT IMAGE*

Show the damage clearly in the photo.`
          );
        }

        if (state === "DAM_IMG") {
          const retryKey = getRetryKey(ticketId, "DAM_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Image not received. Try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            image: uploaded,
            state: "DAM_UPI",
          });

          return sendWhatsApp(
            from,
            `✅ Image received!

💳 *ENTER UPI TRANSACTION ID*`
          );
        }

        if (state === "DAM_UPI") {
          const retryKey = getRetryKey(ticketId, "DAM_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ UPI ID should have numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Invalid UPI ID format. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_id: text.trim(),
            state: "DAM_UPI_IMG",
          });

          return sendWhatsApp(
            from,
            `📸 *SEND UPI SCREENSHOT*`
          );
        }

        if (state === "DAM_UPI_IMG") {
          const retryKey = getRetryKey(ticketId, "DAM_UPI_IMG");

          if (isVideo(mediaType)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Please send an *IMAGE*, not a video.`);
          }

          if (!isImage || !mediaUrl) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Screenshot not received. Try again.`);
          }

          const uploaded = await uploadToCloudinary(mediaUrl);

          if (!uploaded) {
            return sendWhatsApp(from, `❌ Upload failed. Try again.`);
          }

          resetRetry(retryKey);
          await updateTicket(ticketId, {
            upi_image: uploaded,
            state: "DONE",
            status: "PROCESSING",
          });

          return sendWhatsApp(
            from,
            `✅ *TICKET SUBMITTED!*

We regret the inconvenience. Our team will process this within short time.

Thank you for your patience!`
          );
        }
      }
    }

    // ===== PRODUCT ENQUIRY LOGIC =====
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
            `✅ *Thank you for your interest!*

Snackit is a fast-growing smart vending solutions company providing seamless, cashless food and beverage experiences through automated machines across India.

🤝 If you're a brand looking to showcase or distribute your products through our network, we'd love to collaborate!

📧 *Contact us:* info@snackit.in

Our team will reach out shortly.`
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
            `✅ *Partnership Opportunity!*

Snackit partners with innovative brands to introduce exciting products through our smart vending machine network.

🌟 Benefits:
✓ Increased product visibility
✓ Wider customer reach
✓ Seamless integration

📧 *Contact:* info@snackit.in

We're always open to mutually beneficial collaborations! 🤝`
          );
        }

        return sendWhatsApp(
          from,
          `❌ Invalid option. Please reply with *1* or *2*.`
        );
      }
    }

    // ===== FEEDBACK LOGIC =====
    if (category === "FEEDBACK") {
      if (state === "RATING") {
        if (!["1", "2", "3", "4", "5"].includes(message)) {
          return sendWhatsApp(
            from,
            `❌ Invalid rating. Please reply with a number between *1* and *5*.`
          );
        }

        if (!global.feedbackActive) global.feedbackActive = {};
        global.feedbackActive[from] = message;

        await updateTicket(ticketId, {
          main_issue: "Feedback",
          state: "COMMENT",
        });

        return sendWhatsApp(
          from,
          `✅ Thanks for rating us *${message}/5*!

📝 *SHARE YOUR FEEDBACK*

Tell us what we can improve. Any comments or suggestions?`
        );
      }

      if (state === "COMMENT") {
        const rating = global.feedbackActive?.[from] || null;

        if (!text || text.length < 3) {
          return sendWhatsApp(
            from,
            `❌ Please share meaningful feedback (at least 3 characters).`
          );
        }

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

        return sendWhatsApp(
          from,
          ` *THANK YOU FOR YOUR FEEDBACK!*

Your feedback helps us improve. We appreciate it!

Keep using Snackit!`
        );
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
        refund_amount,
        status,
        state,
        takeover,
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
    console.log("🔥 API CALLED");

    const { ticketId, action, } = req.body;

    console.log("DATA:", ticketId, action);

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

    console.log("PHONE:", ticket.phone);

    let message = "";
    let status = "";

    switch (action) {
      case "REFUNDED":
        message =
          "✅ *Refund Processed!*\n\nYour amount has been processed. Check your bank account in 5-10 minutes.\n\nThank you for your patience!";
        status = "refunded";
        break;

      case "AUTO_REFUNDED":
        message =
          "ℹ️ *Auto-Refund Detected*\n\nYour amount was already credited to your account. Please check your bank statement.\n\nThank you for your patience!";
        status = "auto_refunded";
        break;

      case "RESOLVED":
        message =
          "✅ *Issue Resolved!*\n\nYour concern has been resolved. Thank you for contacting Snackit!\n\nThank you for your patience!";
        status = "resolved";
        break;

      case "CLOSED":
        message =
          "🔒 *Ticket Closed*\n\nYour ticket has been closed. Thank you for using Snackit!\n\nFor new issues, Type 1.";
        status = "closed";
        break;

      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    console.log("MESSAGE:", message);

    let phone = ticket.phone;

    if (phone && !phone.startsWith("91")) {
      phone = "91" + phone;
    }

    if (phone) {
      console.log("📲 Sending WhatsApp to:", phone);
      await sendWhatsApp(phone, message);
      console.log("✅ WhatsApp sent");
    } else {
      console.log("❌ No phone found");
    }

    await db.query(
      `
      UPDATE tickets 
      SET status=$1, state='CLOSED', updated_at=NOW()
      WHERE id=$2
      `,
      [status, ticketId]
    );

    console.log("✅ DONE");

    res.json({ success: true });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/send", auth, async (req, res) => {
  try {
    const { phone, message, ticketId } = req.body;

    await sendWhatsApp(phone, message);

    if (ticketId) {
      await saveMessage(ticketId, "admin", message);
    } else {
      await saveMessageByPhone(phone, "admin", message);
    }

    res.json({ success: true });
  } catch (err) {
    console.log("ADMIN SEND ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/takeover", auth, async (req, res) => {
  try {
    const { phone } = req.body;

    await updateTicketByPhone(phone, {
      takeover: true
    });

    const result = await db.query("SELECT * FROM tickets WHERE phone=$1", [phone]);
    res.json({ success: true, ticket: result.rows[0] || null });
  } catch (err) {
    console.log("TAKEOVER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/release", auth, async (req, res) => {
  try {
    const { phone } = req.body;

    await updateTicketByPhone(phone, {
      takeover: false
    });

    const result = await db.query("SELECT * FROM tickets WHERE phone=$1", [phone]);
    res.json({ success: true, ticket: result.rows[0] || null });
  } catch (err) {
    console.log("RELEASE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/tickets/:id/refund-amount", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { refund_amount } = req.body;

    if (!id || refund_amount === undefined) {
      return res.status(400).json({ error: "Missing data" });
    }

    await db.query(
      "UPDATE tickets SET refund_amount=$1, updated_at=NOW() WHERE id=$2",
      [refund_amount, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.log("REFUND UPDATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

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

app.get("/analytics/refunds-daily", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        DATE(created_at) as date,
        SUM(CAST(refund_amount AS DECIMAL)) as total_refund
      FROM tickets
      WHERE refund_amount > 0
      GROUP BY DATE(created_at)
      ORDER BY date
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("REFUND DAILY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/refunds-monthly", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        SUM(CAST(refund_amount AS DECIMAL)) as total_refund
      FROM tickets
      WHERE refund_amount > 0
      GROUP BY month
      ORDER BY month
    `);
    res.json(result.rows);
  } catch (err) {
    console.log("REFUND MONTHLY ERROR:", err.message);
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

    await saveMessageByPhone(from, "user", text || "[media]");

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
    GET MESSAGES FOR A TICKET
========================================================= */
app.get("/admin/messages/:ticketId", auth, async (req, res) => {
  try {
    const { ticketId } = req.params;

    const result = await db.query(
      "SELECT * FROM messages WHERE ticket_id = $1 ORDER BY created_at ASC",
      [ticketId]
    );

    res.json(result.rows);
  } catch (err) {
    console.log("MESSAGES FETCH ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
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