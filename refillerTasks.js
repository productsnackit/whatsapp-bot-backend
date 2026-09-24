/* =========================================================
    CAPA TASKS OVER WHATSAPP
    Each CAPA ticket is sent to its refiller from the customer care number
    with "Yes, resolved" / "Not yet" buttons. Their answer updates the ticket.
    Messages from refiller numbers never reach the customer bot (no refund menu).

    WhatsApp only allows free-form messages within 24 hours of the refiller's
    last message to us. For anything older, set CAPA_TEMPLATE_NAME (and optionally
    CAPA_TEMPLATE_LANG, default "en") to a Meta-approved template whose body has
    {{1}} task ref, {{2}} location, {{3}} issue, and two quick-reply buttons:
    first "Yes, resolved", second "Not yet".
========================================================= */
import { sendWhatsApp, sendWhatsAppButtons, sendWhatsAppTemplate } from "./whatsapp.js";

const REENGAGEMENT_ERROR = 131047;

// "+91 91106 23553", "9110623553" and "919110623553" all become "919110623553".
export function phoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

export async function ensureCapaWhatsAppColumns(db) {
  await db.query(`
    ALTER TABLE audit_capa
      ADD COLUMN IF NOT EXISTS refiller_phone TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_status TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_error TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refiller_reply TEXT,
      ADD COLUMN IF NOT EXISTS refiller_replied_at TIMESTAMPTZ
  `);
}

function taskButtons(id) {
  return [
    { id: `CAPA_YES:${id}`, title: "Yes, resolved" },
    { id: `CAPA_NO:${id}`, title: "Not yet" },
  ];
}

function taskMessage(ticket) {
  return [
    `*Snackit refill task ${ticket.ref}*`,
    "",
    `📍 Location: ${ticket.location}`,
    `⚠️ Issue: ${ticket.defect}`,
    `Priority: ${ticket.severity}`,
    "",
    "Please fix this at the machine. Is it resolved?",
  ].join("\n");
}

// Sends (or re-sends) one CAPA ticket to its refiller and records the outcome on the ticket.
export async function sendCapaToRefiller(db, capaId) {
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(NULLIF(c.refiller_phone, ''), a.refiller_phone, r.phone) AS phone
     FROM audit_capa c
     LEFT JOIN audits a ON a.id = c.audit_id
     LEFT JOIN audit_refillers r ON r.name = c.refiller
     WHERE c.id = $1`,
    [capaId]
  );
  const ticket = rows[0];
  if (!ticket) return { ok: false, error: "CAPA ticket not found" };

  const to = phoneDigits(ticket.phone);
  let result;
  if (!to) {
    result = { ok: false, error: `No phone number saved for ${ticket.refiller || "this refiller"}` };
  } else {
    result = await sendWhatsAppButtons(to, taskMessage(ticket), taskButtons(ticket.id));
    if (!result.ok && result.code === REENGAGEMENT_ERROR) {
      result = process.env.CAPA_TEMPLATE_NAME
        ? await sendWhatsAppTemplate(
            to,
            process.env.CAPA_TEMPLATE_NAME,
            process.env.CAPA_TEMPLATE_LANG || "en",
            [ticket.ref, ticket.location, ticket.defect],
            taskButtons(ticket.id).map((button) => button.id)
          )
        : { ok: false, error: "Refiller hasn't messaged the customer care number in the last 24 hours. Ask them to send \"Hi\" to it, then resend." };
    }
  }

  await db.query(
    `UPDATE audit_capa SET refiller_phone = $2, whatsapp_status = $3, whatsapp_error = $4,
       whatsapp_sent_at = CASE WHEN $3 = 'SENT' THEN NOW() ELSE whatsapp_sent_at END
     WHERE id = $1`,
    [ticket.id, to || null, result.ok ? "SENT" : "FAILED", result.ok ? null : result.error]
  );
  return result;
}

async function findRefiller(db, from) {
  const phone = phoneDigits(from);
  const { rows } = await db.query("SELECT name, phone FROM audit_refillers WHERE phone IS NOT NULL AND phone <> ''");
  const refiller = rows.find((row) => phoneDigits(row.phone) === phone);
  if (refiller) return { name: refiller.name, phone };
  // Someone who was sent a task directly (e.g. phone typed on the audit) also counts.
  const sent = await db.query("SELECT refiller FROM audit_capa WHERE refiller_phone = $1 LIMIT 1", [phone]);
  return sent.rows[0] ? { name: sent.rows[0].refiller, phone } : null;
}

async function pendingTasks(db, phone) {
  const { rows } = await db.query(
    "SELECT * FROM audit_capa WHERE refiller_phone = $1 AND status = 'OPEN' AND whatsapp_status = 'SENT' ORDER BY created_at",
    [phone]
  );
  return rows;
}

async function answerTask(db, refiller, ticket, resolved) {
  if (resolved) {
    await db.query(
      `UPDATE audit_capa SET status = 'RESOLVED', resolved_by = $2, resolved_at = NOW(),
         refiller_reply = 'RESOLVED', refiller_replied_at = NOW() WHERE id = $1`,
      [ticket.id, `${refiller.name || "Refiller"} (WhatsApp)`]
    );
    await sendWhatsApp(refiller.phone, `Thank you! ${ticket.ref} at ${ticket.location} is marked as resolved.`);
  } else {
    await db.query(
      "UPDATE audit_capa SET status = 'OPEN', refiller_reply = 'NOT_RESOLVED', refiller_replied_at = NOW() WHERE id = $1",
      [ticket.id]
    );
    await sendWhatsAppButtons(
      refiller.phone,
      `Noted. ${ticket.ref} at ${ticket.location} is still open.\n\nPlease fix it and tap "Yes, resolved" when it's done.`,
      [{ id: `CAPA_YES:${ticket.id}`, title: "Yes, resolved" }]
    );
  }
}

