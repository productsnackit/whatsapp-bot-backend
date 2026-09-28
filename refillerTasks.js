/* =========================================================
    CAPA TASKS OVER WHATSAPP
    Each CAPA ticket is sent to its refiller from the customer care number
    with "Yes, resolved" / "Not yet" / "Can't do it" buttons. Their answer
    updates the ticket. Messages from refiller numbers never reach the
    customer bot (no refund menu).

    "Can't do it" escalates the task: the people set up for that kind of
    issue (Admin Settings → CAPA escalation, e.g. Xavier for machine faults)
    get the task, machine ID, location and issue on WhatsApp, and can tap
    "Yes, resolved" once it's fixed. The refiller can reply with a reason,
    which is passed on to them.

    WhatsApp only allows free-form messages within 24 hours of the person's
    last message to us. For anything older, set CAPA_TEMPLATE_NAME (and optionally
    CAPA_TEMPLATE_LANG, default "en") to a Meta-approved template whose body has
    {{1}} task ref, {{2}} location, {{3}} issue, and two quick-reply buttons:
    first "Yes, resolved", second "Not yet".
========================================================= */
import { sendWhatsApp, sendWhatsAppButtons } from "./whatsapp.js";
import { handleRefillMessage, sendRefillSummary } from "./refillSchedule.js";
import { sendWithFallback, onDeliveryUpdate, noteRefillerMessage } from "./whatsappOutbox.js";

let pushToAuditTeam = null;

// "+91 91106 23553", "9110623553" and "919110623553" all become "919110623553".
export function phoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

// Phone notifications to the Refill Audit team when a refiller can't do a task.
export function setCapaEscalationPush(fn) {
  pushToAuditTeam = fn;
}

