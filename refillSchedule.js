/* =========================================================
    REFILL SCHEDULE
    Each site (Refill Audit → Locations) can have a refill schedule: which
    days and at what time its refiller must refill it. From the schedules,
    a task is created for every visit (14 days ahead). Refillers get a
    WhatsApp list of tomorrow's visits the evening before, and a nudge one
    hour before each visit. They prove a refill by sending a photo on
    WhatsApp and picking the site from their own assigned sites. Admins
    verify or reject each refill on the dashboard; a visit with no photo
    after the grace time is marked missed and admins are alerted.

    Times are India time (IST, UTC+5:30). Reminders outside WhatsApp's
    24-hour window use the Meta template REFILL_TEMPLATE_NAME (default
    "refill_reminder", language REFILL_TEMPLATE_LANG, default "en") whose
    body has {{1}} name, {{2}} number of visits, {{3}} when, {{4}} visits.
========================================================= */
import { sendWhatsAppPayload, sendWhatsAppList, sendWhatsAppTemplate } from "./whatsapp.js";
import { storeIncomingMedia } from "./ticketChat.js";
import { hasPage, accessFor } from "./accessControl.js";

const IST_MINUTES = 330;
const HORIZON_DAYS = 14;
const REENGAGEMENT_ERROR = 131047;
const DEFAULT_SETTINGS = { day_before_time: "19:00", hour_before_minutes: "60", grace_minutes: "120", reminders_enabled: "true" };
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const OPEN_STATUSES = ["scheduled", "missed", "rejected"];

let db = null;

// Plain text to a refiller (keeps emojis; the customer bot's sender strips some).
function sendWhatsApp(to, body) {
  return sendWhatsAppPayload({ messaging_product: "whatsapp", to, type: "text", text: { body: String(body).slice(0, 4096) } });
}
let pushToUsers = null;
let ticking = false;
let lastGenerated = 0;

/* ---------- Dates in India time ---------- */

