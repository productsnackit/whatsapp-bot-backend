/* =========================================================
    WHATSAPP DELIVERY FOLLOW-UP (refillers)
    WhatsApp often accepts a message and only reports a few seconds later that
    it failed, e.g. error 131047 when the person hasn't messaged us in the last
    24 hours. Messages to refillers (CAPA tasks, refill reminders) are noted
    here so that when such a failure arrives on the webhook, the approved
    template is sent instead (if one is set up), or the task on the dashboard
    shows why it wasn't delivered. Delivered / read ticks are passed on too.
========================================================= */
import { sendWhatsAppTemplate } from "./whatsapp.js";

export const REENGAGEMENT_ERROR = 131047;
let db = null;
const handlers = {};

export async function ensureWhatsAppOutbox(database) {
  db = database;
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_outbox (
      wa_message_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ref_ids INTEGER[] NOT NULL DEFAULT '{}',
      to_phone TEXT NOT NULL,
      template JSONB,
      no_window_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query("DELETE FROM wa_outbox WHERE created_at < NOW() - INTERVAL '7 days'");
  // When each number (refiller, Xavier, anyone) last messaged us: WhatsApp's 24-hour window.
  await db.query("CREATE TABLE IF NOT EXISTS wa_inbound (phone TEXT PRIMARY KEY, last_at TIMESTAMPTZ NOT NULL)");
}

const digitsOf = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

// Called by the webhook for every message anyone sends us.
export async function noteInbound(phone) {
  const key = digitsOf(phone);
  if (!db || !key) return;
  await db.query(
    "INSERT INTO wa_inbound (phone, last_at) VALUES ($1, NOW()) ON CONFLICT (phone) DO UPDATE SET last_at = NOW()",
    [key]
  ).catch(() => {});
}
export const noteRefillerMessage = noteInbound;

// True only when we know the number messaged us in the last 23½ hours (a little margin).
// Otherwise a normal message would be dropped by WhatsApp, so the approved template is used.
export async function refillerWindowOpen(phone) {
  if (!db) return false;
  const { rows } = await db.query("SELECT last_at FROM wa_inbound WHERE phone = $1", [digitsOf(phone)]).catch(() => ({ rows: [] }));
  return Boolean(rows[0] && Date.now() - new Date(rows[0].last_at).getTime() < 23.5 * 3600000);
}

// kind: "capa" or "refill"; handler({ refIds, ok, status, error, viaTemplate }) updates their rows.
export function onDeliveryUpdate(kind, handler) {
  handlers[kind] = handler;
}

function sendTemplate(to, template) {
  return sendWhatsAppTemplate(to, template.name, template.lang || "en", template.params || [], template.buttons || []);
}

async function remember(result, { kind, refIds, to, template, noWindowError }) {
  if (!db || !result.ok || !result.id) return;
  await db.query(
    `INSERT INTO wa_outbox (wa_message_id, kind, ref_ids, to_phone, template, no_window_error) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [result.id, kind, refIds, to, template ? JSON.stringify(template) : null, noWindowError || null]
  ).catch((err) => console.log("WA OUTBOX SAVE ERROR:", err.message));
}

// Sends a free-form message; if WhatsApp refuses it straight away for the 24-hour rule, the
// template goes instead. Either way the message is remembered for its later delivery status.
// template: { name, lang, params, buttons } or null when none is set up.
// When the refiller hasn't messaged us in 24 hours (or we don't know), a normal message would
// be dropped, so the template goes first; only if the template itself fails is the normal one tried.
export async function sendWithFallback({ kind, refIds = [], to, send, template = null, noWindowError }) {
  if (template && !(await refillerWindowOpen(to))) {
    const viaTemplate = await sendTemplate(to, template);
    if (viaTemplate.ok) {
      await remember(viaTemplate, { kind, refIds, to, template: null, noWindowError });
      return { ...viaTemplate, viaTemplate: true };
    }
    console.log(`WhatsApp template "${template.name}" to ${to} failed, trying a normal message:`, viaTemplate.error);
    const plain = await send();
    if (plain.ok) {
      await remember(plain, { kind, refIds, to, template: null, noWindowError });
      return plain;
    }
    return { ...plain, error: plain.code === REENGAGEMENT_ERROR ? `Template "${template.name}" failed: ${viaTemplate.error}` : plain.error };
  }
  let result = await send();
  if (!result.ok && result.code === REENGAGEMENT_ERROR) {
    if (!template) return { ...result, error: noWindowError || result.error };
    result = await sendTemplate(to, template);
    if (!result.ok) result.error = `Template "${template.name}" failed: ${result.error}`;
    else await remember(result, { kind, refIds, to, template: null, noWindowError });
    return { ...result, viaTemplate: true };
  }
  await remember(result, { kind, refIds, to, template, noWindowError });
  return result;
}

// Called with the webhook's "statuses" list.
export async function applyOutboxStatuses(statuses = []) {
  if (!db) return;
  for (const update of statuses) {
    try {
      if (!update?.id || !update.status) continue;
      const { rows } = await db.query("SELECT * FROM wa_outbox WHERE wa_message_id = $1", [update.id]);
      const sent = rows[0];
      if (!sent) continue;
      const notify = (outcome) => Promise.resolve(handlers[sent.kind]?.({ refIds: sent.ref_ids, ...outcome })).catch((err) => console.log("WA OUTBOX HANDLER ERROR:", err.message));

      if (update.status === "failed") {
        await db.query("DELETE FROM wa_outbox WHERE wa_message_id = $1", [update.id]);
        const problem = update.errors?.[0] || {};
        const noWindow = Number(problem.code) === REENGAGEMENT_ERROR;
        if (noWindow && sent.template) {
          const retry = await sendTemplate(sent.to_phone, sent.template);
          if (retry.ok) {
            await remember(retry, { kind: sent.kind, refIds: sent.ref_ids, to: sent.to_phone, template: null, noWindowError: sent.no_window_error });
            await notify({ ok: true, status: "sent", viaTemplate: true });
          } else {
            await notify({ ok: false, error: `Template "${sent.template.name}" failed: ${retry.error}` });
          }
        } else {
          const reason = noWindow
            ? sent.no_window_error || "Not delivered: they haven't messaged the Snackit WhatsApp number in the last 24 hours."
            : problem.error_data?.details || problem.title || problem.message || "Not delivered";
          console.log(`WhatsApp to ${sent.to_phone} not delivered (${sent.kind}):`, reason);
          await notify({ ok: false, error: reason });
        }
      } else if (update.status === "delivered" || update.status === "read") {
        await notify({ ok: true, status: update.status });
        if (update.status === "read") await db.query("DELETE FROM wa_outbox WHERE wa_message_id = $1", [update.id]);
      }
    } catch (err) {
      console.log("WA OUTBOX STATUS ERROR:", err.message);
    }
  }
}