export async function ensureCapaWhatsAppColumns(db) {
  await db.query(`
    ALTER TABLE audit_capa
      ADD COLUMN IF NOT EXISTS refiller_phone TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_status TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_error TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refiller_reply TEXT,
      ADD COLUMN IF NOT EXISTS refiller_replied_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS whatsapp_delivery TEXT,
      ADD COLUMN IF NOT EXISTS issue_key TEXT,
      ADD COLUMN IF NOT EXISTS issue_category TEXT,
      ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS escalated_to TEXT,
      ADD COLUMN IF NOT EXISTS escalation_error TEXT,
      ADD COLUMN IF NOT EXISTS escalation_note TEXT,
      ADD COLUMN IF NOT EXISTS note_open_until TIMESTAMPTZ
  `);
  // Who gets a task a refiller can't do, by kind of issue (checklist item keys; texts match older tasks).
  await db.query(`
    CREATE TABLE IF NOT EXISTS capa_escalation_contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      all_issues BOOLEAN NOT NULL DEFAULT FALSE,
      issue_keys TEXT[] NOT NULL DEFAULT '{}',
      issue_texts TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // WhatsApp reports delivery (or a late failure) a few seconds after sending.
  onDeliveryUpdate("capa", async ({ refIds, ok, status, error }) => {
    if (!ok) {
      await db.query("UPDATE audit_capa SET whatsapp_status = 'FAILED', whatsapp_error = $2, whatsapp_delivery = NULL WHERE id = ANY($1)", [refIds, error]);
    } else if (status === "delivered" || status === "read") {
      await db.query(
        "UPDATE audit_capa SET whatsapp_delivery = $2 WHERE id = ANY($1) AND (whatsapp_delivery IS NULL OR $2 = 'read')",
        [refIds, status]
      );
    }
  });
  onDeliveryUpdate("capa_escalation", async ({ refIds, ok, error }) => {
    if (!ok) await db.query("UPDATE audit_capa SET escalation_error = $2 WHERE id = ANY($1)", [refIds, error]);
  });
}

function taskButtons(id) {
  return [
    { id: `CAPA_YES:${id}`, title: "Yes, resolved" },
    { id: `CAPA_NO:${id}`, title: "Not yet" },
    { id: `CAPA_CANT:${id}`, title: "Can't do it" },
  ];
}

// The approved template has only the first two buttons.
function templateFor(ticket, issue = ticket.defect, location = ticket.location) {
  if (!process.env.CAPA_TEMPLATE_NAME) return null;
  return {
    name: process.env.CAPA_TEMPLATE_NAME,
    lang: process.env.CAPA_TEMPLATE_LANG || "en",
    // Template values can't contain line breaks.
    params: [ticket.ref, location, issue].map((value) => String(value || "-").replace(/\s+/g, " ").trim().slice(0, 900)),
    buttons: taskButtons(ticket.id).slice(0, 2).map((button) => button.id),
  };
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
    "If you can't fix it yourself, tap \"Can't do it\".",
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
    // Without an approved template, WhatsApp only delivers to someone who messaged us in the last 24 hours.
    result = await sendWithFallback({
      kind: "capa",
      refIds: [ticket.id],
      to,
      send: () => sendWhatsAppButtons(to, taskMessage(ticket), taskButtons(ticket.id)),
      template: templateFor(ticket),
      noWindowError: `${ticket.refiller || "The refiller"} hasn't messaged the Snackit WhatsApp number in the last 24 hours, so WhatsApp didn't deliver it. Ask them to send "Hi" to the number, then press Resend.`,
    });
  }

  await db.query(
    `UPDATE audit_capa SET refiller_phone = $2, whatsapp_status = $3, whatsapp_error = $4, whatsapp_delivery = NULL,
       whatsapp_sent_at = CASE WHEN $3 = 'SENT' THEN NOW() ELSE whatsapp_sent_at END
     WHERE id = $1`,
    [ticket.id, to || null, result.ok ? "SENT" : "FAILED", result.ok ? null : result.error]
  );
  return result;
}

async function findRefiller(db, from) {
  const phone = phoneDigits(from);
  const { rows } = await db.query("SELECT name, phone FROM audit_refillers WHERE phone IS NOT NULL AND phone <> ''");
  // Only numbers in the Refillers list; anyone removed from it is a normal customer again.
  const refiller = rows.find((row) => phoneDigits(row.phone) === phone);
  return refiller ? { name: refiller.name, phone } : null;
}

async function pendingTasks(db, phone) {
  const { rows } = await db.query(
    "SELECT * FROM audit_capa WHERE refiller_phone = $1 AND status = 'OPEN' AND whatsapp_status = 'SENT' AND escalated_at IS NULL ORDER BY created_at",
    [phone]
  );
  return rows;
}

/* ---------- "Can't do it": escalation ---------- */

// People set up for this kind of issue; if nobody is, those who take "all other issues".
async function contactsFor(db, ticket) {
  const { rows } = await db.query("SELECT * FROM capa_escalation_contacts ORDER BY id");
  const defect = String(ticket.defect || "").toLowerCase();
  const specific = rows.filter((contact) => !contact.all_issues && (
    (ticket.issue_key && contact.issue_keys.includes(ticket.issue_key))
    || contact.issue_texts.some((text) => text && defect.startsWith(text.toLowerCase()))
  ));
  return specific.length ? specific : rows.filter((contact) => contact.all_issues);
}

async function machineOf(db, ticket) {
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(a.machine_code, ''), l.machine_code) AS machine
     FROM audit_capa c LEFT JOIN audits a ON a.id = c.audit_id LEFT JOIN audit_locations l ON LOWER(l.name) = LOWER(c.location)
     WHERE c.id = $1`,
    [ticket.id]
  );
  return rows[0]?.machine || null;
}

const prettyPhone = (phone) => {
  const digits = phoneDigits(phone);
  return digits.length === 12 ? `+${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}` : phone;
};

function escalationMessage(ticket, refiller, machine) {
  return [
    "🆘 *Refill task needs help*",
    "",
    `Task: ${ticket.ref}`,
    `🏷 Machine ID: ${machine || "not recorded"}`,
    `📍 Location: ${ticket.location}`,
    `⚠️ Issue: ${ticket.defect}`,
    `Priority: ${ticket.severity}`,
    "",
    `${refiller.name || "The refiller"} (${prettyPhone(refiller.phone)}) can't fix this at the machine. Please arrange it, then tap "Yes, resolved".`,
  ].join("\n");
}