// Returns true when the sender is a refiller: the message is handled here and must not reach the customer bot.
export async function handleRefillerWhatsApp(db, msg) {
  const refiller = await findRefiller(db, msg?.from);
  if (!refiller) return false;

  const buttonId = msg.interactive?.button_reply?.id || msg.button?.payload || "";
  const tapped = buttonId.match(/^CAPA_(YES|NO):(\d+)$/);
  if (tapped) {
    const { rows } = await db.query("SELECT * FROM audit_capa WHERE id = $1 AND refiller_phone = $2", [tapped[2], refiller.phone]);
    if (!rows[0]) {
      await sendWhatsApp(refiller.phone, "That task could not be found. It may have been removed.");
    } else if (rows[0].status === "RESOLVED" && tapped[1] === "YES") {
      await sendWhatsApp(refiller.phone, `${rows[0].ref} is already marked as resolved. Thank you!`);
    } else {
      await answerTask(db, refiller, rows[0], tapped[1] === "YES");
    }
    return true;
  }

  const pending = await pendingTasks(db, refiller.phone);
  const text = String(msg.text?.body || msg.button?.text || "").trim().toLowerCase();
  const saidYes = /^(yes|y|done|resolved|fixed|ok done|haan|ha)\b/.test(text);
  const saidNo = /^(no|n|not yet|nahi|nope)\b/.test(text);

  if (pending.length && (saidYes || saidNo)) {
    await answerTask(db, refiller, pending[0], saidYes);
  } else if (pending.length) {
    // Anything else: show the oldest open task again so they can tap an answer.
    await sendWhatsAppButtons(
      refiller.phone,
      `You have ${pending.length} open task${pending.length === 1 ? "" : "s"}.\n\n${taskMessage(pending[0])}`,
      taskButtons(pending[0].id)
    );
  } else {
    await sendWhatsApp(refiller.phone, `Hi ${refiller.name || ""}, you have no open Snackit tasks right now. Thank you!`.replace("Hi ,", "Hi,"));
  }
  return true;
}
