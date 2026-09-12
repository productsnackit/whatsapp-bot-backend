import "dotenv/config";

/* ================= IMPORTS ================= */
import express from "express";
import http from "http";
import cors from "cors";
import axios from "axios";
import multer from "multer";
import XLSX from "xlsx";
import { Server } from "socket.io";
import { v2 as cloudinary } from "cloudinary";

import { getOrCreateTicket, verifyPaymentOnPaytm, storePaytmVerification } from "./ticketService.js";
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
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  },
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const operationsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowed = /\.(xlsx|xls)$/i.test(file.originalname || "");
    callback(allowed ? null : new Error("Only .xlsx and .xls files are allowed"), allowed);
  },
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message === "Only .xlsx and .xls files are allowed") {
    return res.status(400).json({ error: err.message || "Invalid spreadsheet upload" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Attachments are too large. Please send smaller files." });
  }
  if (err instanceof SyntaxError && err.status === 400 && err.body) {
    return res.status(400).json({ error: "Invalid request data. Please try the attachment again." });
  }
  return next(err);
});

io.on("connection", (socket) => {
  socket.on("join-internal-room", ({ department }) => {
    if (department) {
      socket.join(department);
    }
  });

  socket.on("join-internal-user", ({ userId }) => {
    if (userId) socket.join(`internal-user-${String(userId)}`);
  });
});

/* ================= FIX: SERVE UPLOADS ================= */
app.use("/uploads", express.static("uploads"));

/* ================= GLOBAL STATE ================= */
if (!global.feedbackActive) global.feedbackActive = {};
if (!global.feedbackTargetTicket) global.feedbackTargetTicket = {};
if (!global.upiActive) global.upiActive = {};
if (!global.adminTakeover) global.adminTakeover = {};
if (!global.retryCount) global.retryCount = {}; // Track retry attempts
if (!global.paytmVerificationAttempts) global.paytmVerificationAttempts = {}; // Paytm retry tracking

if (!global.botSettings) {
  global.botSettings = {
    paytm_verification_enabled: process.env.PAYTM_VERIFICATION_ENABLED === "true",
    auto_close_inactive_tickets: true,
    auto_close_minutes: 5,
    premium_message_mode: true,
  };
}

if (!global.internalUsers) {
  global.internalUsers = [
    ["Deepika", "Accounts", "Accounts Head"],
    ["Sushmitha", "Accounts", "Accounts executive"],
    ["Bala Supriya M", "HR", "HR Manager"],
    ["Yashmittha", "Operations", "Growth Officer"],
    ["Praharsha", "Product", "Product Manager"],
    ["Aparna", "Audit", "Audit Officer"],
    ["Wilson", "Technical", "Technical Executive"],
    ["Kushith", "Operations", "Operations Executive"],
    ["Monish", "Operations", "Operations Executive"],
    ["Srikanta", "Operations", "Operations Executive"],
    ["Vikas", "Operations", "Executive"],
    ["Tanu", "Operations", "Senior Executive"],
    ["Ganesh", "Operations", "Senior Executive"],
    ["Arun", "Operations", "Operations head"],
    ["Yash vardhan", "Operations", "Operations head"],
    ["Shantveer", "Operations", "Direct Sale Manager"],
    ["Xavier", "Technical", "Oprations and Technical Head"],
    ["Sujan", "Technical", "Technician"],
    ["Darshan", "Logistics", "Logistics Executive"],
  ].map(([name, department, role], index) => ({
    id: Date.now() + index,
    username: name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, ""),
    password: `Snackit@${String(index + 1).padStart(3, "0")}`,
    name,
    department,
    role,
    tags: [],
    isAdmin: false,
  }));
}

if (!global.internalSessions) {
  global.internalSessions = new Map();
}

if (!global.internalChats) {
  global.internalChats = [];
}

if (!global.internalNotifications) {
  global.internalNotifications = [];
}

if (!global.internalSavedReplies) {
  global.internalSavedReplies = [
    { id: "reply-follow-up", title: "Follow-up", text: "I am checking this with the team and will share an update shortly." },
    { id: "reply-resolved", title: "Resolved", text: "This has been resolved. Please reply here if anything else is needed." },
  ];
}

function getInternalTagList(tags) {
  return Array.isArray(tags)
    ? tags.map((tag) => String(tag).trim()).filter(Boolean).filter((tag, index, arr) => arr.indexOf(tag) === index)
    : [];
}

function addInternalNotification({ department, priority, title, targetUsers, message, sourceUser }) {
  const notification = {
    id: Date.now() + Math.random(),
    department,
    priority,
    title,
    targetUsers,
    message,
    sourceUser,
    createdAt: new Date().toISOString(),
  };

  global.internalNotifications.unshift(notification);
  return notification;
}

function getInternalUserKey(user) {
  if (user?.role === "admin") return "admin";
  return String(user?.userId || user?.id || user?.name || "user");
}

async function ensurePaytmSettingTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.log("APP SETTINGS TABLE ERROR:", err.message);
  }
}

async function ensureSupportColumns() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT NOT NULL UNIQUE,
        lat NUMERIC,
        lng NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS customer_risk (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        risk_score INTEGER NOT NULL DEFAULT 0,
        ticket_count INTEGER NOT NULL DEFAULT 0,
        last_ticket_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS assigned_to TEXT,
        ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT '',
        ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS machine_id INTEGER REFERENCES machines(id),
        ADD COLUMN IF NOT EXISTS refund_stage TEXT DEFAULT 'RAISED',
        ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ
    `);
    await db.query("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id)");
    await db.query(`
      INSERT INTO machines (name, location)
      SELECT DISTINCT LEFT(TRIM(location), 200), TRIM(location)
      FROM tickets
      WHERE NULLIF(TRIM(location), '') IS NOT NULL
      ON CONFLICT (location) DO NOTHING
    `);
    await db.query(`
      UPDATE tickets t SET machine_id = m.id
      FROM machines m
      WHERE t.machine_id IS NULL AND LOWER(TRIM(t.location)) = LOWER(m.location)
    `);
    await db.query("UPDATE tickets SET last_customer_message_at = COALESCE(last_customer_message_at, updated_at, created_at)");
    await db.query("UPDATE tickets SET refund_stage = CASE WHEN LOWER(status) IN ('refunded', 'auto_refunded', 'resolved') THEN 'PROCESSED' WHEN state = 'DONE' THEN 'UNDER_REVIEW' ELSE COALESCE(refund_stage, 'RAISED') END WHERE refund_stage IS NULL");
    await ensureOperationsTables();
  } catch (err) {
    console.log("SUPPORT COLUMNS ERROR:", err.message);
  }
}

async function ensureOperationsTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS host_sites (
        id SERIAL PRIMARY KEY, company_name TEXT NOT NULL, contact_name TEXT, contact_phone TEXT,
        contact_email TEXT, address TEXT, city TEXT, sector TEXT, contract_start DATE,
        contract_end DATE, service_charge NUMERIC DEFAULT 0, status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS machine_slots (
        id SERIAL PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
        slot_number TEXT NOT NULL, sku_id INTEGER, capacity INTEGER DEFAULT 0, current_stock INTEGER DEFAULT 0,
        low_stock_threshold INTEGER DEFAULT 2, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(machine_id, slot_number)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact_email TEXT, contact_phone TEXT,
        onboarded_at TIMESTAMPTZ DEFAULT NOW(), status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS skus (
        id SERIAL PRIMARY KEY, brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL, name TEXT NOT NULL,
        category TEXT, unit_price NUMERIC DEFAULT 0, onboarded_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY, machine_slot_id INTEGER REFERENCES machine_slots(id) ON DELETE CASCADE,
        sku_id INTEGER REFERENCES skus(id) ON DELETE SET NULL, change_type TEXT NOT NULL,
        quantity INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS site_notes (
        id SERIAL PRIMARY KEY, host_site_id INTEGER NOT NULL REFERENCES host_sites(id) ON DELETE CASCADE,
        note TEXT NOT NULL, created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT, email TEXT,
        enquiry_type TEXT DEFAULT 'other', service_option TEXT, message TEXT, city TEXT,
        stage TEXT DEFAULT 'new', assigned_to TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS import_batches (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        cloudinary_url TEXT,
        uploaded_by TEXT,
        sheet_type TEXT NOT NULL,
        total_rows INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'processing',
        error_report JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      ALTER TABLE machines
        ADD COLUMN IF NOT EXISTS city TEXT,
        ADD COLUMN IF NOT EXISTS sector TEXT,
        ADD COLUMN IF NOT EXISTS install_date DATE,
        ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS host_site_id INTEGER REFERENCES host_sites(id),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await db.query("ALTER TABLE machine_slots ADD COLUMN IF NOT EXISTS sku_id INTEGER REFERENCES skus(id)");
    await db.query("ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sku_id INTEGER REFERENCES skus(id)");
  } catch (err) {
    console.log("OPERATIONS TABLES ERROR:", err.message);
  }
}

async function loadBotSettingsFromDb() {
  try {
    await ensurePaytmSettingTable();
    await ensureSupportColumns();
    const result = await db.query(
      "SELECT key, value FROM app_settings WHERE key IN ('paytm_verification_enabled', 'auto_close_inactive_tickets', 'auto_close_minutes', 'premium_message_mode', 'admin_logo')"
    );

    for (const row of result.rows) {
      if (row.key === "admin_logo") {
        global.botSettings.admin_logo = row.value;
      } else if (row.key === "auto_close_minutes") {
        const minutes = Number(row.value);
        if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
          global.botSettings.auto_close_minutes = minutes;
        }
      } else {
        global.botSettings[row.key] = row.value === "true";
      }
    }
  } catch (err) {
    console.log("LOAD BOT SETTINGS ERROR:", err.message);
  }
}

async function loadPaytmSettingFromDb() {
  try {
    await ensurePaytmSettingTable();
    const result = await db.query(
      "SELECT value FROM app_settings WHERE key = 'paytm_verification_enabled'"
    );

    if (result.rows.length > 0) {
      global.paytmVerificationEnabled = result.rows[0].value === "true";
    } else {
      await db.query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO NOTHING",
        ["paytm_verification_enabled", String(Boolean(global.paytmVerificationEnabled))]
      );
    }
  } catch (err) {
    console.log("LOAD PAYTM SETTING ERROR:", err.message);
  }
}

async function savePaytmSettingToDb(enabled) {
  try {
    await ensurePaytmSettingTable();
    global.botSettings.paytm_verification_enabled = Boolean(enabled);

    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('paytm_verification_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(global.botSettings.paytm_verification_enabled)]
    );
  } catch (err) {
    console.log("SAVE PAYTM SETTING ERROR:", err.message);
  }
}

async function saveBotSetting(key, value) {
  try {
    await ensurePaytmSettingTable();
    global.botSettings[key] = key === "auto_close_minutes"
      ? Number(value)
      : key === "admin_logo" ? String(value || "") : Boolean(value);

    await db.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(global.botSettings[key])]
    );
  } catch (err) {
    console.log("SAVE BOT SETTING ERROR:", err.message);
  }
}

function premiumMessage(text) {
  return String(text || "")
    .replace(/[❌✅💳💸🔒📸⚠️📍🔄⏳📦📷🚫💰]/gu, "")   // 👈 added u flag
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendPremiumWhatsApp(phone, message) {
  const finalText = global.botSettings?.premium_message_mode === false ? String(message || "") : premiumMessage(message);
  return sendWhatsApp(phone, finalText);
}

/* ================= AUTH CONFIG ================= */
const SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || "mysecrettoken123";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

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

    await db.query(
      "UPDATE tickets SET updated_at = NOW(), last_customer_message_at = NOW() WHERE phone = $1",
      [phone]
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
  const currentResult = await db.query("SELECT phone, state, refund_stage FROM tickets WHERE id=$1", [id]);
  const current = currentResult.rows[0];
  const nextFields = { ...fields };

  if (nextFields.location && !nextFields.machine_id) {
    const location = String(nextFields.location).trim().replace(/\s+/g, " ");
    const machine = await db.query(
      `INSERT INTO machines (name, location) VALUES ($1, $2)
       ON CONFLICT (location) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [location.slice(0, 200), location]
    );
    nextFields.machine_id = machine.rows[0]?.id || null;
    nextFields.location = location;
  }

  const nextStage = getRefundStage(nextFields.refund_stage || nextFields.status, nextFields.state || current?.state, current?.refund_stage);
  if (nextStage && nextStage !== current?.refund_stage) nextFields.refund_stage = nextStage;
  if (["resolved", "refunded", "auto_refunded"].includes(String(nextFields.status || "").toLowerCase())) {
    nextFields.resolved_at = new Date();
  }

  const keys = Object.keys(nextFields);
  const values = Object.values(nextFields);

  keys.push("updated_at");
  values.push(new Date());

  const setQuery = keys.map((key, i) => `${key}=$${i + 1}`).join(", ");

  await db.query(
    `UPDATE tickets SET ${setQuery} WHERE id=$${keys.length + 1}`,
    [...values, id]
  );

  await refreshCustomerRisk(id, current?.phone);

  if (current?.phone && nextFields.refund_stage && nextFields.refund_stage !== current.refund_stage && nextFields.refund_stage !== "PROCESSED") {
    const stageMessages = {
      RAISED: "Your Snackit support request has been raised.",
      VERIFYING: "Your Snackit request is being verified.",
      UNDER_REVIEW: "Your Snackit request is under review by our team.",
      PROCESSED: "Your Snackit request has been processed.",
    };
    await sendWhatsApp(current.phone, stageMessages[nextFields.refund_stage]);
  }
}

