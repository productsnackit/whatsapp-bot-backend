/* =========================================================
    TICKET CHAT (admin takeover)
    Customers and admins can both share photos, videos, documents and
    voice notes. Files are kept on Cloudinary so the dashboard can show
    them; WhatsApp delivery ticks (sent / delivered / read) are tracked
    per message, and admins get quick replies and a push when a customer
    answers a ticket they have taken over.
========================================================= */
import axios from "axios";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";
import { sendWhatsAppPayload } from "./whatsapp.js";

const GRAPH = "https://graph.facebook.com/v19.0";
const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const WHATSAPP_IMAGE_BYTES = 5 * 1024 * 1024;

export async function ensureTicketChatSchema(db) {
  await db.query(`
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS media_url TEXT,
      ADD COLUMN IF NOT EXISTS media_type TEXT,
      ADD COLUMN IF NOT EXISTS file_name TEXT,
      ADD COLUMN IF NOT EXISTS mime_type TEXT,
      ADD COLUMN IF NOT EXISTS wa_message_id TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS error TEXT,
      ADD COLUMN IF NOT EXISTS sent_by TEXT
  `);
  await db.query("CREATE INDEX IF NOT EXISTS messages_wa_message_id_idx ON messages (wa_message_id)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_quick_replies (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
      created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const { rows } = await db.query("SELECT COUNT(*)::int AS count FROM support_quick_replies");
  if (!rows[0].count) {
    const starters = [
      ["Greeting", "Hi, this is the Snackit support team. I'm looking into your request now."],
      ["Need screenshot", "Could you please share a screenshot of the payment from your UPI app? It helps us verify quickly."],
      ["Need machine photo", "Could you please share a photo of the machine and the product slot so we can check it?"],
      ["Refund processed", "Your refund has been processed. It usually reaches your account within 24 hours."],
      ["Closing", "Thank you for reaching out to Snackit. Is there anything else we can help you with?"],
    ];
    for (const [title, text] of starters) {
      await db.query("INSERT INTO support_quick_replies (title, text, created_by) VALUES ($1, $2, 'system')", [title, text]);
    }
  }
}

function uploadBuffer(buffer, { resourceType = "auto", fileName } = {}) {
  return new Promise((resolve, reject) => {
    const options = { resource_type: resourceType, folder: "snackit-support" };
    // Documents keep their original name (and extension) so they download correctly.
    if (resourceType === "raw" && fileName) {
      options.public_id = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
    }
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => (err ? reject(err) : resolve(result.secure_url)));
    stream.end(buffer);
  });
}

// Pictures and videos/voice notes use Cloudinary's media types; documents (including
// PDFs, which many Cloudinary accounts block as images) are stored as plain files.
function resourceTypeFor(kind) {
  if (kind === "image" || kind === "sticker") return "image";
  if (kind === "video" || kind === "audio") return "video";
  return "raw";
}

/* ---------- Customer → us ---------- */

// Downloads a WhatsApp media message and keeps a copy on Cloudinary.
// Returns null for plain text; never throws (the bot must keep working).
export async function storeIncomingMedia(msg) {
  const kind = msg?.type;
  if (!["image", "video", "document", "audio", "sticker"].includes(kind)) return null;
  const media = msg[kind] || {};
  const result = {
    kind,
    caption: media.caption || "",
    fileName: media.filename || null,
    mimeType: media.mime_type || null,
    graphUrl: null,
    url: null,
  };
  try {
    if (!media.id) return result;
    const meta = await axios.get(`${GRAPH}/${media.id}`, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    result.graphUrl = meta.data?.url || null;
    result.mimeType = result.mimeType || meta.data?.mime_type || null;
    if (!result.graphUrl) return result;
    const file = await axios.get(result.graphUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      timeout: 30000,
    });
    result.url = await uploadBuffer(Buffer.from(file.data), { resourceType: resourceTypeFor(kind), fileName: result.fileName });
  } catch (err) {
    console.log("INCOMING MEDIA ERROR:", err.response?.data || err.message);
  }
  return result;
}