async function escalateTask(db, refiller, ticket) {
  const [contacts, machine] = await Promise.all([contactsFor(db, ticket), machineOf(db, ticket)]);
  const names = contacts.map((contact) => contact.name).join(", ");
  const errors = [];
  for (const contact of contacts) {
    const to = phoneDigits(contact.phone);
    const result = await sendWithFallback({
      kind: "capa_escalation",
      refIds: [ticket.id],
      to,
      send: () => sendWhatsAppButtons(to, escalationMessage(ticket, refiller, machine), [{ id: `CAPA_YES:${ticket.id}`, title: "Yes, resolved" }]),
      template: templateFor(ticket, `${ticket.defect} - ${refiller.name || "the refiller"} can't do it, please arrange`, `${ticket.location}${machine ? ` (machine ${machine})` : ""}`),
      noWindowError: `${contact.name} hasn't messaged the Snackit WhatsApp number in the last 24 hours, so WhatsApp didn't deliver it.`,
    });
    if (!result.ok) errors.push(`${contact.name}: ${result.error}`);
  }
  const error = contacts.length ? errors.join("; ") || null : "Nobody is set up for this kind of issue (Admin Settings → CAPA escalation).";
  await db.query(
    `UPDATE audit_capa SET refiller_reply = 'CANT_DO', refiller_replied_at = NOW(), escalated_at = NOW(), escalated_to = $2,
       escalation_error = $3, escalation_note = NULL, note_open_until = NOW() + INTERVAL '30 minutes'
     WHERE id = $1`,
    [ticket.id, names || null, error]
  );
  if (pushToAuditTeam) {
    pushToAuditTeam({
      title: `🆘 ${refiller.name || "Refiller"} can't fix ${ticket.ref}`,
      body: `${ticket.location}${machine ? ` · ${machine}` : ""} · ${ticket.defect}`.slice(0, 180) + (names ? ` · sent to ${names}` : ""),
      view: "audit",
    });
  }
  await sendWhatsApp(refiller.phone, [
    `Noted, ${refiller.name || "thank you"}. ${ticket.ref} at ${ticket.location} ${names ? `has been sent to ${names}` : "has been sent to your supervisor"}.`,
    "",
    "If you like, reply with what's stopping you (for example: needs a technician, spare part missing) and we'll pass it on.",
  ].join("\n"));
}

// The refiller's reason after "Can't do it" goes on the task and to the people it was sent to.
async function saveEscalationNote(db, refiller, ticket, note) {
  await db.query("UPDATE audit_capa SET escalation_note = $2, note_open_until = NULL WHERE id = $1", [ticket.id, note.slice(0, 500)]);
  const contacts = await contactsFor(db, ticket);
  for (const contact of contacts) {
    await sendWhatsApp(phoneDigits(contact.phone), `Note from ${refiller.name || "the refiller"} on ${ticket.ref} (${ticket.location}):\n\n"${note.slice(0, 500)}"`);
  }
  await sendWhatsApp(refiller.phone, `Thank you. Your note has been added to ${ticket.ref}${contacts.length ? ` and sent to ${contacts.map((contact) => contact.name).join(", ")}` : ""}.`);
}

async function answerTask(db, refiller, ticket, resolved) {
  if (resolved) {
    await db.query(
      `UPDATE audit_capa SET status = 'RESOLVED', resolved_by = $2, resolved_at = NOW(),
         refiller_reply = 'RESOLVED', refiller_replied_at = NOW(), note_open_until = NULL WHERE id = $1`,
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
      `Noted. ${ticket.ref} at ${ticket.location} is still open.\n\nPlease fix it and tap "Yes, resolved" when it's done. If you can't fix it yourself, tap "Can't do it" and it goes to the right person.`,
      [{ id: `CAPA_YES:${ticket.id}`, title: "Yes, resolved" }, { id: `CAPA_CANT:${ticket.id}`, title: "Can't do it" }]
    );
  }
}

