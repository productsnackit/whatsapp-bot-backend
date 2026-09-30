/* =========================================================
    CALL LOG
    Any task or concern (a client's phone call, a site issue, something a colleague
    needs) is logged on the dashboard and assigned to an employee. It goes straight to
    their WhatsApp with three buttons:
      Processing → In progress (time to start is recorded)
      Resolved   → Done (time to complete is recorded); they can reply with a note or photo
      Forward  → they pick a colleague from a list; the task moves to them with its history
    Every step is kept in the task's history, so the page shows who had it, for how long,
    and how long each person takes on average.

    Employees need a WhatsApp number (Employees & Access). WhatsApp only allows normal
    messages within 24 hours of the person's last message to us; after that the approved
    template CALL_TEMPLATE_NAME (default "call_log_task", language CALL_TEMPLATE_LANG, "en")
    is sent: body {{1}} task ref, {{2}} the task, {{3}} raised by, {{4}} due; quick-reply
    buttons "Processing", "Resolved", "Forward" in that order.
========================================================= */
import { sendWhatsApp, sendWhatsAppButtons, sendWhatsAppList } from "./whatsapp.js";
import { sendWithFallback, onDeliveryUpdate, noteInbound, refillerWindowOpen } from "./whatsappOutbox.js";
import { sendPushToUsers } from "./pushNotifications.js";
import { storeIncomingMedia } from "./ticketChat.js";

export const CALL_SOURCES = ["Phone call", "WhatsApp", "In person", "Email", "Internal"];
export const CALL_PRIORITIES = ["Low", "Normal", "High", "Urgent"];
export const CALL_STATUSES = ["Open", "In Progress", "Done", "Cancelled"];
const NOTE_WINDOW_MS = 15 * 60 * 1000;

let db = null;
let changed = () => {};

const phoneDigits = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};
const employees = () => global.internalUsers || [];
const employeeById = (id) => employees().find((user) => String(user.id) === String(id)) || null;
const employeeByPhone = (phone) => employees().find((user) => user.phone && phoneDigits(user.phone) === phoneDigits(phone)) || null;
const userName = (user) => (user?.role === "admin" ? "Admin" : user?.name || user?.username || "Employee");
const userKey = (user) => (user?.role === "admin" ? "admin" : String(user?.username || ""));

// "2h 15m", "3d 4h", "12m".
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