function getRefundStage(value, state, currentStage = "RAISED") {
  const normalized = String(value || "").toLowerCase();
  if (["refunded", "auto_refunded", "resolved", "closed"].includes(normalized)) return "PROCESSED";
  if (state === "DONE" || normalized === "processing") return "UNDER_REVIEW";
  if (["STEP1", "STEP2", "STEP2_RETRY", "STEP3", "EXP_IMG", "EXP_UPI", "EXP_UPI_IMG", "PRICE_IMG", "PRICE_UPI", "PRICE_UPI_IMG", "DAM_IMG", "DAM_UPI", "DAM_UPI_IMG"].includes(state)) return "VERIFYING";
  return currentStage || "RAISED";
}

async function refreshCustomerRisk(ticketId, phone) {
  try {
    if (!phone) return;
    const result = await db.query(
      `SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS weekly_count,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS monthly_count
       FROM tickets WHERE phone=$1`,
      [phone]
    );
    const row = result.rows[0];
    const riskScore = Math.min(100, Number(row.weekly_count) * 15 + Number(row.monthly_count) * 2);
    await db.query(
      `INSERT INTO customer_risk (phone, risk_score, ticket_count, last_ticket_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET risk_score=EXCLUDED.risk_score,
         ticket_count=EXCLUDED.ticket_count, last_ticket_at=EXCLUDED.last_ticket_at, updated_at=NOW()`,
      [phone, riskScore, row.count]
    );
    await db.query("UPDATE tickets SET risk_score=$1 WHERE id=$2", [riskScore, ticketId]);
  } catch (err) {
    console.log("CUSTOMER RISK ERROR:", err.message);
  }
}

/* ================= VALIDATION FUNCTIONS ================= */

function validateUPIId(upiId) {
  if (!upiId || upiId.length < 5) return false;
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/;
  return upiRegex.test(upiId);
}

function isAlphabetOnly(text) {
  return /^[a-zA-Z\s]+$/.test(text);
}

function isValidTransactionId(text) {
  return /^[a-zA-Z0-9]{5,}$/.test(text);
}

function isValidImage(mediaType) {
  return mediaType === "image" || (mediaType && mediaType.startsWith("image/"));
}

function isVideo(mediaType) {
  return mediaType === "video" || (mediaType && mediaType.startsWith("video/"));
}

function getRetryKey(ticketId, step) {
  return `${ticketId}-${step}`;
}

function incrementRetry(key) {
  if (!global.retryCount[key]) global.retryCount[key] = 0;
  global.retryCount[key]++;
  return global.retryCount[key];
}

function resetRetry(key) {
  delete global.retryCount[key];
}

function getRetryCount(key) {
  return global.retryCount[key] || 0;
}

async function isDuplicateTransaction(transactionId, ticketId) {
  const result = await db.query(
    `SELECT id FROM tickets
     WHERE id <> $1
       AND (upi_id = $2 OR paytm_transaction_id = $2)
       AND LOWER(COALESCE(status, '')) NOT IN ('closed', 'auto_closed')
     LIMIT 1`,
    [ticketId, transactionId]
  );
  return result.rows.length > 0;
}

const FINAL_MSG = "✅ Ticket has been raised, we will process your concern soon.";
const MAX_RETRIES = 3;
const AUTO_CLOSE_TICKET_MINUTES = 5; // Auto-close after 5 minutes of inactivity

function isPaytmVerificationEnabled() {
  return (
    Boolean(global.botSettings?.paytm_verification_enabled) &&
    Boolean(process.env.PAYTM_MERCHANT_ID) &&
    Boolean(process.env.PAYTM_MERCHANT_KEY)
  );
}

async function closeInactiveTicket(ticket) {
  try {
    if (!ticket || !ticket.phone) return;

    let phone = ticket.phone;
    if (phone && !phone.startsWith("91")) {
      phone = "91" + phone;
    }

    const closeMessage =
      "🔒 *Ticket Closed*\n\nNo response was received from your side, so this ticket has been automatically closed.\n\nFor new issues, Type 1.";

    await sendPremiumWhatsApp(phone, closeMessage);

    await db.query(
      "UPDATE tickets SET status='auto_closed', state='CLOSED', updated_at=NOW() WHERE id=$1",
      [ticket.id]
    );

    console.log(`Auto-closed inactive ticket ${ticket.id} for ${phone}`);
  } catch (err) {
    console.log("AUTO CLOSE ERROR:", err.message);
  }
}

async function autoCloseInactiveTickets() {
  try {
    if (global.botSettings?.auto_close_inactive_tickets === false) return;

    const closeMinutes = Math.max(1, Math.min(1440, Number(global.botSettings?.auto_close_minutes) || 5));
    const result = await db.query(
      `
        SELECT *
        FROM tickets
        WHERE LOWER(COALESCE(status, '')) NOT IN ('closed', 'resolved', 'refunded', 'auto_refunded')
          AND state != 'CLOSED'
          AND COALESCE(last_customer_message_at, updated_at) < NOW() - ($1 * INTERVAL '1 minute')
      `,
      [closeMinutes]
    );

    for (const ticket of result.rows) {
      await closeInactiveTicket(ticket);
    }
  } catch (err) {
    console.log("AUTO CLOSE CHECK ERROR:", err.message);
  }
}

/* ================= PAYTM PAYMENT VERIFICATION ================= */
async function verifyAndProcessPayment(ticketId, upiId, from) {
  try {
    console.log("🔍 Verifying payment on Paytm for Order ID:", upiId);

    // Call Paytm API
    const paytmResult = await verifyPaymentOnPaytm(upiId);

    console.log("✅ Paytm Response:", paytmResult);

    // Store verification in DB
    await storePaytmVerification(ticketId, paytmResult);

    return paytmResult;
  } catch (err) {
    console.error("❌ Payment verification error:", err.message);
    return {
      status: "ERROR",
      verified: false,
      message: "Could not verify payment",
    };
  }
}

