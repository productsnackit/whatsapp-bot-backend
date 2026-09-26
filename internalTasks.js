/* =========================================================
    TEAM TASKS
    A message in a department group that @tags someone is a task for them.
    Tasks can have a due date; tagged people move them Open → In progress →
    Resolved (from the chat or the Tasks board). People get a push before a
    task is due and when it's overdue (again every day until it's done), and
    the Tasks page shows what each person finished this week.
    Tasks live inside the internal chat messages, so nothing is copied.
========================================================= */

const DUE_SOON_MS = 2 * 60 * 60 * 1000;
const OVERDUE_REPEAT_MS = 24 * 60 * 60 * 1000;
const STATUSES = ["open", "in-progress", "resolved"];

let deps = null;
let running = false;

// Message ids are "Date.now() + random", so the id tells when it was sent.
function createdAtOf(message) {
  return message.createdAt || new Date(Math.floor(Number(message.id)) || Date.now()).toISOString();
}

function userForKey(key) {
  if (key === "admin") return { key: "admin", name: "Admin", username: "admin" };
  const user = global.internalUsers.find((item) => String(item.id) === String(key));
  return user ? { key: String(user.id), name: user.name, username: user.username, department: user.department } : null;
}

function senderKeyOf(message) {
  if (message.createdByKey) return message.createdByKey;
  if (message.sender === "Admin") return "admin";
  const user = global.internalUsers.find((item) => item.name === message.sender);
  return user ? String(user.id) : null;
}

export function isTask(chat, message) {
  return chat?.type !== "direct" && Array.isArray(message?.mentions) && message.mentions.length > 0;
}

function toTask(chat, message, now = Date.now()) {
  const status = STATUSES.includes(message.status) ? message.status : "open";
  const dueMs = message.dueAt ? new Date(message.dueAt).getTime() : null;
  const creatorKey = senderKeyOf(message);
  return {
    id: `${chat.id}:${message.id}`,
    chatId: chat.id,
    messageId: message.id,
    department: chat.department,
    chatTitle: chat.title || `${chat.department} chat`,
    text: message.text || (message.attachments?.length ? `📎 ${message.attachments.length} attachment(s)` : ""),
    attachments: (message.attachments || []).length,
    priority: message.priority || "medium",
    status,
    createdAt: createdAtOf(message),
    createdBy: message.sender,
    createdByKey: creatorKey,
    assignees: message.mentions.map(String).map((key) => userForKey(key) || { key, name: "Removed employee" }),
    dueAt: message.dueAt || null,
    overdue: Boolean(dueMs && status !== "resolved" && dueMs < now),
    dueSoon: Boolean(dueMs && status !== "resolved" && dueMs >= now && dueMs - now <= DUE_SOON_MS),
    statusUpdatedBy: message.statusUpdatedBy || null,
    statusUpdatedAt: message.statusUpdatedAt || null,
    completedAt: status === "resolved" ? message.completedAt || message.statusUpdatedAt || null : null,
    history: message.history || [],
  };
}

function allTasks() {
  const now = Date.now();
  const tasks = [];
  for (const chat of global.internalChats || []) {
    for (const message of chat.messages || []) {
      if (isTask(chat, message)) tasks.push(toTask(chat, message, now));
    }
  }
  return tasks;
}

function findTask(chatId, messageId) {
  const chat = (global.internalChats || []).find((item) => String(item.id) === String(chatId));
  const message = chat?.messages?.find((item) => String(item.id) === String(messageId));
  return chat && message && isTask(chat, message) ? { chat, message } : null;
}

function addHistory(message, by, action) {
  message.history = [...(message.history || []), { at: new Date().toISOString(), by, action }].slice(-30);
}

function pushKeysFor(keys) {
  return [...new Set(keys.map((key) => (key === "admin" ? "admin" : userForKey(key)?.username)).filter(Boolean))];
}

function whenLabel(iso) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/* ---------- Reminders ---------- */