const when = (value) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export async function ensureCallLog(database, { onChange } = {}) {
  db = database;
  if (onChange) changed = onChange;
  await db.query(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE,
      title TEXT NOT NULL,
      details TEXT,
      source TEXT NOT NULL DEFAULT 'Phone call',
      caller_name TEXT,
      caller_phone TEXT,
      location TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      status TEXT NOT NULL DEFAULT 'Open',
      assignee_id TEXT,
      assignee_name TEXT,
      assignee_phone TEXT,
      assigned_at TIMESTAMPTZ DEFAULT NOW(),
      raised_by TEXT,
      raised_by_key TEXT,
      due_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      done_at TIMESTAMPTZ,
      done_by TEXT,
      forward_count INTEGER NOT NULL DEFAULT 0,
      whatsapp_status TEXT,
      whatsapp_error TEXT,
      whatsapp_delivery TEXT,
      whatsapp_sent_at TIMESTAMPTZ,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      note_phone TEXT,
      note_mode TEXT,
      note_open_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  onDeliveryUpdate("calllog", async ({ refIds, ok, status, error }) => {
    if (!ok) {
      await db.query("UPDATE call_logs SET whatsapp_status = 'FAILED', whatsapp_error = $2, whatsapp_delivery = NULL WHERE id = ANY($1)", [refIds, error]);
    } else if (status === "delivered" || status === "read") {
      await db.query("UPDATE call_logs SET whatsapp_delivery = $2 WHERE id = ANY($1) AND (whatsapp_delivery IS NULL OR $2 = 'read')", [refIds, status]);
    }
    changed();
  });
}

async function getTask(id) {
  const { rows } = await db.query("SELECT * FROM call_logs WHERE id = $1", [id]);
  return rows[0] || null;
}

// Adds one step to the history: { at, by, action, note, to }.
async function addHistory(id, entry, extraSql = "", extraValues = []) {
  const step = { at: new Date().toISOString(), ...entry };
  const { rows } = await db.query(
    `UPDATE call_logs SET history = history || $2::jsonb, updated_at = NOW()${extraSql} WHERE id = $1 RETURNING *`,
    [id, JSON.stringify([step]), ...extraValues]
  );
  changed();
  return rows[0];
}

/* ---------- WhatsApp to the employee ---------- */

function taskText(task, { forwardedBy, note } = {}) {
  const lines = [
    forwardedBy ? `↪️ *Task ${task.ref} forwarded to you by ${forwardedBy}*` : `📋 *New task ${task.ref}*`,
    "",
    `*${task.title}*`,
    task.details || "",
    "",
    task.caller_name || task.caller_phone ? `📞 ${task.source || "Caller"}: ${[task.caller_name, task.caller_phone].filter(Boolean).join(", ")}` : "",
    task.location ? `📍 ${task.location}` : "",
    task.priority && task.priority !== "Normal" ? `⚡ Priority: ${task.priority}` : "",
    task.due_at ? `⏰ Due: ${when(task.due_at)}` : "",
    `👤 Raised by ${task.raised_by || "the team"}`,
    note ? `\n💬 ${forwardedBy}: ${note}` : "",
    "",
    "Tap *Processing* when you begin and *Resolved* when it's finished. Can't do it? Tap *Forward* to pass it to a colleague.",
  ];
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const taskButtons = (id) => [
  { id: `CALL_START:${id}`, title: "Processing" },
  { id: `CALL_DONE:${id}`, title: "Resolved" },
  { id: `CALL_FWD:${id}`, title: "Forward" },
];

// Template parameters can't hold line breaks.
const oneLine = (text, max = 700) => String(text || "").replace(/\s*\n+\s*/g, " · ").replace(/\s{4,}/g, "   ").trim().slice(0, max) || "-";

function templateFor(task) {
  const name = process.env.CALL_TEMPLATE_NAME || "call_log_task";
  if (name === "off") return null;
  const summary = [task.title, task.details, task.location && `Location: ${task.location}`, (task.caller_name || task.caller_phone) && `Caller: ${[task.caller_name, task.caller_phone].filter(Boolean).join(", ")}`].filter(Boolean).join(" · ");
  return {
    name,
    lang: process.env.CALL_TEMPLATE_LANG || "en",
    params: [task.ref, oneLine(summary), oneLine(task.raised_by || "the team", 60), task.due_at ? when(task.due_at) : "No due time"],
    buttons: taskButtons(task.id).map((button) => button.id),
  };
}

// Sends the task to its current assignee; the result shows on the dashboard.
export async function sendTask(id, options = {}) {
  const task = await getTask(id);
  if (!task) return null;
  const to = phoneDigits(task.assignee_phone);
  if (!to) {
    await db.query("UPDATE call_logs SET whatsapp_status = 'NO_PHONE', whatsapp_error = $2 WHERE id = $1", [id, `${task.assignee_name || "The employee"} has no WhatsApp number. Add it in Employees & Access.`]);
    changed();
    return { ok: false };
  }
  const result = await sendWithFallback({
    kind: "calllog",
    refIds: [task.id],
    to,
    send: () => sendWhatsAppButtons(to, taskText(task, options), taskButtons(task.id)),
    template: templateFor(task),
    noWindowError: `Not delivered: ${task.assignee_name} hasn't messaged the Snackit WhatsApp number in the last 24 hours and the call_log_task template isn't set up.`,
  });
  // A forward note goes as its own message when the task itself went as a template.
  if (result.ok && result.viaTemplate && options.note) await sendWhatsApp(to, `💬 ${options.forwardedBy}: ${options.note}`).catch(() => {});
  await db.query(
    `UPDATE call_logs SET whatsapp_status = $2, whatsapp_error = $3, whatsapp_delivery = NULL, whatsapp_sent_at = CASE WHEN $2 = 'SENT' THEN NOW() ELSE whatsapp_sent_at END WHERE id = $1`,
    [id, result.ok ? "SENT" : "FAILED", result.ok ? null : result.error || "Could not send"]
  );
  changed();
  return result;
}

/* ---------- Actions (from WhatsApp or the dashboard) ---------- */

async function notifyRaiser(task, title, body) {
  if (!task.raised_by_key) return;
  await sendPushToUsers(db, [task.raised_by_key], { title: `${title} · ${task.ref}`, body: body.slice(0, 180), view: "call-log" }).catch(() => {});
}

export async function startTask(task, byName) {
  if (task.status === "Done" || task.status === "Cancelled") return task;
  return addHistory(task.id, { by: byName, action: "started" }, ", status = 'In Progress', started_at = COALESCE(started_at, NOW())");
}

export async function completeTask(task, byName, note) {
  const updated = await addHistory(task.id, { by: byName, action: "done", note: note || undefined }, ", status = 'Done', done_at = NOW(), done_by = $3", [byName]);
  const took = duration(new Date(updated.done_at) - new Date(updated.created_at));
  await notifyRaiser(updated, "Task done", `${byName} finished "${updated.title}"${took ? ` in ${took}` : ""}.`);
  return updated;
}

export async function forwardTask(task, toUser, byName, note) {
  const updated = await addHistory(
    task.id,
    { by: byName, action: "forwarded", to: toUser.name, note: note || undefined },
    `, assignee_id = $3, assignee_name = $4, assignee_phone = $5, assigned_at = NOW(), started_at = NULL,
       status = CASE WHEN status IN ('Done', 'Cancelled') THEN status ELSE 'Open' END, forward_count = forward_count + 1,
       note_open_until = NULL, note_phone = NULL, note_mode = NULL`,
    [String(toUser.id), toUser.name, toUser.phone || null]
  );
  await sendTask(task.id, { forwardedBy: byName, note });
  await notifyRaiser(updated, "Task forwarded", `${byName} forwarded "${updated.title}" to ${toUser.name}${note ? `: ${note}` : "."}`);
  if (toUser.username) {
    await sendPushToUsers(db, [toUser.username], { title: `Task forwarded to you · ${task.ref}`, body: `${task.title} (from ${byName})`.slice(0, 180), view: "call-log" }).catch(() => {});
  }
  return getTask(task.id);
}

/* ---------- Replies on WhatsApp ---------- */

async function openNoteWindow(id, phone, mode) {
  await db.query("UPDATE call_logs SET note_phone = $2, note_mode = $3, note_open_until = NOW() + ($4 * INTERVAL '1 millisecond') WHERE id = $1", [id, phone, mode, NOTE_WINDOW_MS]);
}

// Colleagues to forward to: WhatsApp lists hold 10 rows; the same department comes first.
function forwardChoices(task, fromUser) {
  return employees()
    .filter((user) => user.phone && String(user.id) !== String(fromUser?.id) && String(user.id) !== String(task.assignee_id))
    .sort((a, b) => Number(b.department === fromUser?.department) - Number(a.department === fromUser?.department) || a.name.localeCompare(b.name))
    .slice(0, 10);
}

// Returns true when the message was about a call-log task (so the customer bot ignores it).
export async function handleCallLogWhatsApp(msg) {
  if (!db || !msg?.from) return false;
  const phone = phoneDigits(msg.from);
  const choice = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || msg.button?.payload || "";
  const match = choice.match(/^CALL_(START|DONE|FWD|TO):(\d+)(?::(.+))?$/);
  const employee = employeeByPhone(phone);

  if (match) {
    await noteInbound(phone);
    const [, action, id, targetId] = match;
    const task = await getTask(Number(id));
    const byName = employee?.name || task?.assignee_name || "Employee";
    if (!task) {
      await sendWhatsApp(phone, "This task no longer exists.");
      return true;
    }
    if (phoneDigits(task.assignee_phone) !== phone) {
      await sendWhatsApp(phone, `${task.ref} is now with ${task.assignee_name || "someone else"}, so it wasn't changed.`);
      return true;
    }
    if (task.status === "Cancelled") {
      await sendWhatsApp(phone, `${task.ref} was cancelled. Nothing more to do.`);
      return true;
    }
    if (task.status === "Done" && action !== "FWD" && action !== "TO") {
      await sendWhatsApp(phone, `${task.ref} is already resolved ✅`);
      return true;
    }

    if (action === "START") {
      await startTask(task, byName);
      await sendWhatsAppButtons(phone, `👍 ${task.ref} marked as *processing*.\n\nTap *Resolved* when it's finished.`, taskButtons(task.id).slice(1));
    } else if (action === "DONE") {
      const done = await completeTask(task, byName);
      await openNoteWindow(task.id, phone, "done");
      const took = duration(new Date(done.done_at) - new Date(done.assigned_at));
      await sendWhatsApp(phone, `✅ ${task.ref} marked *resolved*${took ? ` (${took})` : ""}. Thank you!\n\nWant to add what was done? Reply with a note or photo in the next 15 minutes.`);
    } else if (action === "FWD") {
      if (task.status === "Done") {
        await sendWhatsApp(phone, `${task.ref} is already resolved ✅`);
        return true;
      }
      const choices = forwardChoices(task, employee);
      if (!choices.length) {
        await sendWhatsApp(phone, "No colleague has a WhatsApp number saved yet, so this can't be forwarded from WhatsApp. Ask the admin to forward it from the dashboard.");
        return true;
      }
      await sendWhatsAppList(
        phone,
        `Who should take ${task.ref}?\n\n*${task.title}*`,
        "Choose colleague",
        "Forward to",
        choices.map((user) => ({ id: `CALL_TO:${task.id}:${user.id}`, title: user.name.slice(0, 24), description: [user.department, user.role].filter(Boolean).join(" · ").slice(0, 72) }))
      );
    } else if (action === "TO") {
      const target = employeeById(targetId);
      if (!target?.phone) {
        await sendWhatsApp(phone, "That colleague has no WhatsApp number any more. Please forward it from the dashboard.");
        return true;
      }
      await forwardTask(task, target, byName);
      await openNoteWindow(task.id, phone, "forward");
      await sendWhatsApp(phone, `↪️ ${task.ref} forwarded to *${target.name}*.\n\nWhy couldn't you do it? Reply in the next 15 minutes and ${target.name} will see your note.`);
    }
    return true;
  }

  // A note or photo right after "Resolved" or "Forward".
  const { rows } = await db.query(
    "SELECT * FROM call_logs WHERE note_phone = $1 AND note_open_until > NOW() ORDER BY note_open_until DESC LIMIT 1",
    [phone]
  ).catch(() => ({ rows: [] }));
  const task = rows[0];
  if (!task || !["text", "image"].includes(msg.type)) return redeliverTo(phone, employee);
  await noteInbound(phone);
  const media = msg.type === "image" ? await storeIncomingMedia(msg).catch(() => null) : null;
  const text = msg.text?.body || media?.caption || "";
  const byName = employee?.name || "Employee";
  const note = { at: new Date().toISOString(), by: byName, text: text || undefined, photo: media?.url || undefined };
  await db.query("UPDATE call_logs SET notes = notes || $2::jsonb, updated_at = NOW() WHERE id = $1", [task.id, JSON.stringify([note])]);
  changed();
  if (task.note_mode === "forward" && task.assignee_phone) {
    if (text) await sendWhatsApp(phoneDigits(task.assignee_phone), `💬 Note from ${byName} on ${task.ref}: ${text}`).catch(() => {});
    await addHistory(task.id, { by: byName, action: "note", note: text || "📷 Photo" });
  }
  await sendWhatsApp(phone, `📝 Added to ${task.ref}.`);
  return true;
}

// Their message opened WhatsApp's 24-hour window: tasks that couldn't reach them go now.
async function redeliverTo(phone, employee) {
  if (!employee) return false;
  await noteInbound(phone);
  const { rows } = await db.query(
    "SELECT id FROM call_logs WHERE assignee_phone IS NOT NULL AND status IN ('Open', 'In Progress') AND whatsapp_status = 'FAILED' ORDER BY id",
  ).catch(() => ({ rows: [] }));
  let sent = 0;
  for (const row of rows) {
    const task = await getTask(row.id);
    if (phoneDigits(task.assignee_phone) !== phone) continue;
    if ((await sendTask(task.id))?.ok) sent += 1;
  }
  if (sent) console.log(`📨 Re-sent ${sent} call-log task(s) to ${employee.name} after they messaged`);
  return false; // their message itself still goes wherever it would have gone
}

/* ---------- Dashboard ---------- */

function readTask(body, { partial }) {
  const values = {};
  const text = (key, max) => (body[key] === undefined ? undefined : String(body[key] || "").trim().slice(0, max));
  for (const [key, max] of [["title", 200], ["details", 3000], ["caller_name", 120], ["caller_phone", 30], ["location", 200]]) {
    const value = text(key, max);
    if (value !== undefined) values[key] = value || null;
  }
  if (!partial && !values.title) return { error: "What is the task? Add a short title." };
  if (body.source !== undefined) {
    if (!CALL_SOURCES.includes(body.source)) return { error: "Choose where it came from" };
    values.source = body.source;
  }
  if (body.priority !== undefined) {
    if (!CALL_PRIORITIES.includes(body.priority)) return { error: "Choose a priority" };
    values.priority = body.priority;
  }
  if (body.due_at !== undefined) {
    if (body.due_at && Number.isNaN(new Date(body.due_at).getTime())) return { error: "Invalid due time" };
    values.due_at = body.due_at ? new Date(body.due_at) : null;
  }
  return { values };
}

// Per employee: tasks now with them, finished, forwarded on, and how long they take.
function stats(tasks) {
  const people = new Map();
  const person = (name) => {
    if (!people.has(name)) people.set(name, { name, open: 0, done: 0, forwarded: 0, overdue: 0, startMs: [], doneMs: [], onTime: 0 });
    return people.get(name);
  };
  const now = Date.now();
  for (const task of tasks) {
    // "Forwarded on" counts only the person who had the task (not the admin re-assigning it).
    let holder = null;
    for (const step of task.history || []) {
      if (step.action === "forwarded" && step.by === holder) person(step.by).forwarded += 1;
      if (step.to) holder = step.to;
    }
    if (!task.assignee_name || task.status === "Cancelled") continue;
    const entry = person(task.assignee_name);
    if (task.status === "Done") {
      entry.done += 1;
      if (task.done_at && task.assigned_at) entry.doneMs.push(new Date(task.done_at) - new Date(task.assigned_at));
      if (!task.due_at || new Date(task.done_at) <= new Date(task.due_at)) entry.onTime += 1;
    } else {
      entry.open += 1;
      if (task.due_at && new Date(task.due_at).getTime() < now) entry.overdue += 1;
    }
    if (task.started_at && task.assigned_at) entry.startMs.push(new Date(task.started_at) - new Date(task.assigned_at));
  }
  const average = (list) => (list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null);
  return [...people.values()].map(({ startMs, doneMs, onTime, ...entry }) => ({
    ...entry,
    avg_start_ms: average(startMs),
    avg_done_ms: average(doneMs),
    on_time_rate: entry.done ? Math.round((onTime / entry.done) * 100) : null,
  })).sort((a, b) => b.open + b.done - (a.open + a.done));
}

export function registerCallLogRoutes(app, { auth }) {
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      res.status(500).json({ error: "Server error" });
    }
  };
  // The person who raised it, the person it's with, or an admin.
  const canChange = (req, task) => req.user?.isAdmin || task.raised_by_key === userKey(req.user) || String(task.assignee_id) === String(req.user?.id);

  app.get("/internal/call-log", auth, handle("CALL LOG", async (req, res) => {
    const { rows } = await db.query("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 1000");
    const windows = {};
    for (const task of rows) {
      const phone = phoneDigits(task.assignee_phone);
      if (phone && windows[phone] === undefined) windows[phone] = await refillerWindowOpen(phone);
    }
    res.json({
      tasks: rows.map((task) => ({ ...task, whatsapp_window_open: Boolean(windows[phoneDigits(task.assignee_phone)]) })),
      people: stats(rows),
    });
  }));

  app.post("/internal/call-log", auth, handle("CALL LOG CREATE", async (req, res) => {
    const { values, error } = readTask(req.body || {}, { partial: false });
    if (error) return res.status(400).json({ error });
    const assignee = employeeById(req.body?.assignee_id);
    if (!assignee) return res.status(400).json({ error: "Choose who should do it" });
    const by = userName(req.user);
    const inserted = await db.query(
      `INSERT INTO call_logs (title, details, source, caller_name, caller_phone, location, priority, due_at, assignee_id, assignee_name, assignee_phone, raised_by, raised_by_key, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [values.title, values.details || null, values.source || "Phone call", values.caller_name || null, values.caller_phone || null, values.location || null,
        values.priority || "Normal", values.due_at || null, String(assignee.id), assignee.name, assignee.phone || null, by, userKey(req.user),
        JSON.stringify([{ at: new Date().toISOString(), by, action: "raised", to: assignee.name }])]
    );
    const id = inserted.rows[0].id;
    await db.query("UPDATE call_logs SET ref = 'CL-' || LPAD(id::text, 4, '0') WHERE id = $1", [id]);
    await sendTask(id);
    if (assignee.username) {
      await sendPushToUsers(db, [assignee.username], { title: `New task for you · ${values.title}`.slice(0, 80), body: `From ${by}`, view: "call-log" }).catch(() => {});
    }
    res.locals.activity = { section: "Call Log", action: `Raised task "${values.title}" for ${assignee.name}` };
    res.status(201).json(await getTask(id));
  }));

  // { status } | { assignee_id, note } (forward) | { note } | fields to edit.
  app.patch("/internal/call-log/:id", auth, handle("CALL LOG UPDATE", async (req, res) => {
    const task = await getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!canChange(req, task)) return res.status(403).json({ error: "Only the person who raised it, the person it's with, or an admin can change it." });
    const by = userName(req.user);
    const body = req.body || {};
    const note = String(body.note || "").trim().slice(0, 1000);

    if (body.assignee_id !== undefined) {
      const target = employeeById(body.assignee_id);
      if (!target) return res.status(400).json({ error: "Choose a colleague" });
      if (String(target.id) === String(task.assignee_id)) return res.status(400).json({ error: `It's already with ${target.name}` });
      res.locals.activity = { section: "Call Log", action: `Forwarded ${task.ref} to ${target.name}` };
      return res.json(await forwardTask(task, target, by, note));
    }
    if (body.status !== undefined) {
      if (!CALL_STATUSES.includes(body.status)) return res.status(400).json({ error: "Invalid status" });
      let updated = task;
      if (body.status === "Done") updated = await completeTask(task, by, note);
      else if (body.status === "In Progress") updated = await startTask(task, by);
      else if (body.status === "Cancelled") updated = await addHistory(task.id, { by, action: "cancelled", note: note || undefined }, ", status = 'Cancelled'");
      else updated = await addHistory(task.id, { by, action: "reopened", note: note || undefined }, ", status = 'Open', done_at = NULL, done_by = NULL, started_at = NULL, assigned_at = NOW()");
      res.locals.activity = { section: "Call Log", action: `${task.ref} → ${body.status}` };
      if (body.status === "Open" && task.status !== "Open") await sendTask(task.id);
      return res.json(await getTask(updated.id));
    }
    const { values, error } = readTask(body, { partial: true });
    if (error) return res.status(400).json({ error });
    const keys = Object.keys(values);
    if (keys.length) {
      await db.query(
        `UPDATE call_logs SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(", ")}, updated_at = NOW() WHERE id = $1`,
        [task.id, ...keys.map((key) => values[key])]
      );
      await addHistory(task.id, { by, action: "edited" });
    }
    if (note) await addHistory(task.id, { by, action: "note", note });
    changed();
    res.json(await getTask(task.id));
  }));

  app.post("/internal/call-log/:id/resend", auth, handle("CALL LOG RESEND", async (req, res) => {
    const task = await getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: "Task not found" });
    // The number may have been added since the task was raised.
    const assignee = employeeById(task.assignee_id);
    if (assignee?.phone && assignee.phone !== task.assignee_phone) await db.query("UPDATE call_logs SET assignee_phone = $2 WHERE id = $1", [task.id, assignee.phone]);
    const result = await sendTask(task.id);
    res.json({ ok: Boolean(result?.ok), task: await getTask(task.id) });
  }));

  app.delete("/internal/call-log/:id", auth, handle("CALL LOG DELETE", async (req, res) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: "Only an admin can delete tasks" });
    const { rows } = await db.query("DELETE FROM call_logs WHERE id = $1 RETURNING ref, title", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: "Task not found" });
    res.locals.activity = { section: "Call Log", action: `Deleted ${rows[0].ref} "${rows[0].title}"` };
    changed();
    res.json({ success: true });
  }));
}