/* ================= BOT MESSAGE PROCESSOR - PAYTM INTEGRATED ================= */
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

    if (global.feedbackTargetTicket[from] && !["FEEDBACK", "RATING", "COMMENT"].includes(existingTicket.state)) {
      await updateTicket(ticketId, { category: "FEEDBACK", state: "RATING", main_issue: "Feedback" });
    }

    // ADMIN TAKEOVER CHECK
    if (existingTicket.takeover === true || existingTicket.takeover === "true") {
      console.log("Admin handling this chat");
      return;
    }

    let state = existingTicket.state || "START";
    let category = existingTicket.category || null;
    let subIssue = existingTicket.sub_issue || null;

    if (global.feedbackTargetTicket[from]) {
      category = "FEEDBACK";
      state = "RATING";
    }

    state = typeof state === "string" ? state.trim().toUpperCase() : "START";
    category = typeof category === "string" ? category.trim().toUpperCase() : null;
    subIssue = typeof subIssue === "string" ? subIssue.trim() : null;

    console.log("STATE:", state);
    console.log("CATEGORY:", category);
    console.log("SUB ISSUE:", subIssue);

    if (message === "agent" || message === "human" || message === "support") {
      await updateTicket(ticketId, { takeover: true, priority: "high", status: "OPEN", state: state === "CLOSED" ? "MENU" : state });
      return sendWhatsApp(from, "A support specialist will continue this conversation shortly. Please keep this chat open.");
    }

    if (message === "menu" || message === "back") {
      await updateTicket(ticketId, { category: "MENU", state: "MENU", status: "OPEN", takeover: false });
      return sendWhatsApp(from, "Main menu\n\n1. Refund support\n2. Product enquiry\n3. Share feedback\n\nReply with 1, 2, or 3.");
    }

    if (message === "restart" || message === "reset") {
      await updateTicket(ticketId, {
        category: null,
        main_issue: null,
        sub_issue: null,
        state: "START",
        status: "OPEN",
        takeover: false,
      });
      return sendWhatsApp(from, "Let us start again. Please reply with 1 for refund support, 2 for product enquiry, or 3 to share feedback.");
    }

    // Already closed or done states
    if (state === "DONE") {
      return sendWhatsApp(
        from,
        "✅ Your ticket is already raised. Our team will assist you shortly."
      );
    }

    if (state === "CLOSED") {
      if (message === "1") {
        await updateTicket(ticketId, {
          category: "MENU",
          state: "MENU",
          status: "OPEN",
          takeover: false,
          reopened_at: new Date(),
        });
        return sendWhatsApp(from, "Your request has been reopened.\n\n1. Refund support\n2. Product enquiry\n3. Share feedback\n\nReply with 1, 2, or 3.");
      }

      return sendWhatsApp(
        from,
        "Your previous ticket is closed. Reply with 1 to start a new request, or type menu to see the available options."
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

💳 *ENTER TRANSACTION ID*

Share your Transaction ID (from payment app or Paytm).

Example: "1234567890566654" or "UTR123456789ABC"`
          );
        }

        if (state === "STEP2") {
          const retryKey = getRetryKey(ticketId, "STEP2_UPI");

          const transactionId = text.trim();

          if (!transactionId) {
            return sendWhatsApp(
              from,
              `❌ Please enter a valid transaction ID.`
            );
          }

          if (await isDuplicateTransaction(transactionId, ticketId)) {
            return sendWhatsApp(from, "This transaction has already been linked to another request. Please check the transaction ID or contact support.");
          }

          if (!isPaytmVerificationEnabled()) {
            resetRetry(retryKey);
            await updateTicket(ticketId, {
              upi_id: transactionId,
              transaction_verified: false,
              state: "STEP3",
            });

            return sendWhatsApp(
              from,
              `✅ *Transaction ID received!*

📸 *SEND UPI TRANSACTION SCREENSHOT*

Please send a screenshot of the transaction from your payment app.

⚠️ Make sure:
✓ Screenshot shows date & time
✓ Transaction amount is visible
✓ Status is clear`
            );
          }

          // Check if it's alphabetic only
          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            const retries = getRetryCount(retryKey);

            return sendWhatsApp(
              from,
              `❌ Transaction ID contains only letters. This is invalid.

Attempt ${retries}/${MAX_RETRIES}

Transaction ID should have numbers. Example: "36263772828822"`
            );
          }

          // Validate format
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
              `❌ Invalid Transaction ID.

Attempt ${retries}/${MAX_RETRIES}

Transaction ID should be alphanumeric (numbers & letters only, no spaces).

Example: "UTR123456789ABC" or "1234567890"`
            );
          }

          // ========== 🔥 PAYTM VERIFICATION STARTS HERE ==========
          resetRetry(retryKey);

          if (!isPaytmVerificationEnabled()) {
            await updateTicket(ticketId, {
              upi_id: transactionId,
              transaction_verified: false,
              state: "STEP3",
            });

            return sendWhatsApp(
              from,
              `✅ *Transaction ID received!*

📸 *SEND UPI TRANSACTION SCREENSHOT*

Please send a screenshot of the transaction from your payment app.

⚠️ Make sure:
✓ Screenshot shows date & time
✓ Transaction amount is visible
✓ Status is clear`
            );
          }

          // Send "Verifying..." message
          await sendWhatsApp(
            from,
            `⏳ *VERIFYING PAYMENT*

Please wait while we verify your transaction on Paytm...`
          );

          // Call Paytm verification
          const paytmResult = await verifyAndProcessPayment(
            ticketId,
            transactionId,
            from
          );

          console.log("🔍 Paytm Result:", paytmResult);

          // ========== HANDLE PAYTM RESPONSES ==========
          if (paytmResult.status === "TXN_SUCCESS" || paytmResult.verified) {
            // ✅ PAYMENT SUCCESSFUL - AUTO-ADVANCE
            await updateTicket(ticketId, {
              upi_id: transactionId,
              transaction_verified: true,
              state: "STEP3",
            });

            return sendWhatsApp(
              from,
              `✅ *PAYMENT VERIFIED!*

Transaction Status: *SUCCESS*
Transaction ID: ${paytmResult.txnId || transactionId}
Amount: ₹${paytmResult.amount || "N/A"}

📸 *SEND UPI TRANSACTION SCREENSHOT*

Please send a screenshot of the transaction from your payment app.

⚠️ Make sure:
✓ Screenshot shows date & time
✓ Transaction amount is visible
✓ Status is clear`
            );
          } else if (
            paytmResult.status === "TXN_FAILURE" ||
            paytmResult.status === "FAILED"
          ) {
            // ❌ PAYMENT FAILED
            await updateTicket(ticketId, {
              upi_id: transactionId,
              transaction_verified: false,
              paytm_status: "FAILED",
              state: "STEP2_RETRY",
            });

            return sendWhatsApp(
              from,
              `❌ *PAYMENT VERIFICATION FAILED*

Transaction Status: *FAILED*
Error: ${paytmResult.message || "Payment was not successful"}

🔄 *RETRY PAYMENT*

Please check your payment and try with a different transaction ID, or:
1. Retry with another transaction ID
2. Type *1* to restart the process
3. Contact support for assistance

What would you like to do?`
            );
          } else if (paytmResult.status === "PENDING") {
            // ⏳ PAYMENT PENDING
            return sendWhatsApp(
              from,
              `⏳ *PAYMENT PENDING*

Transaction Status: *PENDING*

Your payment is still being processed. This usually takes 1-2 minutes.

🔄 *PLEASE WAIT*

Please try again in a moment. If it still shows pending:
1. Check your bank/payment app for confirmation
2. If money was deducted, share the screenshot
3. If not, type *1* to restart

Type "retry" to verify again.`
            );
          } else if (paytmResult.status === "TXN_INITIATED") {
            // 🔄 PROCESSING
            return sendWhatsApp(
              from,
              `🔄 *PAYMENT PROCESSING*

Transaction Status: *PROCESSING*

Your payment is being processed. Please wait a moment.

Type "retry" to check status again, or share a screenshot if payment was completed.`
            );
          } else if (paytmResult.status === "ERROR" || !paytmResult.verified) {
            // ⚠️ API ERROR OR UNKNOWN
            return sendWhatsApp(
              from,
              `⚠️ *VERIFICATION ERROR*

We couldn't verify your payment at this moment:
${paytmResult.message || "Unknown error"}

📸 *PLEASE SEND SCREENSHOT INSTEAD*

For now, please send a screenshot of your transaction receipt from your payment app. Our team will verify it manually.

⚠️ Make sure:
✓ Screenshot shows transaction details clearly
✓ Transaction ID is visible
✓ Status and amount are clear`
            );
          }
        }

        if (state === "STEP2_RETRY") {
          // User retrying after payment failed
          if (message === "retry" || isValidTransactionId(text)) {
            const newTransactionId = isValidTransactionId(text)
              ? text.trim()
              : null;

            if (newTransactionId) {
              // Try verification again
              await sendWhatsApp(from, `⏳ Verifying new transaction...`);

              const paytmResult = await verifyAndProcessPayment(
                ticketId,
                newTransactionId,
                from
              );

              if (paytmResult.verified) {
                await updateTicket(ticketId, {
                  upi_id: newTransactionId,
                  transaction_verified: true,
                  state: "STEP3",
                });

                return sendWhatsApp(
                  from,
                  `✅ *PAYMENT VERIFIED!*\n\n📸 Now send your transaction screenshot.`
                );
              } else {
                return sendWhatsApp(
                  from,
                  `❌ This transaction also failed. \n\nPlease send a screenshot of a successful transaction instead.`
                );
              }
            } else {
              return sendWhatsApp(
                from,
                `❌ Invalid transaction ID. Please try again with correct format.`
              );
            }
          }

          return sendWhatsApp(
            from,
            `Please enter a valid transaction ID or type "1" to restart.`
          );
        }

        if (state === "STEP3") {
          const retryKey = getRetryKey(ticketId, "STEP3_IMAGE");

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

Send your transaction screenshot.`
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

📋 Your refund request has been received and verified.

🕐 Processing time: 1 working day

💳 Payment Status: VERIFIED ✅

Our team will review and process your refund within 24 hours.

Thank you for choosing Snackit! 🙏`
          );
        }
      }

      // PRODUCT ISSUE
      if (subIssue === "Product Issue") {
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

💳 *ENTER TRANSACTION ID*

Share your Transaction ID.`
          );
        }

        if (state === "EXP_UPI") {
          const retryKey = getRetryKey(ticketId, "EXP_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ Transaction ID should contain numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ Invalid Transaction ID format. Try again.`
            );
          }

          resetRetry(retryKey);

          // Verify payment
          const paytmResult = await verifyAndProcessPayment(
            ticketId,
            text.trim(),
            from
          );

          if (paytmResult.verified) {
            await updateTicket(ticketId, {
              upi_id: text.trim(),
              transaction_verified: true,
              state: "EXP_UPI_IMG",
            });

            return sendWhatsApp(
              from,
              `✅ Payment Verified!

📸 *SEND TRANSACTION SCREENSHOT*

Please send your transaction screenshot.`
            );
          } else {
            await updateTicket(ticketId, {
              upi_id: text.trim(),
              transaction_verified: false,
            });

            return sendWhatsApp(
              from,
              `⚠️ Payment verification failed or pending.

📸 Please send your transaction screenshot anyway. Our team will verify manually.`
            );
          }
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

Your request has been received. We'll review within 24 hours.

