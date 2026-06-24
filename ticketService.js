import db from "./db.js";

/* ================= DEBUG CHECK ================= */
if (!db || typeof db.query !== "function") {
  throw new Error("âŒ DB not initialized. Check db.js");
}

/* =========================================================
   ðŸ”„ CREATE OR GET ACTIVE TICKET
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
   ðŸ§  SMART TEXT PROCESSING (NEW ðŸ”¥)
========================================================= */
export async function processMessage(ticketId, text) {
  try {
    if (!text) return;

    console.log("ðŸ“© Incoming:", text);

    // ðŸ”¥ Extract UPI
    let upi = null;
    if (text.includes("@")) {
      upi = text.trim();
      console.log("ðŸ’³ UPI Detected:", upi);
    }

    // ðŸ”¥ Extract Issue (basic for now)
    let issue = text;

    await db.query(
      `
      UPDATE tickets
      SET 
        issue = COALESCE(issue, $1),
        upi = COALESCE(upi, $2),
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
   ðŸ“ ISSUE
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
   ðŸ’³ UPI (FIXED âœ…)
========================================================= */
export async function updateUPI(ticketId, upi) {
  try {
    await db.query(
      "UPDATE tickets SET upi = $1, updated_at = NOW() WHERE id = $2",
      [upi, ticketId]
    );
    return true;
  } catch (err) {
    console.error("updateUPI error:", err.message);
    return false;
  }
}

/* =========================================================
   ðŸ·ï¸ ISSUE TYPE
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
   ðŸ“Š STATUS
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
   ðŸ” STATE
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
   ðŸ–¼ï¸ IMAGE (FIXED âœ…)
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
   âŒ CLOSE TICKET
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