export function istDate(date = new Date()) {
  return new Date(date.getTime() + IST_MINUTES * 60000).toISOString().slice(0, 10);
}
function istTime(date = new Date()) {
  return new Date(date.getTime() + IST_MINUTES * 60000).toISOString().slice(11, 16);
}
function istToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_MINUTES * 60000);
}
function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}
function prettyTime(time) {
  const [hh, mm] = time.split(":").map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
function prettyDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${date.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })}`;
}
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

// "+91 91106 23553", "9110623553" and "919110623553" all become "919110623553".
function phoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

/* ---------- Tables ---------- */

export async function ensureRefillTables(database, { sendPush } = {}) {
  db = database;
  pushToUsers = sendPush || null;
  await db.query(`
    CREATE TABLE IF NOT EXISTS refill_schedules (
      id SERIAL PRIMARY KEY,
      location_id INTEGER NOT NULL UNIQUE,
      refiller_id INTEGER,
      mode TEXT NOT NULL DEFAULT 'weekly',
      days INTEGER[] NOT NULL DEFAULT '{}',
      interval_days INTEGER,
      start_date TEXT,
      end_date TEXT,
      times TEXT[] NOT NULL DEFAULT '{}',
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS refill_tasks (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER,
      location_id INTEGER,
      location_name TEXT,
      machine_code TEXT,
      refiller_id INTEGER,
      refiller_name TEXT,
      refiller_phone TEXT,
      due_date TEXT NOT NULL,
      due_time TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      unscheduled BOOLEAN DEFAULT FALSE,
      notes TEXT,
      day_before_sent_at TIMESTAMPTZ,
      hour_before_sent_at TIMESTAMPTZ,
      reminder_error TEXT,
      photos JSONB DEFAULT '[]'::jsonb,
      completed_at TIMESTAMPTZ,
      minutes_late INTEGER,
      verified_by TEXT,
      verified_at TIMESTAMPTZ,
      reject_reason TEXT,
      rejected_count INTEGER DEFAULT 0,
      missed_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (schedule_id, due_date, due_time)
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS refill_tasks_due_idx ON refill_tasks (due_date)");
  await db.query("CREATE INDEX IF NOT EXISTS refill_tasks_phone_idx ON refill_tasks (refiller_phone, status)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS refill_photo_batches (
      refiller_phone TEXT PRIMARY KEY,
      photos JSONB NOT NULL DEFAULT '[]'::jsonb,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      list_sent BOOLEAN DEFAULT FALSE
    )
  `);
  await db.query("CREATE TABLE IF NOT EXISTS refill_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

async function getSettings() {
  const { rows } = await db.query("SELECT key, value FROM refill_settings");
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
}

/* ---------- Turning schedules into tasks ---------- */

function occursOn(schedule, date) {
  if (!schedule.active || !schedule.times?.length) return false;
  if (schedule.start_date && date < schedule.start_date) return false;
  if (schedule.end_date && date > schedule.end_date) return false;
  if (schedule.mode === "interval") {
    const every = Number(schedule.interval_days) || 1;
    const diff = daysBetween(schedule.start_date || date, date);
    return diff >= 0 && diff % every === 0;
  }
  return (schedule.days || []).includes(weekday(date));
}

// Creates the next 14 days of visits and keeps future visits in line with site/refiller changes.
export async function generateTasks({ force = false } = {}) {
  if (!force && Date.now() - lastGenerated < 10 * 60 * 1000) return;
  lastGenerated = Date.now();
  const today = istDate();
  const { rows: schedules } = await db.query(`
    SELECT s.*, l.name AS location_name, l.machine_code,
           r.id AS resolved_refiller_id, r.name AS refiller_name, r.phone AS refiller_phone
    FROM refill_schedules s
    JOIN audit_locations l ON l.id = s.location_id
    LEFT JOIN audit_refillers r ON r.id = COALESCE(s.refiller_id, l.refiller_id)
    WHERE s.active
  `);
  for (const schedule of schedules) {
    for (let offset = 0; offset < HORIZON_DAYS; offset += 1) {
      const date = addDays(today, offset);
      if (!occursOn(schedule, date)) continue;
      for (const time of schedule.times) {
        const dueAt = istToUtc(date, time);
        if (dueAt < new Date()) continue; // never create visits in the past
        await db.query(
          `INSERT INTO refill_tasks (schedule_id, location_id, location_name, machine_code, refiller_id, refiller_name, refiller_phone, due_date, due_time, due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (schedule_id, due_date, due_time) DO NOTHING`,
          [schedule.id, schedule.location_id, schedule.location_name, schedule.machine_code, schedule.resolved_refiller_id, schedule.refiller_name, phoneDigits(schedule.refiller_phone) || null, date, time, dueAt]
        );
      }
    }
  }
  // Future visits that no one has been reminded about follow the site's current name and refiller.
  await db.query(`
    UPDATE refill_tasks t
    SET location_name = l.name, machine_code = l.machine_code, refiller_id = r.id, refiller_name = r.name,
        refiller_phone = NULLIF(regexp_replace(COALESCE(r.phone, ''), '\\D', '', 'g'), '')
    FROM refill_schedules s
    JOIN audit_locations l ON l.id = s.location_id
    LEFT JOIN audit_refillers r ON r.id = COALESCE(s.refiller_id, l.refiller_id)
    WHERE t.schedule_id = s.id AND t.status = 'scheduled' AND t.due_at > NOW() AND t.day_before_sent_at IS NULL
      AND (t.refiller_id IS DISTINCT FROM r.id OR t.location_name IS DISTINCT FROM l.name)
  `);
  await db.query(`UPDATE refill_tasks SET refiller_phone = '91' || refiller_phone WHERE length(refiller_phone) = 10`);
}

// After a schedule changes, future visits nobody was told about yet are rebuilt from it.
async function rebuildSchedule(scheduleId) {
  await db.query(
    "DELETE FROM refill_tasks WHERE schedule_id = $1 AND status = 'scheduled' AND due_at > NOW() AND day_before_sent_at IS NULL AND hour_before_sent_at IS NULL",
    [scheduleId]
  );
  await generateTasks({ force: true });
}

/* ---------- Reminders ---------- */

async function sendReminder(phone, text, templateParams) {
  let result = await sendWhatsAppPayload({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: text } });
  if (!result.ok && result.code === REENGAGEMENT_ERROR) {
    // Outside the 24-hour window only an approved template gets through.
    result = await sendWhatsAppTemplate(phone, process.env.REFILL_TEMPLATE_NAME || "refill_reminder", process.env.REFILL_TEMPLATE_LANG || "en", templateParams);
    if (!result.ok) result.error = `Template "${process.env.REFILL_TEMPLATE_NAME || "refill_reminder"}" failed: ${result.error}`;
  }
  return result;
}

function visitLine(task, index) {
  return `${index + 1}. ${prettyTime(task.due_time)} · ${task.location_name}${task.machine_code ? ` (${task.machine_code})` : ""}`;
}

// The evening before: one message per refiller with all of tomorrow's visits.
async function sendDayBefore(settings, { onlyPhone = null, force = false } = {}) {
  const today = istDate();
  const tomorrow = addDays(today, 1);
  if (!force && new Date() < istToUtc(today, settings.day_before_time)) return 0;
  const { rows } = await db.query(
    `SELECT * FROM refill_tasks WHERE due_date = $1 AND status = 'scheduled' AND day_before_sent_at IS NULL
       AND refiller_phone IS NOT NULL ${onlyPhone ? "AND refiller_phone = $2" : ""}
     ORDER BY refiller_phone, due_time`,
    onlyPhone ? [tomorrow, onlyPhone] : [tomorrow]
  );
  const byPhone = new Map();
  rows.forEach((task) => byPhone.set(task.refiller_phone, [...(byPhone.get(task.refiller_phone) || []), task]));
  for (const [phone, tasks] of byPhone) {
    const name = tasks[0].refiller_name || "";
    const text = [
      `Hi ${name} 👋`,
      `Your Snackit refills for tomorrow, ${prettyDate(tomorrow)}:`,
      "",
      ...tasks.map(visitLine),
      "",
      "After refilling each machine, send a photo of it here and choose the site. 📸",
    ].join("\n");
    const result = await sendReminder(phone, text, [name || "there", String(tasks.length), `tomorrow (${prettyDate(tomorrow)})`, tasks.map((task) => `${prettyTime(task.due_time)} ${task.location_name}`).join("; ").slice(0, 900)]);
    await db.query(
      "UPDATE refill_tasks SET day_before_sent_at = CASE WHEN $2 THEN NOW() ELSE day_before_sent_at END, reminder_error = $3 WHERE id = ANY($1)",
      [tasks.map((task) => task.id), result.ok, result.ok ? null : result.error]
    );
  }
  return rows.length;
}

// An hour (adjustable) before each visit.
async function sendHourBefore(settings) {
  const minutes = Number(settings.hour_before_minutes) || 60;
  const { rows } = await db.query(
    `SELECT * FROM refill_tasks WHERE status = 'scheduled' AND hour_before_sent_at IS NULL AND refiller_phone IS NOT NULL
       AND due_at > NOW() AND due_at <= NOW() + ($1 * INTERVAL '1 minute')`,
    [minutes]
  );
  for (const task of rows) {
    const text = [
      `⏰ Refill reminder`,
      "",
      `📍 ${task.location_name}${task.machine_code ? ` (${task.machine_code})` : ""}`,
      `🕐 Today at ${prettyTime(task.due_time)}`,
      "",
      "After refilling, send a photo of the machine here and choose the site.",
    ].join("\n");
    const result = await sendReminder(task.refiller_phone, text, [task.refiller_name || "there", "1", `today at ${prettyTime(task.due_time)}`, task.location_name]);
    await db.query(
      "UPDATE refill_tasks SET hour_before_sent_at = CASE WHEN $2 THEN NOW() ELSE hour_before_sent_at END, reminder_error = $3 WHERE id = $1",
      [task.id, result.ok, result.ok ? null : result.error]
    );
  }
}

// Admins, and anyone with the Refill Schedule page, get pushes about refills.
function refillAudience(internalUsers) {
  return ["admin", ...(internalUsers || []).filter((user) => {
    const access = accessFor(user);
    return access.isAdmin || access.pages.includes("refills");
  }).map((user) => user.username)];
}

async function markMissed(settings) {
  const grace = Number(settings.grace_minutes) || 120;
  const { rows } = await db.query(
    `UPDATE refill_tasks SET status = 'missed', missed_at = NOW()
     WHERE status = 'scheduled' AND due_at + ($1 * INTERVAL '1 minute') < NOW()
     RETURNING *`,
    [grace]
  );
  if (rows.length && pushToUsers) {
    pushToUsers(refillAudience(global.internalUsers), {
      title: `⚠️ ${rows.length} refill${rows.length === 1 ? "" : "s"} missed`,
      body: rows.slice(0, 4).map((task) => `${task.refiller_name || "?"} · ${task.location_name} (${prettyTime(task.due_time)})`).join("\n"),
      view: "refills",
    });
  }
}

export async function refillTick() {
  if (!db || ticking) return;
  ticking = true;
  try {
    await generateTasks();
    const settings = await getSettings();
    if (settings.reminders_enabled !== "false") {
      await sendDayBefore(settings);
      await sendHourBefore(settings);
    }
    await markMissed(settings);
  } catch (err) {
    console.log("REFILL SCHEDULER ERROR:", err.message);
  } finally {
    ticking = false;
  }
}

/* ---------- Refiller on WhatsApp: photo → pick site ---------- */

async function refillerSites(refillerPhone) {
  const { rows } = await db.query(`
    SELECT l.id, l.name, l.machine_code, r.phone
    FROM audit_locations l JOIN audit_refillers r ON r.id = l.refiller_id
    ORDER BY l.name
  `);
  return rows.filter((row) => phoneDigits(row.phone) === refillerPhone);
}

async function openTasks(refillerPhone) {
  const today = istDate();
  const { rows } = await db.query(
    `SELECT * FROM refill_tasks
     WHERE refiller_phone = $1 AND status = ANY($2) AND due_date BETWEEN $3 AND $4
     ORDER BY due_at`,
    [refillerPhone, OPEN_STATUSES, addDays(today, -1), today]
  );
  return rows;
}

// Today's visits first (they're what they most likely just did), then their other sites.
async function siteRows(refillerPhone, page) {
  const [tasks, sites] = await Promise.all([openTasks(refillerPhone), refillerSites(refillerPhone)]);
  const today = istDate();
  const rows = [];
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.location_id)) continue;
    seen.add(task.location_id);
    const when = task.due_date === today ? `today ${prettyTime(task.due_time)}` : `yesterday ${prettyTime(task.due_time)}`;
    const label = task.status === "rejected" ? "Redo" : task.status === "missed" ? "Missed" : "Due";
    rows.push({ id: `RFP:${task.location_id}`, title: task.location_name, description: `${label} ${when}${task.machine_code ? ` · ${task.machine_code}` : ""}` });
  }
  for (const site of sites) {
    if (seen.has(site.id)) continue;
    seen.add(site.id);
    rows.push({ id: `RFP:${site.id}`, title: site.name, description: `Not scheduled today${site.machine_code ? ` · ${site.machine_code}` : ""}` });
  }
  const pageSize = 9;
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
  if (rows.length > (page + 1) * pageSize) slice.push({ id: `RFP_MORE:${page + 1}`, title: "More sites ▶", description: `${rows.length - (page + 1) * pageSize} more` });
  return { rows: slice, total: rows.length };
}

async function sendSitePicker(phone, name, photoCount, page = 0) {
  const { rows, total } = await siteRows(phone, page);
  if (!total) {
    await sendWhatsApp(phone, "📸 Photo received, but you have no sites assigned yet. Please ask your supervisor to assign your sites in the Snackit dashboard.");
    return;
  }
  const body = page
    ? "More of your sites:"
    : `📸 ${photoCount > 1 ? `${photoCount} photos` : "Photo"} received${name ? `, ${name}` : ""}.\n\nWhich site did you refill? Tap below and pick it.`;
  const result = await sendWhatsAppList(phone, body, "Choose site", "Your sites", rows);
  if (!result.ok) console.log("REFILL SITE LIST ERROR:", result.error);
}

async function addPhotoToBatch(phone, url) {
  const { rows } = await db.query(
    `INSERT INTO refill_photo_batches (refiller_phone, photos, started_at, list_sent)
     VALUES ($1, $2::jsonb, NOW(), FALSE)
     ON CONFLICT (refiller_phone) DO UPDATE SET
       photos = CASE WHEN refill_photo_batches.started_at < NOW() - INTERVAL '30 minutes' THEN EXCLUDED.photos ELSE refill_photo_batches.photos || EXCLUDED.photos END,
       list_sent = CASE WHEN refill_photo_batches.started_at < NOW() - INTERVAL '30 minutes' THEN FALSE ELSE refill_photo_batches.list_sent END,
       started_at = CASE WHEN refill_photo_batches.started_at < NOW() - INTERVAL '30 minutes' THEN NOW() ELSE refill_photo_batches.started_at END
     RETURNING jsonb_array_length(photos) AS count`,
    [phone, JSON.stringify([{ url, at: new Date().toISOString() }])]
  );
  // Several photos sent together arrive as separate messages; only the first one sends the site list.
  const claim = await db.query("UPDATE refill_photo_batches SET list_sent = TRUE WHERE refiller_phone = $1 AND list_sent = FALSE RETURNING 1", [phone]);
  return { count: rows[0].count, sendList: claim.rows.length > 0 };
}

async function completeTask(refiller, locationId) {
  const batch = await db.query("SELECT photos FROM refill_photo_batches WHERE refiller_phone = $1 AND started_at > NOW() - INTERVAL '6 hours'", [refiller.phone]);
  const photos = batch.rows[0]?.photos || [];
  if (!photos.length) {
    await sendWhatsApp(refiller.phone, "Please send the photo of the machine first 📸, then choose the site.");
    return;
  }
  const { rows: candidates } = await db.query(
    `SELECT * FROM refill_tasks
     WHERE refiller_phone = $1 AND location_id = $2 AND status = ANY($3) AND due_date BETWEEN $4 AND $5
     ORDER BY ABS(EXTRACT(EPOCH FROM (due_at - NOW()))) LIMIT 1`,
    [refiller.phone, locationId, OPEN_STATUSES, addDays(istDate(), -1), istDate()]
  );
  let task = candidates[0];
  if (!task) {
    // A refill that wasn't on the schedule is still recorded, marked as an extra visit.
    const site = await db.query("SELECT l.*, r.id AS rid, r.name AS rname FROM audit_locations l LEFT JOIN audit_refillers r ON r.id = l.refiller_id WHERE l.id = $1", [locationId]);
    const location = site.rows[0];
    if (!location) {
      await sendWhatsApp(refiller.phone, "That site could not be found. Please send the photo again.");
      return;
    }
    const inserted = await db.query(
      `INSERT INTO refill_tasks (location_id, location_name, machine_code, refiller_id, refiller_name, refiller_phone, due_date, due_time, due_at, unscheduled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), TRUE, 'WhatsApp') RETURNING *`,
      [location.id, location.name, location.machine_code, location.rid, refiller.name || location.rname, refiller.phone, istDate(), istTime()]
    );
    task = inserted.rows[0];
  }
  const minutesLate = Math.round((Date.now() - new Date(task.due_at).getTime()) / 60000);
  const updated = await db.query(
    `UPDATE refill_tasks SET status = 'done', photos = $2::jsonb, completed_at = NOW(), minutes_late = $3, reject_reason = NULL
     WHERE id = $1 RETURNING *`,
    [task.id, JSON.stringify(photos), task.unscheduled ? 0 : minutesLate]
  );
  await db.query("DELETE FROM refill_photo_batches WHERE refiller_phone = $1", [refiller.phone]);
  const settings = await getSettings();
  const grace = Number(settings.grace_minutes) || 120;
  const timing = task.unscheduled ? "Recorded as an extra visit." : minutesLate > grace ? `⚠️ ${minutesLate} min after the scheduled time.` : minutesLate > 0 ? `On time (within the allowed window).` : "On time ✅";
  await sendWhatsApp(refiller.phone, `✅ Thank you${refiller.name ? `, ${refiller.name}` : ""}!\n\nRefill at *${task.location_name}* recorded at ${prettyTime(istTime())} with ${photos.length} photo${photos.length === 1 ? "" : "s"}.\n${timing}\n\nYour supervisor will verify it.`);
  if (pushToUsers) {
    pushToUsers(refillAudience(global.internalUsers), {
      title: `📸 ${refiller.name || "Refiller"} refilled ${task.location_name}`,
      body: `${photos.length} photo${photos.length === 1 ? "" : "s"} · tap to verify`,
      view: "refills",
    });
  }
  return updated.rows[0];
}

async function todaySummary(refiller) {
  const today = istDate();
  const { rows } = await db.query(
    "SELECT * FROM refill_tasks WHERE refiller_phone = $1 AND due_date = $2 AND status <> 'cancelled' ORDER BY due_time",
    [refiller.phone, today]
  );
  if (!rows.length) return `Hi ${refiller.name || ""} 👋 You have no refills scheduled today.\n\nIf you refill a machine, send its photo here and choose the site. 📸`;
  const icon = { scheduled: "⏳", done: "📸", verified: "✅", rejected: "❌ redo", missed: "⚠️ missed" };
  return [
    `Hi ${refiller.name || ""} 👋 Your refills today (${prettyDate(today)}):`,
    "",
    ...rows.map((task, index) => `${visitLine(task, index)}  ${icon[task.status] || ""}`),
    "",
    "After refilling, send the machine photo here and choose the site. 📸",
  ].join("\n");
}

// Handles refill messages from a refiller; returns true if the message was about refills.
export async function handleRefillMessage(msg, refiller) {
  if (!db) return false;
  const listId = msg.interactive?.list_reply?.id || "";
  if (listId.startsWith("RFP_MORE:")) {
    await sendSitePicker(refiller.phone, refiller.name, 0, Number(listId.split(":")[1]) || 0);
    return true;
  }
  if (listId.startsWith("RFP:")) {
    await completeTask(refiller, Number(listId.split(":")[1]));
    return true;
  }
  const isPhoto = msg.type === "image" || (msg.type === "document" && /^image\//.test(msg.document?.mime_type || ""));
  if (isPhoto) {
    const media = await storeIncomingMedia(msg);
    if (!media?.url) {
      await sendWhatsApp(refiller.phone, "Sorry, that photo couldn't be saved. Please send it again.");
      return true;
    }
    const { count, sendList } = await addPhotoToBatch(refiller.phone, media.url);
    if (sendList) await sendSitePicker(refiller.phone, refiller.name, count);
    return true;
  }
  const text = String(msg.text?.body || "").trim().toLowerCase();
  if (/^(cancel|wrong photo)$/.test(text)) {
    await db.query("DELETE FROM refill_photo_batches WHERE refiller_phone = $1", [refiller.phone]);
    await sendWhatsApp(refiller.phone, "OK, those photos were discarded. Send a new photo whenever you're ready.");
    return true;
  }
  return false;
}

// Sends the refiller today's visits; returns false when the refill schedule isn't set up.
export async function sendRefillSummary(refiller) {
  if (!db) return false;
  await sendWhatsApp(refiller.phone, await todaySummary(refiller));
  return true;
}

/* ---------- Dashboard API ---------- */

function actorName(user) {
  if (user?.owner) return "Admin";
  return user?.name || user?.username || "Admin";
}

function cleanSchedule(body) {
  const mode = body.mode === "interval" ? "interval" : "weekly";
  const days = [...new Set((body.days || []).map(Number).filter((day) => day >= 0 && day <= 6))].sort();
  const times = [...new Set((body.times || []).filter(validTime))].sort();
  const intervalDays = Math.max(1, Math.min(60, Number(body.interval_days) || 1));
  const startDate = validDate(body.start_date) ? body.start_date : istDate();
  const endDate = validDate(body.end_date) ? body.end_date : null;
  if (!times.length) throw new Error("Add at least one refill time");
  if (mode === "weekly" && !days.length) throw new Error("Pick at least one day");
  return {
    mode, days, times, interval_days: mode === "interval" ? intervalDays : null,
    start_date: startDate, end_date: endDate,
    refiller_id: body.refiller_id ? Number(body.refiller_id) : null,
    notes: String(body.notes || "").trim().slice(0, 300) || null,
    active: body.active !== false,
  };
}

async function saveSchedule(locationId, fields) {
  const { rows } = await db.query(
    `INSERT INTO refill_schedules (location_id, refiller_id, mode, days, interval_days, start_date, end_date, times, notes, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (location_id) DO UPDATE SET refiller_id = EXCLUDED.refiller_id, mode = EXCLUDED.mode, days = EXCLUDED.days,
       interval_days = EXCLUDED.interval_days, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
       times = EXCLUDED.times, notes = EXCLUDED.notes, active = EXCLUDED.active, updated_at = NOW()
     RETURNING *`,
    [locationId, fields.refiller_id, fields.mode, fields.days, fields.interval_days, fields.start_date, fields.end_date, fields.times, fields.notes, fields.active]
  );
  await rebuildSchedule(rows[0].id);
  return rows[0];
}

export function registerRefillRoutes(app, { auth }) {
  const guard = (req, res, next) => (hasPage(req.user, "refills") ? next() : res.status(403).json({ error: "No access to Refill Schedule" }));
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const known = /^(Add at least|Pick at least|Invalid|Choose)/.test(err.message);
      if (!known) console.log(`${label} ERROR:`, err.message);
      res.status(known ? 400 : 500).json({ error: known ? err.message : "Server error" });
    }
  };

  // Everything the page needs for one day, plus sites, refillers and schedules.
  app.get("/refills/overview", auth, guard, handle("REFILL OVERVIEW", async (req, res) => {
    await generateTasks();
    const date = validDate(req.query.date) ? req.query.date : istDate();
    const [tasks, locations, refillers, settings, pending] = await Promise.all([
      db.query("SELECT * FROM refill_tasks WHERE due_date = $1 AND status <> 'cancelled' ORDER BY due_time, location_name", [date]),
      db.query(`SELECT l.id, l.name, l.machine_code, l.refiller_id, r.name AS refiller_name, row_to_json(s) AS schedule
                FROM audit_locations l LEFT JOIN audit_refillers r ON r.id = l.refiller_id
                LEFT JOIN refill_schedules s ON s.location_id = l.id ORDER BY r.name NULLS LAST, l.name`),
      db.query("SELECT id, name, phone FROM audit_refillers ORDER BY name"),
      getSettings(),
      db.query("SELECT COUNT(*)::int AS count FROM refill_tasks WHERE status = 'done'"),
    ]);
    res.json({
      date, today: istDate(), now: new Date().toISOString(),
      tasks: tasks.rows, locations: locations.rows, refillers: refillers.rows, settings,
      awaitingVerification: pending.rows[0].count,
      template: process.env.REFILL_TEMPLATE_NAME || "refill_reminder",
    });
  }));

  // Refills waiting for a supervisor's check (newest first), and recent decisions.
  app.get("/refills/verify", auth, guard, handle("REFILL VERIFY LIST", async (req, res) => {
    const status = ["done", "verified", "rejected"].includes(req.query.status) ? req.query.status : "done";
    const { rows } = await db.query(
      `SELECT * FROM refill_tasks WHERE status = $1 ${status === "done" ? "" : "AND COALESCE(verified_at, completed_at) > NOW() - INTERVAL '14 days'"}
       ORDER BY completed_at DESC NULLS LAST LIMIT 200`,
      [status]
    );
    res.json(rows);
  }));

  app.patch("/refills/tasks/:id", auth, guard, handle("REFILL TASK UPDATE", async (req, res) => {
    const { action, reason } = req.body || {};
    const { rows } = await db.query("SELECT * FROM refill_tasks WHERE id = $1", [req.params.id]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });
    let updated;
    if (action === "verify") {
      if (task.status !== "done") return res.status(400).json({ error: "Only refills with a photo can be verified" });
      updated = await db.query("UPDATE refill_tasks SET status = 'verified', verified_by = $2, verified_at = NOW() WHERE id = $1 RETURNING *", [task.id, actorName(req.user)]);
      res.locals.activity = { section: "Refills", action: `Verified refill at ${task.location_name} by ${task.refiller_name || "refiller"} (${task.due_date} ${task.due_time})` };
    } else if (action === "reject") {
      const why = String(reason || "").trim().slice(0, 300);
      if (!why) return res.status(400).json({ error: "Write why it's rejected so the refiller knows what to fix" });
      updated = await db.query(
        "UPDATE refill_tasks SET status = 'rejected', reject_reason = $2, verified_by = $3, verified_at = NOW(), rejected_count = rejected_count + 1 WHERE id = $1 RETURNING *",
        [task.id, why, actorName(req.user)]
      );
      if (task.refiller_phone) {
        await sendWhatsApp(task.refiller_phone, `❌ Your refill photo for *${task.location_name}* was not accepted.\n\nReason: ${why}\n\nPlease fix it, then send a new photo here and choose the site.`);
      }
      res.locals.activity = { section: "Refills", action: `Rejected refill at ${task.location_name} by ${task.refiller_name || "refiller"}: ${why}` };
    } else if (action === "cancel") {
      updated = await db.query("UPDATE refill_tasks SET status = 'cancelled' WHERE id = $1 RETURNING *", [task.id]);
      res.locals.activity = { section: "Refills", action: `Cancelled refill visit at ${task.location_name} (${task.due_date} ${task.due_time})` };
    } else if (action === "reopen") {
      const status = new Date(task.due_at) > new Date() ? "scheduled" : "missed";
      updated = await db.query("UPDATE refill_tasks SET status = $2, verified_by = NULL, verified_at = NULL WHERE id = $1 RETURNING *", [task.id, status]);
      res.locals.activity = { section: "Refills", action: `Reopened refill visit at ${task.location_name} (${task.due_date} ${task.due_time})` };
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    res.json(updated.rows[0]);
  }));

  app.post("/refills/tasks/verify-many", auth, guard, handle("REFILL VERIFY MANY", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Boolean);
    const { rows } = await db.query(
      "UPDATE refill_tasks SET status = 'verified', verified_by = $2, verified_at = NOW() WHERE id = ANY($1) AND status = 'done' RETURNING id",
      [ids, actorName(req.user)]
    );
    res.locals.activity = { section: "Refills", action: `Verified ${rows.length} refill${rows.length === 1 ? "" : "s"} at once` };
    res.json({ verified: rows.length });
  }));

  // One-off visit (outside the regular schedule).
  app.post("/refills/tasks", auth, guard, handle("REFILL TASK CREATE", async (req, res) => {
    const { location_id: locationId, due_date: dueDate, due_time: dueTime, notes } = req.body || {};
    if (!validDate(dueDate) || !validTime(dueTime)) throw new Error("Invalid date or time");
    const site = await db.query(
      `SELECT l.*, r.id AS rid, r.name AS rname, r.phone AS rphone FROM audit_locations l
       LEFT JOIN audit_refillers r ON r.id = COALESCE($2::int, l.refiller_id) WHERE l.id = $1`,
      [locationId, req.body?.refiller_id || null]
    );
    const location = site.rows[0];
    if (!location) throw new Error("Choose a site");
    const { rows } = await db.query(
      `INSERT INTO refill_tasks (location_id, location_name, machine_code, refiller_id, refiller_name, refiller_phone, due_date, due_time, due_at, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [location.id, location.name, location.machine_code, location.rid, location.rname, phoneDigits(location.rphone) || null, dueDate, dueTime, istToUtc(dueDate, dueTime), String(notes || "").trim() || null, actorName(req.user)]
    );
    res.locals.activity = { section: "Refills", action: `Added a one-off refill at ${location.name} for ${dueDate} ${dueTime} (${location.rname || "no refiller"})` };
    res.status(201).json(rows[0]);
  }));

  // Sends a reminder for one visit right now (e.g. after fixing a phone number).
  app.post("/refills/tasks/:id/remind", auth, guard, handle("REFILL REMIND", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM refill_tasks WHERE id = $1", [req.params.id]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!task.refiller_phone) return res.status(400).json({ error: "No phone number saved for this refiller" });
    const when = task.due_date === istDate() ? `today at ${prettyTime(task.due_time)}` : `${prettyDate(task.due_date)} at ${prettyTime(task.due_time)}`;
    const result = await sendReminder(
      task.refiller_phone,
      `⏰ Refill reminder\n\n📍 ${task.location_name}${task.machine_code ? ` (${task.machine_code})` : ""}\n🕐 ${when}\n\nAfter refilling, send a photo of the machine here and choose the site.`,
      [task.refiller_name || "there", "1", when, task.location_name]
    );
    await db.query("UPDATE refill_tasks SET reminder_error = $2 WHERE id = $1", [task.id, result.ok ? null : result.error]);
    if (!result.ok) return res.status(502).json({ error: result.error });
    res.json({ success: true });
  }));

  app.put("/refills/schedules/:locationId", auth, guard, handle("REFILL SCHEDULE SAVE", async (req, res) => {
    const fields = cleanSchedule(req.body || {});
    const schedule = await saveSchedule(Number(req.params.locationId), fields);
    const site = await db.query("SELECT name FROM audit_locations WHERE id = $1", [req.params.locationId]);
    const when = fields.mode === "interval" ? `every ${fields.interval_days} day${fields.interval_days === 1 ? "" : "s"}` : fields.days.map((day) => DAY_NAMES[day]).join(", ");
    res.locals.activity = { section: "Refills", action: `Set refill schedule for ${site.rows[0]?.name || "site"}: ${when} at ${fields.times.join(", ")}${fields.active ? "" : " (paused)"}` };
    res.json(schedule);
  }));

  // Same schedule for several sites at once.
  app.post("/refills/schedules/bulk", auth, guard, handle("REFILL SCHEDULE BULK", async (req, res) => {
    const ids = (req.body?.location_ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw new Error("Choose at least one site");
    const fields = cleanSchedule(req.body || {});
    for (const id of ids) await saveSchedule(id, { ...fields, refiller_id: null });
    res.locals.activity = { section: "Refills", action: `Set the same refill schedule for ${ids.length} sites` };
    res.json({ saved: ids.length });
  }));

  app.delete("/refills/schedules/:locationId", auth, guard, handle("REFILL SCHEDULE DELETE", async (req, res) => {
    const { rows } = await db.query("DELETE FROM refill_schedules WHERE location_id = $1 RETURNING id", [req.params.locationId]);
    if (rows[0]) await db.query("DELETE FROM refill_tasks WHERE schedule_id = $1 AND status = 'scheduled' AND due_at > NOW()", [rows[0].id]);
    res.locals.activity = { section: "Refills", action: `Removed the refill schedule of site #${req.params.locationId}` };
    res.json({ success: true });
  }));

  app.put("/refills/settings", auth, guard, handle("REFILL SETTINGS", async (req, res) => {
    const next = {};
    if (req.body?.day_before_time !== undefined) {
      if (!validTime(req.body.day_before_time)) throw new Error("Invalid reminder time");
      next.day_before_time = req.body.day_before_time;
    }
    for (const key of ["hour_before_minutes", "grace_minutes"]) {
      if (req.body?.[key] !== undefined) next[key] = String(Math.max(5, Math.min(24 * 60, Number(req.body[key]) || 60)));
    }
    if (req.body?.reminders_enabled !== undefined) next.reminders_enabled = req.body.reminders_enabled ? "true" : "false";
    for (const [key, value] of Object.entries(next)) {
      await db.query("INSERT INTO refill_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
    }
    res.locals.activity = { section: "Refills", action: `Changed refill reminder settings (${Object.entries(next).map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`).join(", ")})` };
    res.json(await getSettings());
  }));

  // Sends tomorrow's list to one refiller now (to check their phone and the template work).
  app.post("/refills/send-tomorrow", auth, guard, handle("REFILL SEND TOMORROW", async (req, res) => {
    await generateTasks({ force: true });
    const phone = req.body?.refiller_phone ? phoneDigits(req.body.refiller_phone) : null;
    const count = await sendDayBefore(await getSettings(), { onlyPhone: phone, force: true });
    res.json({ sent: count });
  }));

  // Completion and punctuality per refiller for a month (or a date range).
  app.get("/refills/stats", auth, guard, handle("REFILL STATS", async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : istDate().slice(0, 7);
    const settings = await getSettings();
    const grace = Number(settings.grace_minutes) || 120;
    const { rows } = await db.query(
      `SELECT refiller_name, refiller_phone,
         COUNT(*) FILTER (WHERE NOT unscheduled AND (due_at <= NOW() OR status IN ('done', 'verified')))::int AS due,
         COUNT(*) FILTER (WHERE status IN ('done', 'verified') AND NOT unscheduled)::int AS completed,
         COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
         COUNT(*) FILTER (WHERE status = 'missed')::int AS missed,
         COUNT(*) FILTER (WHERE status = 'rejected' OR rejected_count > 0)::int AS rejected,
         COUNT(*) FILTER (WHERE status IN ('done', 'verified') AND NOT unscheduled AND minutes_late <= $2)::int AS on_time,
         COUNT(*) FILTER (WHERE unscheduled)::int AS extra,
         ROUND(AVG(minutes_late) FILTER (WHERE status IN ('done', 'verified') AND NOT unscheduled AND minutes_late > 0))::int AS avg_late
       FROM refill_tasks
       WHERE due_date LIKE $1 AND status <> 'cancelled' AND refiller_name IS NOT NULL
       GROUP BY refiller_name, refiller_phone ORDER BY refiller_name`,
      [`${month}-%`, grace]
    );
    res.json({ month, grace, rows });
  }));
}