Thank you! 🙏`
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

💳 *ENTER TRANSACTION ID*`
          );
        }

        if (state === "PRICE_UPI") {
          const retryKey = getRetryKey(ticketId, "PRICE_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ Transaction ID should have numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Invalid Transaction ID format. Try again.`);
          }

          resetRetry(retryKey);

          const paytmResult = await verifyAndProcessPayment(
            ticketId,
            text.trim(),
            from
          );

          if (paytmResult.verified) {
            await updateTicket(ticketId, {
              upi_id: text.trim(),
              transaction_verified: true,
              state: "PRICE_UPI_IMG",
            });

            return sendWhatsApp(
              from,
              `✅ Payment Verified!

📸 *SEND TRANSACTION SCREENSHOT*`
            );
          } else {
            return sendWhatsApp(
              from,
              `⚠️ Payment verification pending.

📸 Please send your screenshot. We'll verify manually.`
            );
          }
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

We've received your complaint. Expected resolution: 24 hours.

Thank you! 🙏`
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

💳 *ENTER TRANSACTION ID*`
          );
        }

        if (state === "DAM_UPI") {
          const retryKey = getRetryKey(ticketId, "DAM_UPI");

          if (isAlphabetOnly(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(
              from,
              `❌ Transaction ID should have numbers. Please re-enter.`
            );
          }

          if (!isValidTransactionId(text)) {
            incrementRetry(retryKey);
            return sendWhatsApp(from, `❌ Invalid Transaction ID format. Try again.`);
          }

          resetRetry(retryKey);

          const paytmResult = await verifyAndProcessPayment(
            ticketId,
            text.trim(),
            from
          );

          if (paytmResult.verified) {
            await updateTicket(ticketId, {
              upi_id: text.trim(),
              transaction_verified: true,
              state: "DAM_UPI_IMG",
            });

            return sendWhatsApp(
              from,
              `✅ Payment Verified!

📸 *SEND TRANSACTION SCREENSHOT*`
            );
          } else {
            return sendWhatsApp(
              from,
              `⚠️ Payment verification pending.

📸 Please send your screenshot.`
            );
          }
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

We regret the inconvenience. Our team will process this within 24 hours.

Thank you for your patience! 🙏`
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

Our team will reach out shortly. 🚀`
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
          "INSERT INTO feedback (phone, ticket_id, rating, comment) VALUES ($1, $2, $3, $4)",
          [from, global.feedbackTargetTicket[from] || ticketId, rating, text || ""]
        );

        if (global.feedbackActive) {
          delete global.feedbackActive[from];
        }
        delete global.feedbackTargetTicket[from];

        await updateTicket(ticketId, {
          state: "CLOSED",
          status: "closed",
        });

        return sendWhatsApp(
          from,
          `✅ *THANK YOU FOR YOUR FEEDBACK!*

Your feedback helps us improve. We appreciate it! 🙏

Keep using Snackit! 🎉`
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

    if (token === SECRET_TOKEN) {
      req.user = { role: "admin", username: ADMIN_USER };
      return next();
    }

    const employee = global.internalSessions.get(token);
    if (!employee) return res.status(401).json({ error: "Invalid token" });

    const operationsPath = req.path.startsWith("/operations/") || req.path.startsWith("/machines") || req.path.startsWith("/inventory/") || req.path.startsWith("/host-sites") || req.path.startsWith("/brands") || req.path.startsWith("/skus/") || req.path.startsWith("/analytics/");
    if (!req.path.startsWith("/internal/") && !(operationsPath && employee.department === "Operations")) {
      return res.status(403).json({ error: "Internal chat access only" });
    }

    req.user = { ...employee, role: "employee" };
    return next();
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
      return res.json({ token: SECRET_TOKEN, role: "admin", username: ADMIN_USER });
    }

    const employee = global.internalUsers.find((user) => user.username === String(username).trim());
    if (employee && employee.password === password) {
      const token = `employee-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      global.internalSessions.set(token, { userId: employee.id, username: employee.username, name: employee.name, department: employee.department });
      return res.json({ token, role: "employee", userId: employee.id, username: employee.username, name: employee.name, department: employee.department });
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
        transaction_verified,
        paytm_status,
        status,
        state,
        refund_stage,
        machine_id,
        risk_score,
        takeover,
        priority,
        assigned_to,
        admin_notes,
        reopened_at,
        created_at,
        updated_at
      FROM tickets
      WHERE category = 'REFUND'
      ORDER BY id DESC
    `);

    const rows = result.rows.map((t) => ({
      ...t,
      risk_flag: Number(t.risk_score || 0) >= 50 ? "high" : Number(t.risk_score || 0) >= 25 ? "medium" : "low",
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
      SELECT id, ticket_id, phone, rating, comment, created_at
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

    const { ticketId, action } = req.body;

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
          "✅ *Refund Processed!*\n\nYour amount has been processed. Check your bank account in 5-10 minutes.\n\nThank you for your patience! 🙏";
        status = "refunded";
        break;

      case "AUTO_REFUNDED":
        message =
          "ℹ️ *Auto-Refund Detected*\n\nYour amount was already credited to your account. Please check your bank statement.\n\nThank you for your patience! 🙏";
        status = "auto_refunded";
        break;

      case "RESOLVED":
        message =
          "✅ *Issue Resolved!*\n\nYour concern has been resolved. Thank you for contacting Snackit!\n\nThank you for your patience! 🙏";
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
      if (["REFUNDED", "RESOLVED"].includes(action)) {
        global.feedbackTargetTicket[phone] = ticketId;
        await sendWhatsApp(phone, "Please rate your support experience from 1 to 5 by replying with a number.");
      }
      console.log("✅ WhatsApp sent");
    } else {
      console.log("❌ No phone found");
    }

    await updateTicket(ticketId, { status, state: "CLOSED", refund_stage: "PROCESSED" });

    console.log("✅ DONE");

    res.json({ success: true });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/settings", auth, async (req, res) => {
  try {
    await ensurePaytmSettingTable();
    const result = await db.query(
      "SELECT key, value FROM app_settings WHERE key IN ('paytm_verification_enabled', 'auto_close_inactive_tickets', 'auto_close_minutes', 'premium_message_mode', 'admin_logo')"
    );

    const settings = {
      paytm_verification_enabled: false,
      auto_close_inactive_tickets: true,
      auto_close_minutes: 5,
      premium_message_mode: true,
      admin_logo: "",
    };

    for (const row of result.rows) {
      settings[row.key] = row.key === "auto_close_minutes"
        ? Number(row.value) || 5
        : row.key === "admin_logo" ? row.value : row.value === "true";
    }

    global.botSettings = { ...global.botSettings, ...settings };
    res.json(settings);
  } catch (err) {
    console.log("GET SETTINGS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/settings", auth, async (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { paytm_verification_enabled, auto_close_inactive_tickets, auto_close_minutes, premium_message_mode, admin_logo } = req.body || {};

    if (typeof paytm_verification_enabled !== "undefined") {
      await savePaytmSettingToDb(paytm_verification_enabled);
    }

    if (typeof auto_close_inactive_tickets !== "undefined") {
      await saveBotSetting("auto_close_inactive_tickets", auto_close_inactive_tickets);
    }

    if (typeof auto_close_minutes !== "undefined") {
      const minutes = Number(auto_close_minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        return res.status(400).json({ error: "Auto-close time must be between 1 and 1440 minutes" });
      }
      await saveBotSetting("auto_close_minutes", Math.round(minutes));
    }

    if (typeof premium_message_mode !== "undefined") {
      await saveBotSetting("premium_message_mode", premium_message_mode);
    }

    if (typeof admin_logo !== "undefined") {
      const logo = String(admin_logo || "");
      if (logo && (!logo.startsWith("data:image/") || logo.length > 3_000_000)) {
        return res.status(400).json({ error: "Logo must be a valid image smaller than 2 MB" });
      }
      await ensurePaytmSettingTable();
      await db.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        ["admin_logo", logo]
      );
      global.botSettings.admin_logo = logo;
    }

    const settings = {
      paytm_verification_enabled: Boolean(global.botSettings?.paytm_verification_enabled),
      auto_close_inactive_tickets: Boolean(global.botSettings?.auto_close_inactive_tickets),
      auto_close_minutes: Number(global.botSettings?.auto_close_minutes) || 5,
      premium_message_mode: Boolean(global.botSettings?.premium_message_mode),
      admin_logo: String(global.botSettings?.admin_logo || ""),
    };

    res.json(settings);
  } catch (err) {
    console.log("UPDATE SETTINGS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/admin/paytm-setting", auth, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT value FROM app_settings WHERE key = 'paytm_verification_enabled'"
    );

    const enabled = result.rows[0]?.value === "true";
    global.botSettings.paytm_verification_enabled = enabled;

    res.json({ enabled });
  } catch (err) {
    console.log("PAYTM SETTING GET ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/paytm-setting", auth, async (req, res) => {
  try {
    const { enabled } = req.body;
    await savePaytmSettingToDb(enabled);
    res.json({ enabled: Boolean(global.botSettings?.paytm_verification_enabled) });
  } catch (err) {
    console.log("PAYTM SETTING UPDATE ERROR:", err.message);
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
    const { phone, ticketId } = req.body || {};

    if (!phone && !ticketId) return res.status(400).json({ error: "Phone or ticket ID is required" });

    if (ticketId) {
      await updateTicket(ticketId, { takeover: true, status: "OPEN" });
    } else {
      await updateTicketByPhone(phone, { takeover: true, status: "OPEN" });
    }

    const result = ticketId
      ? await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId])
      : await db.query("SELECT * FROM tickets WHERE phone=$1 ORDER BY updated_at DESC LIMIT 1", [phone]);
    res.json({ success: true, ticket: result.rows[0] || null });
  } catch (err) {
    console.log("TAKEOVER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/release", auth, async (req, res) => {
  try {
    const { phone, ticketId } = req.body || {};

    if (!phone && !ticketId) return res.status(400).json({ error: "Phone or ticket ID is required" });

    if (ticketId) {
      await updateTicket(ticketId, { takeover: false });
    } else {
      await updateTicketByPhone(phone, { takeover: false });
    }

    const result = ticketId
      ? await db.query("SELECT * FROM tickets WHERE id=$1", [ticketId])
      : await db.query("SELECT * FROM tickets WHERE phone=$1 ORDER BY updated_at DESC LIMIT 1", [phone]);
    res.json({ success: true, ticket: result.rows[0] || null });
  } catch (err) {
    console.log("RELEASE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/admin/tickets/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { priority, assigned_to, admin_notes } = req.body || {};
    const fields = {};

    if (typeof priority !== "undefined") {
      if (!["low", "normal", "high", "urgent"].includes(priority)) {
        return res.status(400).json({ error: "Invalid priority" });
      }
      fields.priority = priority;
    }
    if (typeof assigned_to !== "undefined") fields.assigned_to = String(assigned_to || "").trim() || null;
    if (typeof admin_notes !== "undefined") fields.admin_notes = String(admin_notes || "").trim();

    const keys = Object.keys(fields);
    if (!keys.length) return res.status(400).json({ error: "No fields to update" });

    const values = keys.map((key) => fields[key]);
    const setQuery = keys.map((key, index) => `${key}=$${index + 1}`).join(", ");
    const result = await db.query(
      `UPDATE tickets SET ${setQuery}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
      [...values, id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Ticket not found" });
    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.log("TICKET UPDATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/tickets/:id/reopen", auth, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE tickets
       SET status='OPEN', state='MENU', takeover=false, reopened_at=NOW(), updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [req.params.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Ticket not found" });

    let phone = result.rows[0].phone;
    if (phone && !phone.startsWith("91")) phone = "91" + phone;
    if (phone) {
      await sendWhatsApp(phone, "Your support request has been reopened. Please reply with the information requested to continue.");
    }

    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.log("REOPEN ERROR:", err.message);
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

function operationFilters(req, prefix = "") {
  const values = [];
  const clauses = [];
  ["city", "sector", "status"].forEach((key) => {
    if (req.query[key]) {
      values.push(String(req.query[key]));
      clauses.push(`${prefix}${key} = $${values.length}`);
    }
  });
  return { values, where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "" };
}

async function emitOperationsEvent(event, payload) {
  try {
    io.emit(event, payload);
  } catch (err) {
    console.log("OPERATIONS SOCKET ERROR:", err.message);
  }
}

async function recalculateInventoryAlerts() {
  try {
    const result = await db.query(`
      SELECT ms.id, ms.machine_id, ms.slot_number, ms.current_stock,
             COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - INTERVAL '7 days'), 0)::numeric / 7 AS daily_sales,
             CASE WHEN COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - INTERVAL '7 days'), 0) > 0
               THEN ms.current_stock / (COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - INTERVAL '7 days'), 0)::numeric / 7)
               ELSE NULL END AS stockout_days
      FROM machine_slots ms LEFT JOIN stock_movements sm ON sm.machine_slot_id = ms.id
      GROUP BY ms.id
      HAVING ms.current_stock <= ms.low_stock_threshold
         OR (COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - INTERVAL '7 days'), 0) > 0
             AND ms.current_stock / (COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - INTERVAL '7 days'), 0)::numeric / 7) <= 2)
      ORDER BY stockout_days NULLS LAST, ms.current_stock ASC
      LIMIT 25
    `);
    if (result.rows.length) await emitOperationsEvent("low-stock-alert", { slots: result.rows, generated_at: new Date().toISOString() });
  } catch (err) {
    console.log("INVENTORY ALERT ERROR:", err.message);
  }
}

async function emitRenewalWarnings() {
  try {
    const result = await db.query("SELECT id, company_name, contract_end, (contract_end - CURRENT_DATE)::int AS days_to_renewal FROM host_sites WHERE contract_end IS NOT NULL AND contract_end BETWEEN CURRENT_DATE AND CURRENT_DATE + 60");
    if (result.rows.length) await emitOperationsEvent("renewal-due", { sites: result.rows, generated_at: new Date().toISOString() });
  } catch (err) {
    console.log("RENEWAL WARNING ERROR:", err.message);
  }
}

app.get("/machines", auth, async (req, res) => {
  try {
    const { values, where } = operationFilters(req, "m.");
    const result = await db.query(
      `SELECT m.*, hs.company_name AS host_site_name,
              COUNT(ms.id)::int AS slot_count,
              COUNT(ms.id) FILTER (WHERE ms.current_stock <= ms.low_stock_threshold)::int AS low_stock_slots
       FROM machines m LEFT JOIN host_sites hs ON hs.id = m.host_site_id
       LEFT JOIN machine_slots ms ON ms.machine_id = m.id
       ${where} GROUP BY m.id, hs.company_name ORDER BY m.name`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.log("MACHINES ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/machines/:id/slots", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const result = await db.query(
      `SELECT ms.*, s.name AS sku_name, s.category, s.unit_price,
              COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day')), 0)::int AS sales_in_window,
              COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type = 'sale' AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day')), 0)::numeric / $1 AS daily_sales
       FROM machine_slots ms LEFT JOIN skus s ON s.id = ms.sku_id
       LEFT JOIN stock_movements sm ON sm.machine_slot_id = ms.id
       WHERE ms.machine_id=$2 GROUP BY ms.id, s.name, s.category, s.unit_price ORDER BY ms.slot_number`,
      [days, req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.log("MACHINE SLOTS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/machines/:id/slots/:slotId/restock", auth, async (req, res) => {
  try {
    const quantity = Math.round(Number(req.body?.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: "Quantity must be positive" });
    const result = await db.query(
      `UPDATE machine_slots SET current_stock = current_stock + $1, updated_at=NOW()
       WHERE id=$2 AND machine_id=$3 RETURNING *`,
      [quantity, req.params.slotId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Slot not found" });
    await db.query("INSERT INTO stock_movements (machine_slot_id, sku_id, change_type, quantity) VALUES ($1, $2, 'restock', $3)", [result.rows[0].id, result.rows[0].sku_id, quantity]);
    await emitOperationsEvent("inventory-updated", { machine_id: req.params.id, slot: result.rows[0] });
    res.json({ success: true, slot: result.rows[0] });
  } catch (err) {
    console.log("RESTOCK ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/machines/:id/slots/:slotId/sale", auth, async (req, res) => {
  try {
    const quantity = Math.round(Number(req.body?.quantity || 1));
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: "Quantity must be positive" });
    const result = await db.query(
      `UPDATE machine_slots SET current_stock = GREATEST(0, current_stock - $1), updated_at=NOW()
       WHERE id=$2 AND machine_id=$3 AND current_stock >= $1 RETURNING *`,
      [quantity, req.params.slotId, req.params.id]
    );
    if (!result.rows.length) return res.status(409).json({ error: "Slot not found or insufficient stock" });
    await db.query("INSERT INTO stock_movements (machine_slot_id, sku_id, change_type, quantity) VALUES ($1, $2, 'sale', $3)", [result.rows[0].id, result.rows[0].sku_id, quantity]);
    await emitOperationsEvent("inventory-updated", { machine_id: req.params.id, slot: result.rows[0], change_type: "sale" });
    res.json({ success: true, slot: result.rows[0] });
  } catch (err) {
    console.log("SALE MOVEMENT ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/inventory/low-stock", auth, async (req, res) => {
  try {
    const { values, where } = operationFilters(req, "m.");
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const result = await db.query(
      `WITH slot_velocity AS (
        SELECT ms.id AS slot_id, ms.slot_number, ms.current_stock, ms.low_stock_threshold,
              m.id AS machine_id, m.name AS machine_name, m.location, m.city, m.sector,
              s.name AS sku_name, COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($${values.length + 1} * INTERVAL '1 day')), 0)::numeric / $${values.length + 1} AS daily_sales,
              CASE WHEN COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($${values.length + 1} * INTERVAL '1 day')), 0) > 0 THEN ms.current_stock / (COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($${values.length + 1} * INTERVAL '1 day')), 0)::numeric / $${values.length + 1}) ELSE NULL END AS stockout_days
       FROM machine_slots ms JOIN machines m ON m.id=ms.machine_id LEFT JOIN skus s ON s.id=ms.sku_id
       LEFT JOIN stock_movements sm ON sm.machine_slot_id=ms.id
       ${where} GROUP BY ms.id, m.id, s.name
      ) SELECT * FROM slot_velocity
        WHERE current_stock <= low_stock_threshold OR (daily_sales > 0 AND stockout_days <= 2)
        ORDER BY stockout_days NULLS FIRST, current_stock ASC`,
      [...values, days]
    );
    res.json(result.rows);
  } catch (err) {
    console.log("LOW STOCK ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/inventory/velocity", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const result = await db.query(
      `SELECT m.id AS machine_id, m.name AS machine_name, m.city, m.sector, s.id AS sku_id, s.name AS sku_name,
              COALESCE(SUM(sm.quantity), 0)::int AS units_sold, ROUND((COALESCE(SUM(sm.quantity), 0)::numeric / $1), 2) AS average_daily_sales,
              CASE WHEN COALESCE(SUM(sm.quantity), 0) > 0 THEN ROUND((MAX(ms.current_stock)::numeric / (SUM(sm.quantity)::numeric / $1))::numeric, 2) ELSE NULL END AS predicted_stockout_days
       FROM stock_movements sm JOIN machine_slots ms ON ms.id=sm.machine_slot_id JOIN machines m ON m.id=ms.machine_id LEFT JOIN skus s ON s.id=COALESCE(sm.sku_id, ms.sku_id)
       WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day')
       GROUP BY m.id, m.name, m.city, m.sector, s.id, s.name ORDER BY units_sold DESC`,
      [days]
    );
    res.json({ window_days: days, rows: result.rows });
  } catch (err) {
    console.log("INVENTORY VELOCITY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/host-sites/renewals-due", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 60));
    const result = await db.query("SELECT *, (contract_end - CURRENT_DATE)::int AS days_to_renewal, (contract_end <= CURRENT_DATE + $1) AS renewal_risk FROM host_sites WHERE contract_end IS NOT NULL AND contract_end <= CURRENT_DATE + $1 ORDER BY contract_end", [days]);
    res.json(result.rows);
  } catch (err) {
    console.log("RENEWALS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/host-sites", auth, async (req, res) => {
  try {
    const { values, where } = operationFilters(req, "hs.");
    const result = await db.query(`SELECT hs.*, COUNT(m.id)::int AS machine_count, (hs.contract_end IS NOT NULL AND hs.contract_end <= CURRENT_DATE + INTERVAL '60 days') AS renewal_risk FROM host_sites hs LEFT JOIN machines m ON m.host_site_id=hs.id ${where} GROUP BY hs.id ORDER BY hs.contract_end NULLS LAST, hs.company_name`, values);
    res.json(result.rows);
  } catch (err) {
    console.log("HOST SITES ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/host-sites/:id", auth, async (req, res) => {
  try {
    const site = await db.query("SELECT *, (contract_end IS NOT NULL AND contract_end <= CURRENT_DATE + INTERVAL '60 days') AS renewal_risk FROM host_sites WHERE id=$1", [req.params.id]);
    if (!site.rows.length) return res.status(404).json({ error: "Host site not found" });
    const [machines, notes, tickets] = await Promise.all([
      db.query("SELECT m.*, CASE WHEN LOWER(COALESCE(m.status, 'active')) = 'active' THEN 100 ELSE 0 END AS uptime_pct FROM machines m WHERE m.host_site_id=$1 ORDER BY m.name", [req.params.id]),
      db.query("SELECT * FROM site_notes WHERE host_site_id=$1 ORDER BY created_at DESC", [req.params.id]),
      db.query("SELECT COUNT(*)::int AS ticket_count FROM tickets t JOIN machines m ON m.id=t.machine_id WHERE m.host_site_id=$1", [req.params.id]),
    ]);
    res.json({ ...site.rows[0], machines: machines.rows, notes: notes.rows, ticket_count: tickets.rows[0]?.ticket_count || 0 });
  } catch (err) {
    console.log("HOST SITE DETAIL ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/host-sites/:id/notes", auth, async (req, res) => {
  try {
    const note = String(req.body?.note || "").trim();
    if (!note) return res.status(400).json({ error: "Note is required" });
    const result = await db.query("INSERT INTO site_notes (host_site_id, note, created_by) VALUES ($1, $2, $3) RETURNING *", [req.params.id, note, req.user?.name || req.user?.username || "Admin"]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.log("SITE NOTE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/host-sites/:id", auth, async (req, res) => {
  try {
    const allowed = ["company_name", "contact_name", "contact_phone", "contact_email", "address", "city", "sector", "contract_start", "contract_end", "service_charge", "status"];
    const fields = allowed.filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    const values = fields.map((key) => req.body[key]);
    const result = await db.query(`UPDATE host_sites SET ${fields.map((key, index) => `${key}=$${index + 1}`).join(", ")}, updated_at=NOW() WHERE id=$${fields.length + 1} RETURNING *`, [...values, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Host site not found" });
    if (result.rows[0].contract_end && new Date(result.rows[0].contract_end) <= new Date(Date.now() + 60 * 86400000)) await emitOperationsEvent("renewal-due", result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.log("HOST SITE UPDATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/brands", auth, async (req, res) => {
  try {
    const result = await db.query(`SELECT b.*, COUNT(DISTINCT s.id)::int AS sku_count, COALESCE(SUM(sm.quantity) FILTER (WHERE sm.change_type='sale'), 0)::int AS units_sold, COALESCE(SUM(sm.quantity * s.unit_price) FILTER (WHERE sm.change_type='sale'), 0)::numeric AS revenue FROM brands b LEFT JOIN skus s ON s.brand_id=b.id LEFT JOIN stock_movements sm ON sm.sku_id=s.id GROUP BY b.id ORDER BY b.name`);
    res.json(result.rows);
  } catch (err) {
    console.log("BRANDS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/brands", auth, async (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { name, contact_email, contact_phone, status = "active" } = req.body || {};
    if (!String(name || "").trim()) return res.status(400).json({ error: "Brand name is required" });
    const result = await db.query("INSERT INTO brands (name, contact_email, contact_phone, status) VALUES ($1, $2, $3, $4) RETURNING *", [String(name).trim(), contact_email || null, contact_phone || null, status]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.log("BRAND CREATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/skus", auth, async (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { brand_id, name, category, unit_price = 0 } = req.body || {};
    if (!String(name || "").trim()) return res.status(400).json({ error: "SKU name is required" });
    const result = await db.query("INSERT INTO skus (brand_id, name, category, unit_price) VALUES ($1, $2, $3, $4) RETURNING *", [brand_id || null, String(name).trim(), category || null, unit_price]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.log("SKU CREATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/brands/:id/performance", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const result = await db.query(`SELECT s.id, s.name, s.category, s.unit_price, COALESCE(SUM(sm.quantity), 0)::int AS units_sold, COALESCE(SUM(sm.quantity * s.unit_price), 0)::numeric AS revenue, ROUND((COALESCE(SUM(sm.quantity), 0)::numeric / NULLIF(SUM(CASE WHEN sm.change_type IN ('sale','restock') THEN ABS(sm.quantity) ELSE 0 END), 0) * 100)::numeric, 2) AS sell_through_rate FROM skus s LEFT JOIN stock_movements sm ON sm.sku_id=s.id AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day') AND sm.change_type='sale' WHERE s.brand_id=$2 GROUP BY s.id ORDER BY revenue DESC`, [days, req.params.id]);
    res.json({ window_days: days, rows: result.rows });
  } catch (err) {
    console.log("BRAND PERFORMANCE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

async function skuRanking(req, res, direction) {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const values = [days];
    const clauses = ["sm.change_type='sale'", "sm.created_at >= NOW() - ($1 * INTERVAL '1 day')"];
    ["city", "sector"].forEach((key) => { if (req.query[key]) { values.push(req.query[key]); clauses.push(`m.${key}=$${values.length}`); } });
    const result = await db.query(`SELECT s.id, s.name, b.name AS brand_name, COALESCE(SUM(sm.quantity), 0)::int AS units_sold, COALESCE(SUM(sm.quantity * s.unit_price), 0)::numeric AS revenue FROM stock_movements sm JOIN machine_slots ms ON ms.id=sm.machine_slot_id JOIN machines m ON m.id=ms.machine_id JOIN skus s ON s.id=COALESCE(sm.sku_id, ms.sku_id) LEFT JOIN brands b ON b.id=s.brand_id WHERE ${clauses.join(" AND ")} GROUP BY s.id, b.name ORDER BY units_sold ${direction} LIMIT 25`, values);
    res.json({ window_days: days, rows: result.rows });
  } catch (err) {
    console.log("SKU RANKING ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
}
app.get("/skus/top-performers", auth, (req, res) => skuRanking(req, res, "DESC"));
app.get("/skus/underperformers", auth, (req, res) => skuRanking(req, res, "ASC"));

const leadAttempts = new Map();
app.post("/leads", async (req, res) => {
  try {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const recent = (leadAttempts.get(ip) || []).filter((time) => now - time < 3600000);
    if (recent.length >= 10) return res.status(429).json({ error: "Too many enquiries. Please try again later." });
    recent.push(now); leadAttempts.set(ip, recent);
    const { full_name, phone, email, enquiry_type = "other", service_option, message, city } = req.body || {};
    if (!String(full_name || "").trim()) return res.status(400).json({ error: "Full name is required" });
    const result = await db.query("INSERT INTO leads (full_name, phone, email, enquiry_type, service_option, message, city) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [String(full_name).trim(), phone || null, email || null, enquiry_type, service_option || null, message || null, city || null]);
    await emitOperationsEvent("lead-created", result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.log("LEAD INTAKE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/leads", auth, async (req, res) => {
  try {
    const keys = ["stage", "enquiry_type", "city", "assigned_to"];
    const values = []; const clauses = [];
    keys.forEach((key) => { if (req.query[key]) { values.push(req.query[key]); clauses.push(`${key}=$${values.length}`); } });
    const result = await db.query(`SELECT * FROM leads ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC`, values);
    res.json(result.rows);
  } catch (err) {
    console.log("LEADS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/leads/:id", auth, async (req, res) => {
  try {
    const allowed = ["stage", "assigned_to", "full_name", "phone", "email", "message", "city", "enquiry_type", "service_option"];
    const fields = allowed.filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    const values = fields.map((key) => req.body[key]);
    const result = await db.query(`UPDATE leads SET ${fields.map((key, index) => `${key}=$${index + 1}`).join(", ")}, updated_at=NOW() WHERE id=$${fields.length + 1} RETURNING *`, [...values, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Lead not found" });
    await emitOperationsEvent("lead-updated", result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.log("LEAD UPDATE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/pipeline", auth, async (req, res) => {
  try {
    const [funnel, city, type] = await Promise.all([
      db.query("SELECT stage, COUNT(*)::int AS count FROM leads GROUP BY stage ORDER BY stage"),
      db.query("SELECT COALESCE(city, 'Unknown') AS city, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE stage='won')::int AS won FROM leads GROUP BY 1 ORDER BY total DESC"),
      db.query("SELECT enquiry_type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE stage='won')::int AS won FROM leads GROUP BY enquiry_type ORDER BY total DESC"),
    ]);
    const totals = await db.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE stage='won')::int AS won FROM leads");
    const total = totals.rows[0]?.total || 0;
    res.json({ funnel: funnel.rows, by_city: city.rows, by_type: type.rows, win_rate: total ? Math.round((Number(totals.rows[0].won) / total) * 100) : 0 });
  } catch (err) {
    console.log("PIPELINE ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/demand-heatmap", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const result = await db.query("SELECT EXTRACT(DOW FROM sm.created_at)::int AS day_of_week, EXTRACT(HOUR FROM sm.created_at)::int AS hour_of_day, SUM(sm.quantity)::int AS sales_volume FROM stock_movements sm WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day') GROUP BY 1,2 ORDER BY 1,2", [days]);
    res.json({ window_days: days, rows: result.rows });
  } catch (err) {
    console.log("DEMAND HEATMAP ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/demand-by-sector", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const result = await db.query("SELECT COALESCE(m.sector, 'unknown') AS sector, SUM(sm.quantity)::int AS sales_volume, COUNT(DISTINCT m.id)::int AS machine_count FROM stock_movements sm JOIN machine_slots ms ON ms.id=sm.machine_slot_id JOIN machines m ON m.id=ms.machine_id WHERE sm.change_type='sale' AND sm.created_at >= NOW() - ($1 * INTERVAL '1 day') GROUP BY 1 ORDER BY sales_volume DESC", [days]);
    res.json({ window_days: days, rows: result.rows });
  } catch (err) {
    console.log("DEMAND SECTOR ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/refill-routes", auth, async (req, res) => {
  try {
    const result = await db.query(`WITH slot_velocity AS (
      SELECT ms.machine_id, ms.id, ms.current_stock, ms.low_stock_threshold,
             COALESCE(SUM(sm.quantity), 0)::numeric / 7 AS daily_sales
      FROM machine_slots ms LEFT JOIN stock_movements sm ON sm.machine_slot_id=ms.id
        AND sm.change_type='sale' AND sm.created_at >= NOW() - INTERVAL '7 days'
      GROUP BY ms.id
    )
    SELECT m.id, m.name, m.location, m.city, m.lat, m.lng, COUNT(sv.id)::int AS urgent_slots
    FROM machines m JOIN slot_velocity sv ON sv.machine_id=m.id
    WHERE sv.current_stock <= sv.low_stock_threshold OR (sv.daily_sales > 0 AND sv.current_stock / sv.daily_sales <= 2)
    GROUP BY m.id ORDER BY m.lat NULLS LAST, m.lng NULLS LAST, m.city, m.name`);
    res.json({ stop_count: result.rows.length, route: result.rows });
  } catch (err) {
    console.log("REFILL ROUTE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

const importSchemas = {
  machines: ["name", "location", "city", "sector", "host_site_company_name", "lat", "lng", "install_date"],
  slots: ["machine_location", "slot_number", "sku_name", "capacity", "current_stock", "low_stock_threshold"],
  host_sites: ["company_name", "contact_name", "contact_phone", "contact_email", "address", "city", "sector", "contract_start", "contract_end", "service_charge"],
  brands: ["name", "contact_email", "contact_phone", "status"],
  skus: ["brand_name", "name", "category", "unit_price"],
};

function importUserCanAccess(req) {
  return req.user?.role === "admin" || req.user?.department === "Operations";
}

function normalizeImportRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    typeof value === "string" ? value.trim() : value,
  ]));
}

function importValue(row, key) {
  const value = row[key];
  return value === undefined || value === null ? "" : value;
}

function importNumber(value, label, rowNumber, errors, { integer = false, required = true } = {}) {
  if (value === "" && !required) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) {
    errors.push({ row: rowNumber, status: "error", message: `${label} must be a valid ${integer ? "integer" : "number"}` });
    return null;
  }
  return number;
}

function importRequired(value, label, rowNumber, errors) {
  if (String(value ?? "").trim() === "") errors.push({ row: rowNumber, status: "error", message: `${label} is required` });
  return String(value ?? "").trim();
}

function importDate(value, label, rowNumber, errors) {
  if (value === "" || value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) errors.push({ row: rowNumber, status: "error", message: `${label} must be a valid date` });
  return value;
}

function importEmail(value, label, rowNumber, errors) {
  if (!value) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) errors.push({ row: rowNumber, status: "error", message: `${label} must be a valid email` });
  return value;
}

async function uploadImportFile(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", folder: "snackit/imports", use_filename: true, unique_filename: true },
      (error, result) => error ? reject(error) : resolve(result?.secure_url || result?.url)
    );
    stream.end(file.buffer);
  });
}

async function updateImportBatch(id, fields) {
  const keys = Object.keys(fields);
  const values = keys.map((key) => fields[key]);
  await db.query(`UPDATE import_batches SET ${keys.map((key, index) => `${key}=$${index + 1}`).join(", ")} WHERE id=$${keys.length + 1}`, [...values, id]);
}

async function resolveImportReferences(type, rows) {
  for (const item of rows) {
    const { rowNumber, row, errors } = item;
    if (type === "machines") {
      const company = importValue(row, "host_site_company_name");
      if (company) {
        const result = await db.query("SELECT id FROM host_sites WHERE LOWER(company_name)=LOWER($1) LIMIT 1", [company]);
        if (!result.rows.length) errors.push({ row: rowNumber, status: "error", message: `Host site '${company}' not found` });
        else item.hostSiteId = result.rows[0].id;
      }
    }
    if (type === "slots") {
      const location = importRequired(importValue(row, "machine_location"), "machine_location", rowNumber, errors);
      const machine = await db.query("SELECT id FROM machines WHERE LOWER(location)=LOWER($1) LIMIT 1", [location]);
      if (!machine.rows.length) errors.push({ row: rowNumber, status: "error", message: `Machine at '${location}' not found` });
      else item.machineId = machine.rows[0].id;
      const sku = importRequired(importValue(row, "sku_name"), "sku_name", rowNumber, errors);
      const skuResult = await db.query("SELECT id FROM skus WHERE LOWER(name)=LOWER($1) LIMIT 1", [sku]);
      if (!skuResult.rows.length) errors.push({ row: rowNumber, status: "error", message: `SKU '${sku}' not found` });
      else item.skuId = skuResult.rows[0].id;
    }
    if (type === "skus") {
      const brand = importRequired(importValue(row, "brand_name"), "brand_name", rowNumber, errors);
      const brandResult = await db.query("SELECT id FROM brands WHERE LOWER(name)=LOWER($1) LIMIT 1", [brand]);
      if (!brandResult.rows.length) errors.push({ row: rowNumber, status: "error", message: `Brand '${brand}' not found` });
      else item.brandId = brandResult.rows[0].id;
    }
  }
}

async function validateImportRows(type, rawRows) {
  const expected = importSchemas[type];
  const prepared = [];
  const report = [];
  rawRows.forEach((source, index) => {
    const rowNumber = index + 2;
    const row = normalizeImportRow(source);
    const errors = [];
    expected.forEach((column) => {
      if (column !== "host_site_company_name" && column !== "category" && column !== "contact_name" && column !== "contact_phone" && column !== "contact_email" && column !== "address" && column !== "city" && column !== "sector" && column !== "install_date" && column !== "contract_start" && column !== "contract_end" && column !== "service_charge" && column !== "status" && column !== "lat" && column !== "lng") importRequired(importValue(row, column), column, rowNumber, errors);
    });
    if (type === "machines") {
      importRequired(row.name, "name", rowNumber, errors); importRequired(row.location, "location", rowNumber, errors);
      importNumber(row.lat, "lat", rowNumber, errors, { required: false }); importNumber(row.lng, "lng", rowNumber, errors, { required: false });
      importDate(row.install_date, "install_date", rowNumber, errors);
    }
    if (type === "slots") {
      importRequired(row.slot_number, "slot_number", rowNumber, errors); importNumber(row.capacity, "capacity", rowNumber, errors, { integer: true }); importNumber(row.current_stock, "current_stock", rowNumber, errors, { integer: true }); importNumber(row.low_stock_threshold, "low_stock_threshold", rowNumber, errors, { integer: true });
    }
    if (type === "host_sites") { importRequired(row.company_name, "company_name", rowNumber, errors); importNumber(row.service_charge, "service_charge", rowNumber, errors, { required: false }); importEmail(row.contact_email, "contact_email", rowNumber, errors); importDate(row.contract_start, "contract_start", rowNumber, errors); importDate(row.contract_end, "contract_end", rowNumber, errors); }
    if (type === "brands") { importRequired(row.name, "name", rowNumber, errors); importEmail(row.contact_email, "contact_email", rowNumber, errors); if (row.status && !["active", "pending", "inactive"].includes(String(row.status).toLowerCase())) errors.push({ row: rowNumber, status: "error", message: "status must be active, pending, or inactive" }); }
    if (type === "skus") { importRequired(row.name, "name", rowNumber, errors); importNumber(row.unit_price, "unit_price", rowNumber, errors, { required: false }); }
    prepared.push({ rowNumber, row, errors });
  });
  await resolveImportReferences(type, prepared);
  report.push(...prepared.flatMap((item) => item.errors));
  return { prepared, report };
}

async function writeImportRow(type, item) {
  const { row, hostSiteId, machineId, skuId, brandId } = item;
  if (type === "machines") {
    const result = await db.query(`INSERT INTO machines (name, location, city, sector, host_site_id, lat, lng, install_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (location) DO UPDATE SET name=EXCLUDED.name, city=EXCLUDED.city, sector=EXCLUDED.sector, host_site_id=EXCLUDED.host_site_id, lat=EXCLUDED.lat, lng=EXCLUDED.lng, install_date=EXCLUDED.install_date, updated_at=NOW() RETURNING id`, [row.name, row.location, row.city || null, row.sector || null, hostSiteId || null, row.lat === "" ? null : Number(row.lat), row.lng === "" ? null : Number(row.lng), row.install_date || null]);
    return result.rows[0].id;
  }
  if (type === "slots") {
    const result = await db.query(`INSERT INTO machine_slots (machine_id, slot_number, sku_id, capacity, current_stock, low_stock_threshold) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (machine_id, slot_number) DO UPDATE SET sku_id=EXCLUDED.sku_id, capacity=EXCLUDED.capacity, current_stock=EXCLUDED.current_stock, low_stock_threshold=EXCLUDED.low_stock_threshold, updated_at=NOW() RETURNING id`, [machineId, row.slot_number, skuId, Number(row.capacity), Number(row.current_stock), Number(row.low_stock_threshold)]);
    return result.rows[0].id;
  }
  if (type === "host_sites") {
    const existing = await db.query("SELECT id FROM host_sites WHERE LOWER(company_name)=LOWER($1) LIMIT 1", [row.company_name]);
    const result = existing.rows.length
      ? await db.query(`UPDATE host_sites SET contact_name=$1, contact_phone=$2, contact_email=$3, address=$4, city=$5, sector=$6, contract_start=$7, contract_end=$8, service_charge=$9, updated_at=NOW() WHERE id=$10 RETURNING id`, [row.contact_name || null, row.contact_phone || null, row.contact_email || null, row.address || null, row.city || null, row.sector || null, row.contract_start || null, row.contract_end || null, row.service_charge === "" ? 0 : Number(row.service_charge), existing.rows[0].id])
      : await db.query(`INSERT INTO host_sites (company_name, contact_name, contact_phone, contact_email, address, city, sector, contract_start, contract_end, service_charge) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [row.company_name, row.contact_name || null, row.contact_phone || null, row.contact_email || null, row.address || null, row.city || null, row.sector || null, row.contract_start || null, row.contract_end || null, row.service_charge === "" ? 0 : Number(row.service_charge)]);
    return result.rows[0].id;
  }
  if (type === "brands") {
    const result = await db.query(`INSERT INTO brands (name, contact_email, contact_phone, status) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET contact_email=EXCLUDED.contact_email, contact_phone=EXCLUDED.contact_phone, status=EXCLUDED.status, updated_at=NOW() RETURNING id`, [row.name, row.contact_email || null, row.contact_phone || null, row.status || "active"]);
    return result.rows[0].id;
  }
  const result = await db.query(`INSERT INTO skus (brand_id, name, category, unit_price) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [brandId, row.name, row.category || null, row.unit_price === "" ? 0 : Number(row.unit_price)]);
  if (result.rows.length) return result.rows[0].id;
  const existing = await db.query("SELECT id FROM skus WHERE brand_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1", [brandId, row.name]);
  if (!existing.rows.length) throw new Error(`SKU '${row.name}' could not be saved`);
  await db.query("UPDATE skus SET category=$1, unit_price=$2, updated_at=NOW() WHERE id=$3", [row.category || null, row.unit_price === "" ? 0 : Number(row.unit_price), existing.rows[0].id]);
  return existing.rows[0].id;
}

app.post("/operations/import", auth, operationsUpload.single("file"), async (req, res) => {
  let batchId = null;
  try {
    if (!importUserCanAccess(req)) return res.status(403).json({ error: "Admin or Operations access required" });
    const type = String(req.body?.type || "").trim().toLowerCase();
    if (!importSchemas[type]) return res.status(400).json({ error: "Invalid import type" });
    if (!req.file) return res.status(400).json({ error: "Spreadsheet file is required" });
    const cloudinaryUrl = await uploadImportFile(req.file);
    const batch = await db.query("INSERT INTO import_batches (filename, cloudinary_url, uploaded_by, sheet_type, status) VALUES ($1,$2,$3,$4,'processing') RETURNING *", [req.file.originalname, cloudinaryUrl, req.user?.name || req.user?.username || "Admin", type]);
    batchId = batch.rows[0].id;
    let rawRows;
    try {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    } catch (err) {
      await updateImportBatch(batchId, { status: "failed", error_count: 1, error_report: JSON.stringify([{ row: 0, status: "error", message: "Could not parse spreadsheet" }]) });
      return res.status(400).json({ error: "Could not parse spreadsheet", batch_id: batchId });
    }
    if (!rawRows.length) throw new Error("Spreadsheet has no data rows");
    const { prepared, report } = await validateImportRows(type, rawRows);
    let successCount = 0;
    for (const item of prepared) {
      if (item.errors.length) continue;
      try {
        const id = await writeImportRow(type, item);
        report.push({ row: item.rowNumber, status: "success", id }); successCount += 1;
      } catch (err) {
        report.push({ row: item.rowNumber, status: "error", message: err.message });
      }
    }
    const errorCount = report.filter((item) => item.status === "error").length;
    const status = successCount === 0 ? "failed" : "completed";
    await updateImportBatch(batchId, { total_rows: rawRows.length, success_count: successCount, error_count: errorCount, status, error_report: JSON.stringify(report) });
    const summary = { id: batchId, filename: req.file.originalname, sheet_type: type, total_rows: rawRows.length, success_count: successCount, error_count: errorCount, status, cloudinary_url: cloudinaryUrl };
    await emitOperationsEvent("import-completed", summary);
    res.status(201).json({ ...summary, error_report: report });
  } catch (err) {
    console.log("IMPORT ERROR:", err.message);
    if (batchId) await updateImportBatch(batchId, { status: "failed", error_count: 1, error_report: JSON.stringify([{ row: 0, status: "error", message: err.message }]) });
    res.status(500).json({ error: err.message || "Import failed", batch_id: batchId });
  }
});

app.get("/operations/imports", auth, async (req, res) => {
  try {
    const values = []; let filter = "";
    if (req.query.type && importSchemas[String(req.query.type)]) { values.push(String(req.query.type)); filter = "WHERE sheet_type=$1"; }
    const result = await db.query(`SELECT id, filename, cloudinary_url, uploaded_by, sheet_type, total_rows, success_count, error_count, status, created_at FROM import_batches ${filter} ORDER BY created_at DESC`, values);
    res.json(result.rows);
  } catch (err) {
    console.log("IMPORT HISTORY ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/operations/imports/:id", auth, async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM import_batches WHERE id=$1", [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: "Import batch not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.log("IMPORT DETAIL ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/operations/import-template/:type", auth, async (req, res) => {
  try {
    const type = String(req.params.type || "").toLowerCase();
    if (!importSchemas[type]) return res.status(400).json({ error: "Invalid import type" });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([importSchemas[type]]), type);
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="snackit-${type}-template.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.log("IMPORT TEMPLATE ERROR:", err.message);
    res.status(500).json({ error: "Could not generate template" });
  }
});

app.get("/tickets/:id/status", auth, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, status, state, refund_stage, updated_at FROM tickets WHERE id=$1",
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Ticket not found" });
    res.json({ ...result.rows[0], stages: ["RAISED", "VERIFYING", "UNDER_REVIEW", "PROCESSED"] });
  } catch (err) {
    console.log("TICKET STATUS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================================================
   ANALYTICS
========================================================= */
app.get("/analytics/machine-health", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const threshold = Math.max(1, Number(req.query.threshold) || 5);
    const result = await db.query(
      `SELECT m.id, m.name, m.location, m.lat, m.lng,
              COUNT(t.id)::int AS complaint_count,
              (COUNT(t.id) >= $2) AS needs_maintenance
       FROM machines m
       LEFT JOIN tickets t ON t.machine_id = m.id AND t.created_at >= NOW() - ($1 * INTERVAL '1 day')
       GROUP BY m.id
       ORDER BY complaint_count DESC, m.name`,
      [days, threshold]
    );
    res.json({ window_days: days, threshold, machines: result.rows });
  } catch (err) {
    console.log("MACHINE HEALTH ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/sla", auth, async (req, res) => {
  try {
    const slaHours = Math.max(1, Number(req.query.sla_hours) || 24);
    const result = await db.query(
      `SELECT COALESCE(NULLIF(main_issue, ''), NULLIF(category, ''), 'Unknown') AS category,
              COUNT(*)::int AS ticket_count,
              ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_at, updated_at) - created_at)) / 3600)::numeric, 2) AS average_resolution_hours
       FROM tickets
       WHERE LOWER(COALESCE(status, '')) IN ('resolved', 'refunded', 'auto_refunded', 'closed')
       GROUP BY 1 ORDER BY 1`,
    );
    const breaching = await db.query(
      `SELECT id, phone, category, main_issue, sub_issue, priority, assigned_to, created_at,
              ROUND((EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::numeric, 2) AS age_hours
       FROM tickets
       WHERE LOWER(COALESCE(status, '')) NOT IN ('resolved', 'refunded', 'auto_refunded', 'closed')
         AND created_at < NOW() - ($1 * INTERVAL '1 hour')
       ORDER BY created_at ASC`,
      [slaHours]
    );
    res.json({ sla_hours: slaHours, by_category: result.rows, breaching: breaching.rows });
  } catch (err) {
    console.log("SLA ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/agent-performance", auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COALESCE(NULLIF(assigned_to, ''), 'Unassigned') AS agent,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('resolved', 'refunded', 'auto_refunded', 'closed'))::int AS tickets_closed,
              ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_at, updated_at) - created_at)) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('resolved', 'refunded', 'auto_refunded', 'closed')) / 3600)::numeric, 2) AS average_resolution_hours
       FROM tickets GROUP BY 1 ORDER BY tickets_closed DESC, agent`
    );
    res.json(result.rows);
  } catch (err) {
    console.log("AGENT ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/analytics/csat", auth, async (req, res) => {
  try {
    const byCategory = await db.query(
      `SELECT COALESCE(NULLIF(t.main_issue, ''), NULLIF(t.category, ''), 'Unknown') AS category,
              ROUND(AVG(f.rating::numeric), 2) AS average_rating, COUNT(*)::int AS response_count
       FROM feedback f LEFT JOIN tickets t ON t.id = f.ticket_id
       WHERE f.rating IS NOT NULL GROUP BY 1 ORDER BY 1`
    );
    const byMachine = await db.query(
      `SELECT m.id AS machine_id, m.name, m.location,
              ROUND(AVG(f.rating::numeric), 2) AS average_rating, COUNT(*)::int AS response_count
       FROM feedback f JOIN tickets t ON t.id = f.ticket_id JOIN machines m ON m.id = t.machine_id
       WHERE f.rating IS NOT NULL GROUP BY m.id ORDER BY m.name`
    );
    res.json({ by_category: byCategory.rows, by_machine: byMachine.rows });
  } catch (err) {
    console.log("CSAT ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

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

    await saveMessage(ticket.id, "user", text || "[media]");

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

app.get("/internal/users", auth, (req, res) => {
  try {
    if (req.user?.role === "admin") return res.json(global.internalUsers);
    res.json(global.internalUsers.map(({ password, ...user }) => user));
  } catch (err) {
    console.log("INTERNAL USERS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/internal/users/:id", auth, (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    global.internalUsers = global.internalUsers.filter((user) => String(user.id) !== String(id));
    io.emit("internal-user-updated", { removedUserId: id });
    res.json({ success: true });
  } catch (err) {
    console.log("DELETE INTERNAL USER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/internal/users", auth, (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { name, department, role, tags, isAdmin } = req.body || {};

    if (!name || !department || !role) {
      return res.status(400).json({ error: "Name, department and role are required" });
    }

    const baseUsername = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "employee";
    let username = baseUsername;
    let suffix = 2;
    while (global.internalUsers.some((user) => user.username === username)) {
      username = `${baseUsername}${suffix}`;
      suffix += 1;
    }
    const generatedPassword = `Snackit@${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const nextUser = {
      id: Date.now() + Math.random(),
      username,
      password: generatedPassword,
      name: String(name).trim(),
      department: String(department).trim(),
      role: String(role).trim(),
      tags: getInternalTagList(tags ? String(tags).split(",") : []),
      isAdmin: Boolean(isAdmin),
    };

    global.internalUsers.push(nextUser);
    io.emit("internal-user-updated", { user: nextUser });
    res.json({ success: true, user: nextUser, credentials: { username, password: generatedPassword } });
  } catch (err) {
    console.log("CREATE INTERNAL USER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/internal/users/:id", auth, (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const user = global.internalUsers.find((item) => String(item.id) === String(req.params.id));
    if (!user) return res.status(404).json({ error: "Employee not found" });

    const { name, department, role, tags, username, password } = req.body || {};
    if (name !== undefined) user.name = String(name).trim();
    if (department !== undefined) user.department = String(department).trim();
    if (role !== undefined) user.role = String(role).trim();
    if (username !== undefined) user.username = String(username).trim();
    if (password !== undefined && String(password).trim()) user.password = String(password).trim();
    if (tags !== undefined) user.tags = getInternalTagList(Array.isArray(tags) ? tags : String(tags).split(","));

    io.emit("internal-user-updated", { user });
    res.json({ success: true, user });
  } catch (err) {
    console.log("UPDATE INTERNAL USER ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/internal/chats", auth, (req, res) => {
  try {
    const userKey = getInternalUserKey(req.user);
    res.json(global.internalChats.map((chat) => ({
      ...chat,
      unread: Number(chat.unreadBy?.[userKey] || 0),
    })));
  } catch (err) {
    console.log("INTERNAL CHATS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/internal/chats/:id", auth, (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    global.internalChats = global.internalChats.filter((chat) => String(chat.id) !== String(id));
    io.emit("internal-chat-deleted", { chatId: id });
    res.json({ success: true });
  } catch (err) {
    console.log("DELETE INTERNAL CHAT ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/internal/chats/:id", auth, (req, res) => {
  try {
    const chat = global.internalChats.find((item) => String(item.id) === String(req.params.id));
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    const { title, pinned, archived, favorite, priority } = req.body || {};
    if (title !== undefined) {
      const cleanTitle = String(title).trim();
      if (!cleanTitle) return res.status(400).json({ error: "Chat title cannot be empty" });
      chat.title = cleanTitle;
    }
    if (pinned !== undefined) chat.pinned = Boolean(pinned);
    if (archived !== undefined) chat.archived = Boolean(archived);
    if (favorite !== undefined) chat.favorite = Boolean(favorite);
    if (priority !== undefined && ["low", "medium", "urgent"].includes(priority)) chat.priority = priority;
    io.to(chat.department).emit("internal-chat-updated", { chat });
    res.json({ success: true, chat });
  } catch (err) {
    console.log("UPDATE INTERNAL CHAT ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/internal/chats/:id/read", auth, (req, res) => {
  try {
    const chat = global.internalChats.find((item) => String(item.id) === String(req.params.id));
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    chat.unreadBy = { ...(chat.unreadBy || {}), [getInternalUserKey(req.user)]: 0 };
    res.json({ success: true, chat: { ...chat, unread: 0 } });
  } catch (err) {
    console.log("MARK INTERNAL CHAT READ ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/internal/saved-replies", auth, (req, res) => {
  res.json(global.internalSavedReplies);
});

app.post("/internal/saved-replies", auth, (req, res) => {
  const title = String(req.body?.title || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!title || !text) return res.status(400).json({ error: "Title and text are required" });
  const reply = { id: `reply-${Date.now()}`, title, text };
  global.internalSavedReplies.unshift(reply);
  res.json({ success: true, reply });
});

app.post("/internal/chats", auth, (req, res) => {
  try {
    const { department, title, priority, participants } = req.body || {};

    if (!department || !title) {
      return res.status(400).json({ error: "Department and title are required" });
    }

    const chatPriority = ["low", "medium", "urgent"].includes(priority) ? priority : "medium";
    const newChat = {
      id: Date.now() + Math.random(),
      department: String(department).trim(),
      title: String(title).trim(),
      priority: chatPriority,
      participants: Array.isArray(participants) && participants.length ? participants : ["Admin"],
      unread: 0,
      unreadBy: {},
      pinned: false,
      archived: false,
      favorite: false,
      messages: [
        {
          id: Date.now(),
          sender: "Admin",
          text: `New ${String(department).trim()} team chat started.`,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          tag: null,
          priority: chatPriority,
          status: "open",
        },
      ],
    };

    global.internalChats.unshift(newChat);
    io.to(newChat.department).emit("internal-chat-updated", { chat: newChat });
    io.emit("internal-notification", {
      title: `${newChat.department} thread created`,
      priority: newChat.priority,
      message: `${newChat.title} was started for ${newChat.department}.`,
    });
    res.json({ success: true, chat: newChat });
  } catch (err) {
    console.error("CREATE INTERNAL CHAT ERROR:", err.stack || err.message);
    res.status(500).json({ error: `Chat could not be created: ${err.message}` });
  }
});

app.post("/internal/chats/:id/messages", auth, (req, res) => {
  try {
    if (!Array.isArray(global.internalChats)) global.internalChats = [];
    if (!Array.isArray(global.internalUsers)) global.internalUsers = [];
    if (!Array.isArray(global.internalNotifications)) global.internalNotifications = [];

    const { id } = req.params;
    const { sender, text, tag, priority, sourceUser } = req.body || {};
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const recipientIds = Array.isArray(req.body?.recipientIds) ? req.body.recipientIds : [];

    let chat = global.internalChats.find((item) => String(item.id) === String(id));

    if (!chat) {
      const fallbackDepartment = "Accounts";
      chat = {
        id: Number(id),
        department: fallbackDepartment,
        title: `${fallbackDepartment} chat`,
        priority: "medium",
        participants: [],
        unread: 0,
        messages: [],
      };
      global.internalChats.unshift(chat);
    }

    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
    chat.participants = Array.isArray(chat.participants) ? chat.participants : [];

    const cleanText = String(text || "").trim();
    if (!cleanText && !attachments.length) {
      return res.status(400).json({ error: "Message text or attachment is required" });
    }

    const senderName = req.user?.role === "admin" ? "Admin" : (req.user?.name || sender || "Employee");
    const message = {
      id: Date.now() + Math.random(),
      sender: senderName,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      tag: tag || null,
      priority: ["low", "medium", "urgent"].includes(priority) ? priority : chat.priority || "medium",
      status: "open",
      attachments: attachments.map((file) => ({
        name: String(file?.name || "attachment"),
        type: String(file?.type || "application/octet-stream"),
        size: Number(file?.size || 0),
        dataUrl: typeof file?.dataUrl === "string" && file.dataUrl.length <= 8_000_000 ? file.dataUrl : null,
      })),
      recipientIds,
      replyTo: req.body?.replyTo ? String(req.body.replyTo) : null,
      mentions: Array.isArray(req.body?.mentions) ? req.body.mentions.map(String) : [],
      reactions: {},
      assignedTo: null,
    };

    chat.messages.push(message);
    chat.unreadBy = { ...(chat.unreadBy || {}) };
    const senderKey = getInternalUserKey(req.user);
    const recipientKeys = recipientIds.length ? recipientIds.map(String) : global.internalUsers
      .filter((user) => user.department === chat.department)
      .map((user) => String(user.id));
    recipientKeys.forEach((userKey) => {
      if (String(userKey) !== senderKey) chat.unreadBy[userKey] = Number(chat.unreadBy[userKey] || 0) + 1;
    });
    chat.unread = Number(chat.unreadBy[senderKey] || 0);
    chat.priority = message.priority;
    chat.participants = Array.from(new Set([
      ...chat.participants,
      ...recipientIds,
      senderName,
    ]));

    const relatedUsers = global.internalUsers.filter((user) => user.department === chat.department || recipientIds.includes(String(user.id)));
    const targetUsers = relatedUsers.map((user) => user.name);

    const notification = addInternalNotification({
      department: chat.department,
      priority: chat.priority,
      title: chat.title,
      targetUsers,
      message: cleanText || `Attachment sent (${attachments.length})`,
      sourceUser: sourceUser || sender || "Admin",
    });
    notification.mentionUserIds = message.mentions;
    notification.recipientIds = recipientIds.map(String);
    notification.notifyAll = req.body?.notifyAll === true;

    if (recipientIds.length) {
      recipientIds.forEach((userId) => {
        io.to(`internal-user-${String(userId)}`).emit("internal-chat-updated", { chat, notification });
        io.to(`internal-user-${String(userId)}`).emit("internal-notification", notification);
      });
    } else {
      io.to(chat.department).emit("internal-chat-updated", { chat, notification });
      io.to(chat.department).emit("internal-notification", notification);
    }

    res.json({ success: true, chat, notification });
  } catch (err) {
    console.error("CREATE INTERNAL MESSAGE ERROR:", err.stack || err.message);
    res.status(500).json({ error: `Message could not be sent: ${err.message}` });
  }
});

app.patch("/internal/chats/:chatId/messages/:messageId/status", auth, (req, res) => {
  try {
    const chat = global.internalChats.find((item) => String(item.id) === String(req.params.chatId));
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const message = chat.messages.find((item) => String(item.id) === String(req.params.messageId));
    if (!message) return res.status(404).json({ error: "Message not found" });

    const allowedStatuses = ["open", "in-progress", "resolved"];
    if (!allowedStatuses.includes(req.body?.status)) {
      return res.status(400).json({ error: "Invalid message status" });
    }

    const isAdmin = req.user?.role === "admin";
    const isRecipient = Array.isArray(message.recipientIds) && message.recipientIds.map(String).includes(String(req.user?.userId));
    const isSender = message.sender === req.user?.name;
    if (!isAdmin && !isRecipient && !isSender) return res.status(403).json({ error: "You cannot update this message" });

    message.status = req.body.status;
    message.statusUpdatedBy = req.user?.name || "Admin";
    message.statusUpdatedAt = new Date().toISOString();
    io.emit("internal-chat-updated", { chat });
    res.json({ success: true, chat });
  } catch (err) {
    console.log("UPDATE INTERNAL MESSAGE STATUS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/internal/chats/:chatId/messages/:messageId", auth, (req, res) => {
  try {
    const chat = global.internalChats.find((item) => String(item.id) === String(req.params.chatId));
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    const message = chat.messages.find((item) => String(item.id) === String(req.params.messageId));
    if (!message) return res.status(404).json({ error: "Message not found" });

    if (req.body?.assignedTo !== undefined) message.assignedTo = req.body.assignedTo ? String(req.body.assignedTo) : null;
    if (req.body?.reaction) {
      const reaction = String(req.body.reaction);
      const userKey = getInternalUserKey(req.user);
      message.reactions = { ...(message.reactions || {}) };
      message.reactions[reaction] = Array.isArray(message.reactions[reaction]) ? message.reactions[reaction] : [];
      message.reactions[reaction] = message.reactions[reaction].includes(userKey)
        ? message.reactions[reaction].filter((key) => key !== userKey)
        : [...message.reactions[reaction], userKey];
    }
    io.to(chat.department).emit("internal-chat-updated", { chat });
    res.json({ success: true, chat });
  } catch (err) {
    console.log("UPDATE INTERNAL MESSAGE ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/internal/notifications", auth, (req, res) => {
  try {
    res.json(global.internalNotifications.slice(0, 8));
  } catch (err) {
    console.log("INTERNAL NOTIFICATIONS ERROR:", err.message);
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

loadBotSettingsFromDb();

setInterval(() => {
  autoCloseInactiveTickets();
}, 60 * 1000);

setInterval(() => {
  recalculateInventoryAlerts();
  emitRenewalWarnings();
}, 15 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(` Server running on port ${PORT}`);
});