// An escalation contact (e.g. Xavier) tapping "Yes, resolved" / "Not yet" on a task sent to them.
async function handleContactReply(db, msg) {
  const buttonId = msg?.interactive?.button_reply?.id || msg?.button?.payload || "";
  const tapped = buttonId.match(/^CAPA_(YES|NO|CANT):(\d+)$/);
  if (!tapped) return false;
  const phone = phoneDigits(msg.from);
  const { rows: contacts } = await db.query("SELECT name, phone FROM capa_escalation_contacts");
  const contact = contacts.find((row) => phoneDigits(row.phone) === phone);
  if (!contact) return false;
  const { rows } = await db.query("SELECT * FROM audit_capa WHERE id = $1", [tapped[2]]);
  const ticket = rows[0];
  if (!ticket) {
    await sendWhatsApp(phone, "That task could not be found. It may have been removed.");
  } else if (tapped[1] === "YES") {
    if (ticket.status !== "RESOLVED") {
      await db.query(
        "UPDATE audit_capa SET status = 'RESOLVED', resolved_by = $2, resolved_at = NOW(), note_open_until = NULL WHERE id = $1",
        [ticket.id, `${contact.name} (WhatsApp)`]
      );
      if (ticket.refiller_phone) await sendWhatsApp(ticket.refiller_phone, `${ticket.ref} at ${ticket.location} was fixed by ${contact.name}. Thank you!`);
    }
    await sendWhatsApp(phone, `Thank you, ${contact.name}! ${ticket.ref} at ${ticket.location} is marked as resolved.`);
  } else {
    await sendWhatsApp(phone, `Noted. ${ticket.ref} at ${ticket.location} is still open. Tap "Yes, resolved" on the task once it's fixed.`);
  }
  return true;
}

// Returns true when the sender is a refiller (or an escalation contact answering a task): the
// message is handled here and must not reach the customer bot.
export async function handleRefillerWhatsApp(db, msg) {
  const refiller = await findRefiller(db, msg?.from);
  if (!refiller) return handleContactReply(db, msg);
  // Opens WhatsApp's 24-hour window: normal messages reach them until then.
  await noteRefillerMessage(refiller.phone);

  const buttonId = msg.interactive?.button_reply?.id || msg.button?.payload || "";
  const tapped = buttonId.match(/^CAPA_(YES|NO|CANT):(\d+)$/);
  if (tapped) {
    const { rows } = await db.query("SELECT * FROM audit_capa WHERE id = $1 AND refiller_phone = $2", [tapped[2], refiller.phone]);
    const ticket = rows[0];
    if (!ticket) {
      await sendWhatsApp(refiller.phone, "That task could not be found. It may have been removed.");
    } else if (ticket.status === "RESOLVED") {
      await sendWhatsApp(refiller.phone, `${ticket.ref} is already marked as resolved${ticket.resolved_by ? ` by ${ticket.resolved_by.replace(" (WhatsApp)", "")}` : ""}. Thank you!`);
    } else if (tapped[1] === "CANT") {
      if (ticket.escalated_at) await sendWhatsApp(refiller.phone, `${ticket.ref} has already been sent to ${ticket.escalated_to || "your supervisor"}. Thank you!`);
      else await escalateTask(db, refiller, ticket);
    } else {
      await answerTask(db, refiller, ticket, tapped[1] === "YES");
    }
    return true;
  }

  // Refill proof: machine photos and the site they pick from the list.
  if (await handleRefillMessage(msg, refiller)) return true;

  const rawText = String(msg.text?.body || msg.button?.text || "").trim();
  const text = rawText.toLowerCase();
  const saidYes = /^(yes|y|done|resolved|fixed|ok done|haan|ha)\b/.test(text);
  const saidNo = /^(no|n|not yet|nahi|nope)\b/.test(text);

  // A reason typed after "Can't do it".
  const { rows: awaitingNote } = await db.query(
    "SELECT * FROM audit_capa WHERE refiller_phone = $1 AND note_open_until > NOW() AND escalation_note IS NULL ORDER BY escalated_at DESC LIMIT 1",
    [refiller.phone]
  );
  if (awaitingNote[0] && rawText && !saidYes && !saidNo && msg.type === "text") {
    await saveEscalationNote(db, refiller, awaitingNote[0], rawText);
    return true;
  }

  const pending = await pendingTasks(db, refiller.phone);
  if (pending.length && (saidYes || saidNo)) {
    await answerTask(db, refiller, pending[0], saidYes);
  } else {
    // Anything else: today's refill visits, then the oldest open CAPA task so they can tap an answer.
    const summary = await sendRefillSummary(refiller);
    if (pending.length) {
      await sendWhatsAppButtons(
        refiller.phone,
        `You have ${pending.length} open task${pending.length === 1 ? "" : "s"}.\n\n${taskMessage(pending[0])}`,
        taskButtons(pending[0].id)
      );
    } else if (!summary) {
      await sendWhatsApp(refiller.phone, `Hi ${refiller.name || ""}, you have no open Snackit tasks right now. Thank you!`.replace("Hi ,", "Hi,"));
    }
  }
  return true;
}
