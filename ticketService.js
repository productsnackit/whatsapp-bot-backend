import db from "./db.js";
import crypto from "crypto";
import axios from "axios";

/* ================= DEBUG CHECK ================= */
if (!db || typeof db.query !== "function") {
  throw new Error("❌ DB not initialized. Check db.js");
}

/* ================= PAYTM CONFIG ================= */
const PAYTM_MERCHANT_ID = process.env.PAYTM_MERCHANT_ID;
const PAYTM_MERCHANT_KEY = process.env.PAYTM_MERCHANT_KEY;
const PAYTM_API_URL = "https://securegw.paytm.in/merchant-status/getTxnStatus";

/* =========================================================
   🔐 PAYTM CHECKSUM GENERATION
========================================================= */
export function generatePaytmChecksum(data) {
  try {
    // Create checksum string
    const checksumString = Object.keys(data)
      .sort()
      .map((key) => `${key}=${data[key]}`)
      .join("&");

    // Generate checksum with PAYTM_MERCHANT_KEY
    const checksum = crypto
      .createHmac("sha256", PAYTM_MERCHANT_KEY)
      .update(checksumString)
      .digest("base64");

    return checksum;
  } catch (err) {
    console.error("Checksum generation error:", err.message);
    return null;
  }
}

/* =========================================================
   🔍 VERIFY TRANSACTION ON PAYTM
========================================================= */
export async function verifyPaymentOnPaytm(orderId) {
  try {
    if (!PAYTM_MERCHANT_ID || !PAYTM_MERCHANT_KEY) {
      console.log("⚠️ Paytm credentials not configured");
      return { status: "UNKNOWN", message: "API not configured" };
    }

    const data = {
      MID: PAYTM_MERCHANT_ID,
      ORDERID: orderId,
    };

    const checksum = generatePaytmChecksum(data);

    if (!checksum) {
      return { status: "ERROR", message: "Checksum generation failed" };
    }

    data.CHECKSUMHASH = checksum;

    // Call Paytm API
    const response = await axios.post(PAYTM_API_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("🔍 Paytm Response:", response.data);

    // Parse Paytm response
    const txnStatus = response.data.STATUS;
    const txnAmount = response.data.TXNAMOUNT;
    const txnId = response.data.TXNID;
    const gatewayName = response.data.GATEWAYNAME;
    const bankName = response.data.BANKNAME;
    const responseCode = response.data.RESPCODE;
    const responseMsg = response.data.RESPMSG;

    return {
      status: txnStatus, // SUCCESS, FAILED, PENDING, PROCESSING
      amount: txnAmount,
      txnId: txnId,
      gateway: gatewayName,
      bank: bankName,
      responseCode: responseCode,
      message: responseMsg,
      verified: txnStatus === "TXN_SUCCESS",
    };
  } catch (err) {
    console.error("❌ Paytm verification error:", err.message);
    return {
      status: "ERROR",
      message: err.message,
      verified: false,
    };
  }
}

/* =========================================================
   💾 STORE PAYTM VERIFICATION IN DB
========================================================= */
export async function storePaytmVerification(ticketId, paytmData) {
  try {
    await db.query(
      `UPDATE tickets SET 
        paytm_transaction_id = $1,
        paytm_status = $2,
        transaction_verified = $3,
        paytm_verified_at = NOW(),
        paytm_response = $4,
        updated_at = NOW()
      WHERE id = $5`,
      [
        paytmData.txnId,
        paytmData.status,
        paytmData.verified,
        JSON.stringify(paytmData),
        ticketId,
      ]
    );
    return true;
  } catch (err) {
    console.error("Store Paytm verification error:", err.message);
    return false;
  }
}

/* =========================================================
   📄 CREATE OR GET ACTIVE TICKET
========================================================= */
export async function getOrCreateTicket(phone) {
  // 1️⃣ CHECK if active ticket exists
  const existing = await db.query(
    `SELECT * FROM tickets 
     WHERE phone = $1 
     AND state NOT IN ('DONE', 'CLOSED') 
     LIMIT 1`,
    [phone]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0]; // ✅ RETURN EXISTING
  }

  // 2️⃣ CREATE NEW ONLY IF NONE EXISTS
  const result = await db.query(
    `INSERT INTO tickets (phone, state, category, status, created_at)
     VALUES ($1, 'START', NULL, 'OPEN', NOW())
     RETURNING *`,
    [phone]
  );

  return result.rows[0];
}

/* =========================================================
   🧠 SMART TEXT PROCESSING
========================================================= */
export async function processMessage(ticketId, text) {
  try {
    if (!text) return;

    console.log("📩 Incoming:", text);

    // 🔥 Extract UPI
    let upi = null;
    if (text.includes("@")) {
      upi = text.trim();
      console.log("💳 UPI Detected:", upi);
    }

    // 🔥 Extract Issue (basic for now)
    let issue = text;

    await db.query(
      `
      UPDATE tickets
      SET 
        issue = COALESCE(issue, $1),
        upi_id = COALESCE(upi_id, $2),
        updated_at = NOW()
      WHERE id = $3
      `,
      [issue, upi, ticketId]
    );

    return true;
  } catch (err) {
    console.error("processMessage error:", err.message);
    return false;
  }
}

/* =========================================================
   📝 UPDATE ISSUE
========================================================= */
export async function updateIssue(ticketId, issue) {
  try {
    await db.query(
      "UPDATE tickets SET issue = $1, updated_at = NOW() WHERE id = $2",
      [issue, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateIssue error:", err.message);
    return false;
  }
}

/* =========================================================
   💳 UPI ID
========================================================= */
export async function updateUPI(ticketId, upi) {
  try {
    await db.query(
      "UPDATE tickets SET upi_id = $1, updated_at = NOW() WHERE id = $2",
      [upi, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateUPI error:", err.message);
    return false;
  }
}

/* =========================================================
   🏷️ ISSUE TYPE
========================================================= */
export async function updateIssueType(ticketId, type) {
  try {
    await db.query(
      "UPDATE tickets SET issue_type = $1 WHERE id = $2",
      [type, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateIssueType error:", err.message);
    return false;
  }
}

/* =========================================================
   📊 STATUS
========================================================= */
export async function updateStatus(ticketId, status) {
  try {
    await db.query(
      "UPDATE tickets SET status = $1 WHERE id = $2",
      [status, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateStatus error:", err.message);
    return false;
  }
}

/* =========================================================
   🔄 STATE
========================================================= */
export async function updateState(ticketId, state) {
  try {
    await db.query(
      "UPDATE tickets SET state = $1 WHERE id = $2",
      [state, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateState error:", err.message);
    return false;
  }
}

/* =========================================================
   🖼️ IMAGE
========================================================= */
export async function updateImage(ticketId, imageUrl) {
  try {
    await db.query(
      "UPDATE tickets SET image = $1, updated_at = NOW() WHERE id = $2",
      [imageUrl, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateImage error:", err.message);
    return false;
  }
}

/* =========================================================
   ❌ CLOSE TICKET
========================================================= */
export async function closeTicket(ticketId) {
  try {
    await db.query(
      "UPDATE tickets SET status='CLOSED', state='CLOSED', updated_at=NOW() WHERE id=$1",
      [ticketId]
    );
    return true;
  } catch (err) {
    console.error("closeTicket error:", err.message);
    return false;
  }
}