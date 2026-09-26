/* =========================================================
    IMAGE CLEAN-UP (keeps Cloudinary within the free plan)
    Photos are deleted from Cloudinary and removed from the dashboard after
    IMAGE_RETENTION_DAYS (default 10):
      - customer ticket photos, payment screenshots and ticket-chat media:
        10 days after the ticket is closed (open tickets keep everything);
      - refill proof photos: 10 days after the refill was sent, once it has
        been verified or rejected (a photo waiting for verification stays);
      - Refill Audit photos: 10 days after the audit.
    What was read from the photos (transaction ID, amount, scores) is kept.
========================================================= */
import { v2 as cloudinary } from "cloudinary";

const DAYS = Math.max(1, Number(process.env.IMAGE_RETENTION_DAYS) || 10);
const CLOSED_STATUSES = ["closed", "auto_closed", "resolved", "refunded", "auto_refunded"];

let db = null;
let running = false;

export async function ensureImageRetention(database) {
  db = database;
  await db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS images_deleted_at TIMESTAMPTZ");
  await db.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_deleted_at TIMESTAMPTZ");
  await db.query("ALTER TABLE refill_tasks ADD COLUMN IF NOT EXISTS photos_deleted_at TIMESTAMPTZ").catch(() => {});
  await db.query("ALTER TABLE audits ADD COLUMN IF NOT EXISTS photos_deleted_at TIMESTAMPTZ").catch(() => {});
}

// https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/[transforms/]v123/<public id>.<ext>
function cloudinaryAsset(url) {
  const match = String(url || "").match(/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:.*?\/)?v\d+\/(.+)$/);
  if (!match) return null;
  const [, type, file] = match;
  // Images and videos are addressed without their extension; raw files keep it.
  return { type, publicId: type === "raw" ? file : file.replace(/\.[a-z0-9]+$/i, "") };
}

async function destroyFiles(urls) {
  const byType = { image: [], video: [], raw: [] };
  for (const url of urls) {
    const asset = cloudinaryAsset(url);
    if (asset) byType[asset.type].push(asset.publicId);
  }
  let deleted = 0;
  for (const [type, ids] of Object.entries(byType)) {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        await cloudinary.api.delete_resources(batch, { resource_type: type });
        deleted += batch.length;
      } catch (err) {
        console.log(`IMAGE CLEAN-UP: Cloudinary ${type} delete failed:`, err.error?.message || err.message);
        throw err;
      }
    }
  }
  return deleted;
}

async function cleanTickets() {
  const { rows } = await db.query(
    `SELECT id, image, upi_image FROM tickets
     WHERE images_deleted_at IS NULL
       AND (image IS NOT NULL OR upi_image IS NOT NULL)
       AND (UPPER(COALESCE(state, '')) = 'CLOSED' OR LOWER(COALESCE(status, '')) = ANY($1))
       AND COALESCE(resolved_at, updated_at) < NOW() - ($2 * INTERVAL '1 day')
     LIMIT 200`,
    [CLOSED_STATUSES, DAYS]
  );
  let files = 0;
  for (const ticket of rows) {
    const media = await db.query("SELECT id, media_url FROM messages WHERE ticket_id = $1 AND media_url IS NOT NULL", [ticket.id]);
    const urls = [ticket.image, ticket.upi_image, ...media.rows.map((row) => row.media_url)].filter(Boolean);
    files += await destroyFiles(urls);
    await db.query("UPDATE tickets SET image = NULL, upi_image = NULL, images_deleted_at = NOW() WHERE id = $1", [ticket.id]);
    await db.query("UPDATE messages SET media_url = NULL, media_deleted_at = NOW() WHERE ticket_id = $1 AND media_url IS NOT NULL", [ticket.id]);
  }
  return { tickets: rows.length, files };
}

async function cleanRefillPhotos() {
  const { rows } = await db.query(
    `SELECT id, photos FROM refill_tasks
     WHERE photos_deleted_at IS NULL AND jsonb_array_length(COALESCE(photos, '[]'::jsonb)) > 0
       AND status <> 'done' AND completed_at < NOW() - ($1 * INTERVAL '1 day')
     LIMIT 300`,
    [DAYS]
  ).catch(() => ({ rows: [] }));
  let files = 0;
  for (const task of rows) {
    files += await destroyFiles((task.photos || []).map((photo) => photo.url));
    await db.query("UPDATE refill_tasks SET photos = '[]'::jsonb, photos_deleted_at = NOW() WHERE id = $1", [task.id]);
  }
  return { refills: rows.length, files };
}

async function cleanAuditPhotos() {
  const { rows } = await db.query(
    `SELECT id, photos FROM audits
     WHERE photos_deleted_at IS NULL AND jsonb_array_length(COALESCE(photos, '[]'::jsonb)) > 0
       AND created_at < NOW() - ($1 * INTERVAL '1 day')
     LIMIT 300`,
    [DAYS]
  ).catch(() => ({ rows: [] }));
  let files = 0;
  for (const audit of rows) {
    files += await destroyFiles(audit.photos || []);
    await db.query("UPDATE audits SET photos = '[]'::jsonb, photos_deleted_at = NOW() WHERE id = $1", [audit.id]);
  }
  return { audits: rows.length, files };
}

// Runs a few times a day; each run handles a batch, so a big backlog clears over a few runs.
export async function cleanOldImages() {
  if (!db || running) return null;
  running = true;
  try {
    const tickets = await cleanTickets();
    const refills = await cleanRefillPhotos();
    const audits = await cleanAuditPhotos();
    const files = tickets.files + refills.files + audits.files;
    if (tickets.tickets || refills.refills || audits.audits) {
      console.log(`🧹 Image clean-up: ${files} file(s) deleted · ${tickets.tickets} ticket(s), ${refills.refills} refill(s), ${audits.audits} audit(s)`);
    }
    return { files, tickets: tickets.tickets, refills: refills.refills, audits: audits.audits };
  } catch (err) {
    // Nothing is marked deleted when Cloudinary refused, so the next run tries again.
    console.log("IMAGE CLEAN-UP ERROR:", err.message);
    return null;
  } finally {
    running = false;
  }
}