export async function taskReminderTick() {
  if (!deps || running) return;
  running = true;
  try {
    const now = Date.now();
    let changed = false;
    for (const chat of global.internalChats || []) {
      for (const message of chat.messages || []) {
        if (!isTask(chat, message) || !message.dueAt || message.status === "resolved") continue;
        const due = new Date(message.dueAt).getTime();
        const text = String(message.text || "Task").slice(0, 120);
        const assigneeKeys = message.mentions.map(String);
        const payload = { chatId: String(chat.id), department: chat.department, view: "tasks" };

        if (due > now && due - now <= DUE_SOON_MS && !message.dueSoonNotifiedAt) {
          deps.sendPush(pushKeysFor(assigneeKeys), { ...payload, title: `⏰ Task due at ${whenLabel(message.dueAt)}`, body: text });
          message.dueSoonNotifiedAt = new Date().toISOString();
          changed = true;
        }
        const lastOverdue = message.overdueNotifiedAt ? new Date(message.overdueNotifiedAt).getTime() : 0;
        if (due <= now && now - lastOverdue >= OVERDUE_REPEAT_MS) {
          // Assignees every day it's overdue; the person who asked, too.
          const keys = [...assigneeKeys, senderKeyOf(message)].filter(Boolean);
          deps.sendPush(pushKeysFor(keys), { ...payload, title: `⚠️ Overdue task (${message.mentions.map((key) => userForKey(String(key))?.name).filter(Boolean).join(", ")})`, body: `${text}\nWas due ${whenLabel(message.dueAt)}` });
          message.overdueNotifiedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    if (changed) deps.scheduleSave();
  } catch (err) {
    console.log("TASK REMINDER ERROR:", err.message);
  } finally {
    running = false;
  }
}

/* ---------- API ---------- */

export function registerTaskRoutes(app, { auth, getUserKey, canSeeChat, emitChat, sendPush, scheduleSave }) {
  deps = { sendPush, scheduleSave };

  app.get("/internal/tasks", auth, (req, res) => {
    const me = getUserKey(req.user);
    const scope = req.query.scope || "mine";
    let tasks = allTasks().filter((task) => {
      const chat = global.internalChats.find((item) => String(item.id) === String(task.chatId));
      return chat && canSeeChat(chat, req.user);
    });
    if (scope === "mine") tasks = tasks.filter((task) => task.assignees.some((person) => person.key === me));
    if (scope === "created") tasks = tasks.filter((task) => task.createdByKey === me);
    // Resolved tasks show for 14 days so the board stays short.
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    tasks = tasks.filter((task) => task.status !== "resolved" || new Date(task.completedAt || task.statusUpdatedAt || task.createdAt).getTime() > cutoff);
    tasks.sort((a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)
      || (a.dueAt && b.dueAt ? new Date(a.dueAt) - new Date(b.dueAt) : a.dueAt ? -1 : b.dueAt ? 1 : 0)
      || new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ me, tasks });
  });

  // Change a task's due date or status from the Tasks board.
  app.patch("/internal/tasks/:chatId/:messageId", auth, (req, res) => {
    const found = findTask(req.params.chatId, req.params.messageId);
    if (!found || !canSeeChat(found.chat, req.user)) return res.status(404).json({ error: "Task not found" });
    const { chat, message } = found;
    const me = getUserKey(req.user);
    const myName = req.user?.owner ? "Admin" : req.user?.name || "Admin";
    const tagged = message.mentions.map(String).includes(me);
    const isCreator = senderKeyOf(message) === me;

    if (req.body?.dueAt !== undefined) {
      if (!tagged && !isCreator && !req.user?.isAdmin) return res.status(403).json({ error: "Only the person who asked, the tagged people or an admin can change the due date" });
      const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) return res.status(400).json({ error: "Invalid due date" });
      message.dueAt = dueAt ? dueAt.toISOString() : null;
      message.dueSoonNotifiedAt = null;
      message.overdueNotifiedAt = null;
      addHistory(message, myName, dueAt ? `set due ${whenLabel(message.dueAt)}` : "removed the due date");
      res.locals.activity = { section: "Internal Chat", action: `${dueAt ? `Set due date ${whenLabel(message.dueAt)}` : "Removed the due date"} on task "${String(message.text || "").slice(0, 60)}"` };
    }
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
      // Same rule as the chat: only the people tagged move a task along.
      if (!tagged) return res.status(403).json({ error: "Only the people tagged in this task can change its status" });
      message.status = req.body.status;
      message.statusUpdatedBy = myName;
      message.statusUpdatedByKey = me;
      message.statusUpdatedAt = new Date().toISOString();
      message.completedAt = req.body.status === "resolved" ? message.statusUpdatedAt : null;
      addHistory(message, myName, { open: "reopened", "in-progress": "started", resolved: "resolved" }[req.body.status]);
      res.locals.activity = { section: "Internal Chat", action: `Marked task "${String(message.text || "").slice(0, 60)}" as ${req.body.status.replace("-", " ")}` };
      if (req.body.status === "resolved") {
        const creator = senderKeyOf(message);
        if (creator && creator !== me) sendPush(pushKeysFor([creator]), { chatId: String(chat.id), department: chat.department, view: "tasks", title: `✅ ${myName} resolved your task`, body: String(message.text || "").slice(0, 150) });
      }
    }
    emitChat(chat, "internal-chat-updated", { chat });
    scheduleSave();
    res.json({ task: toTask(chat, message) });
  });

  // What each person completed (and how punctually) over the last N days.
  app.get("/internal/tasks/stats", auth, (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const tasks = allTasks().filter((task) => {
      const chat = global.internalChats.find((item) => String(item.id) === String(task.chatId));
      return chat && canSeeChat(chat, req.user);
    });
    const people = new Map();
    const row = (person) => {
      if (!people.has(person.key)) people.set(person.key, { key: person.key, name: person.name, department: person.department || "", assigned: 0, done: 0, onTime: 0, withDue: 0, open: 0, overdue: 0, hoursTotal: 0 });
      return people.get(person.key);
    };
    for (const task of tasks) {
      for (const person of task.assignees) {
        const stats = row(person);
        if (new Date(task.createdAt).getTime() >= since) stats.assigned += 1;
        if (task.status !== "resolved") {
          stats.open += 1;
          if (task.overdue) stats.overdue += 1;
        }
      }
      if (task.status === "resolved" && task.completedAt && new Date(task.completedAt).getTime() >= since) {
        // Credit goes to whoever resolved it (or every assignee for older tasks).
        const message = findTask(task.chatId, task.messageId)?.message;
        const resolverKey = message?.statusUpdatedByKey;
        const credited = resolverKey ? task.assignees.filter((person) => person.key === resolverKey) : task.assignees;
        for (const person of credited.length ? credited : task.assignees) {
          const stats = row(person);
          stats.done += 1;
          stats.hoursTotal += Math.max(0, (new Date(task.completedAt) - new Date(task.createdAt)) / 3600000);
          if (task.dueAt) {
            stats.withDue += 1;
            if (new Date(task.completedAt) <= new Date(task.dueAt)) stats.onTime += 1;
          }
        }
      }
    }
    const rows = [...people.values()].map((stats) => ({
      ...stats,
      avgHours: stats.done ? Math.round((stats.hoursTotal / stats.done) * 10) / 10 : null,
      onTimeRate: stats.withDue ? Math.round((stats.onTime / stats.withDue) * 100) : null,
    })).sort((a, b) => b.done - a.done || a.overdue - b.overdue || a.name.localeCompare(b.name));
    res.json({ days, rows });
  });
}