export async function saveTicketMessage(db, { ticketId, sender, text = "", mediaUrl = null, mediaType = null, fileName = null, mimeType = null, waMessageId = null, status = null, error = null, sentBy = null }) {
  if (!ticketId) return null;
  try {
    const { rows } = await db.query(
      `INSERT INTO messages (ticket_id, sender, message, media_url, media_type, file_name, mime_type, wa_message_id, status, error, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [ticketId, sender, text, mediaUrl, mediaType, fileName, mimeType, waMessageId, status, error, sentBy]
    );
    return rows[0];
  } catch (err) {
    console.error("SAVE TICKET MESSAGE ERROR:", err.message);
    return null;
  }
}

// WhatsApp reports sent → delivered → read (or failed) for messages we sent.
export async function applyStatusUpdates(db, statuses = []) {
  for (const update of statuses) {
    try {
      if (!update?.id || !update.status) continue;
      if (update.status === "failed") {
        const reason = update.errors?.[0]?.error_data?.details || update.errors?.[0]?.title || "Not delivered";
        await db.query("UPDATE messages SET status = 'failed', error = $2 WHERE wa_message_id = $1", [update.id, reason]);
        continue;
      }
      const rank = STATUS_RANK[update.status];
      if (rank === undefined) continue;
      // Only move forward: a late "delivered" never overwrites "read".
      await db.query(
        `UPDATE messages SET status = $2
         WHERE wa_message_id = $1
           AND COALESCE(status, 'sending') <> 'failed'
           AND COALESCE(CASE status WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 END, 0) < $3`,
        [update.id, update.status, rank]
      );
    } catch (err) {
      console.log("STATUS UPDATE ERROR:", err.message);
    }
  }
}

/* ---------- Us → customer ---------- */

function kindForMime(mime) {
  if (/^image\//.test(mime)) return "image";
  if (/^video\//.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  return "document";
}

// WhatsApp only accepts JPEG/PNG photos up to 5 MB, so other pictures are converted.
async function prepareOutgoingImage(buffer, mime) {
  if (["image/jpeg", "image/png"].includes(mime) && buffer.length <= WHATSAPP_IMAGE_BYTES) return { buffer, mime };
  const converted = await sharp(buffer).rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { buffer: converted, mime: "image/jpeg" };
}

function whatsappError(result) {
  if (result.ok) return null;
  if (result.code === 131047) return "More than 24 hours since the customer's last message. WhatsApp only delivers replies within 24 hours; ask them to message you first.";
  return result.error || "WhatsApp could not send this message";
}

async function sendText(phone, text) {
  return sendWhatsAppPayload({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: text, preview_url: true } });
}

async function sendMedia(phone, kind, link, { caption, fileName }) {
  const media = { link };
  if (caption && kind !== "audio") media.caption = caption.slice(0, 1024);
  if (kind === "document" && fileName) media.filename = fileName;
  return sendWhatsAppPayload({ messaging_product: "whatsapp", to: phone, type: kind, [kind]: media });
}

function userName(req) {
  if (req.user?.name) return req.user.name;
  return req.user?.role === "admin" ? "Admin" : req.user?.username || "Support";
}

export function registerTicketChatRoutes(app, { db, auth }) {
  // Admin reply: text and/or files ({ name, type, data: base64 }). Each file is its own WhatsApp message.
  app.post("/admin/tickets/:id/send", auth, async (req, res) => {
    try {
      const ticketId = Number(req.params.id);
      const { rows } = await db.query("SELECT id, phone FROM tickets WHERE id = $1", [ticketId]);
      const ticket = rows[0];
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      const text = String(req.body?.text || "").trim();
      const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 10) : [];
      if (!text && !files.length) return res.status(400).json({ error: "Type a message or attach a file" });

      const sentBy = userName(req);
      const saved = [];

      // With exactly one photo/video, the text goes as its caption (like WhatsApp does).
      const captionOnFile = files.length === 1 && ["image", "video", "document"].includes(kindForMime(files[0].type)) && text.length <= 1024;

      if (text && !captionOnFile) {
        const result = await sendText(ticket.phone, text);
        saved.push(await saveTicketMessage(db, {
          ticketId, sender: "admin", text, sentBy,
          waMessageId: result.id, status: result.ok ? "sent" : "failed", error: whatsappError(result),
        }));
      }

      for (const file of files) {
        const fileName = String(file.name || "file").slice(0, 150);
        let mime = String(file.type || "application/octet-stream");
        let buffer = Buffer.from(String(file.data || "").replace(/^data:[^,]+,/, ""), "base64");
        if (!buffer.length) continue;
        if (buffer.length > MAX_UPLOAD_BYTES) {
          saved.push(await saveTicketMessage(db, { ticketId, sender: "admin", text: `📎 ${fileName}`, sentBy, status: "failed", error: "File is larger than 15 MB" }));
          continue;
        }
        const kind = kindForMime(mime);
        if (kind === "image") ({ buffer, mime } = await prepareOutgoingImage(buffer, mime));
        const url = await uploadBuffer(buffer, { resourceType: resourceTypeFor(kind), fileName });
        const caption = captionOnFile ? text : "";
        const result = await sendMedia(ticket.phone, kind, url, { caption, fileName });
        saved.push(await saveTicketMessage(db, {
          ticketId, sender: "admin", text: caption, sentBy,
          mediaUrl: url, mediaType: kind, fileName, mimeType: mime,
          waMessageId: result.id, status: result.ok ? "sent" : "failed", error: whatsappError(result),
        }));
      }

      await db.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
      const failed = saved.filter((message) => message?.status === "failed");
      res.json({ messages: saved.filter(Boolean), error: failed.length ? failed[0].error : null });
    } catch (err) {
      console.log("TICKET SEND ERROR:", err.message);
      res.status(500).json({ error: `Could not send: ${err.message}` });
    }
  });

  // Resend a message that WhatsApp did not deliver.
  app.post("/admin/tickets/:id/messages/:messageId/retry", auth, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT m.*, t.phone FROM messages m JOIN tickets t ON t.id = m.ticket_id
         WHERE m.id = $1 AND m.ticket_id = $2 AND m.sender = 'admin'`,
        [req.params.messageId, req.params.id]
      );
      const message = rows[0];
      if (!message) return res.status(404).json({ error: "Message not found" });
      const result = message.media_url
        ? await sendMedia(message.phone, message.media_type, message.media_url, { caption: message.message, fileName: message.file_name })
        : await sendText(message.phone, message.message);
      const updated = await db.query(
        "UPDATE messages SET wa_message_id = $2, status = $3, error = $4, created_at = NOW() WHERE id = $1 RETURNING *",
        [message.id, result.id, result.ok ? "sent" : "failed", whatsappError(result)]
      );
      res.json({ message: updated.rows[0], error: whatsappError(result) });
    } catch (err) {
      res.status(500).json({ error: `Could not resend: ${err.message}` });
    }
  });

  app.get("/admin/quick-replies", auth, async (req, res) => {
    const { rows } = await db.query("SELECT id, title, text FROM support_quick_replies ORDER BY title");
    res.json(rows);
  });

  app.post("/admin/quick-replies", auth, async (req, res) => {
    const title = String(req.body?.title || "").trim().slice(0, 60);
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    if (!title || !text) return res.status(400).json({ error: "Title and text are required" });
    const { rows } = await db.query(
      "INSERT INTO support_quick_replies (title, text, created_by) VALUES ($1, $2, $3) RETURNING id, title, text",
      [title, text, userName(req)]
    );
    res.json(rows[0]);
  });

  app.delete("/admin/quick-replies/:id", auth, async (req, res) => {
    await db.query("DELETE FROM support_quick_replies WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  });
}
