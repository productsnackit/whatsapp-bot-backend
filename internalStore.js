/* =========================================================
    INTERNAL CHAT STORAGE
    Internal chat lives in memory (global.internalChats, internalUsers,
    internalSessions, internalSavedReplies). This saves it to Postgres after
    every change and loads it back on start, so a restart or redeploy no longer
    wipes chats, logs everyone out or changes employee ids.
========================================================= */

let db = null;
let saveTimer = null;
let saving = Promise.resolve();
const savedChatJson = new Map(); // chat id -> JSON last written, so only changed chats are rewritten

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS internal_state (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS internal_chats (
      id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
}

async function writeState(key, value) {
  await db.query(
    `INSERT INTO internal_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function saveNow() {
  await writeState("users", global.internalUsers || []);
  await writeState("sessions", Object.fromEntries(global.internalSessions || []));
  await writeState("saved_replies", global.internalSavedReplies || []);

  const chats = Array.isArray(global.internalChats) ? global.internalChats : [];
  const liveIds = new Set();
  for (const [index, chat] of chats.entries()) {
    const id = String(chat.id);
    liveIds.add(id);
    // Keep the list order (newest first) when loading back.
    const json = JSON.stringify({ ...chat, _order: index });
    if (savedChatJson.get(id) === json) continue;
    await db.query(
      `INSERT INTO internal_chats (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [id, json]
    );
    savedChatJson.set(id, json);
  }
  for (const id of [...savedChatJson.keys()]) {
    if (liveIds.has(id)) continue;
    await db.query("DELETE FROM internal_chats WHERE id = $1", [id]);
    savedChatJson.delete(id);
  }
}

// Save shortly after a change; several quick changes are written together.
export function scheduleInternalSave() {
  if (!db) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving
      .then(saveNow)
      .catch((err) => console.error("INTERNAL CHAT SAVE ERROR:", err.message));
  }, 500);
}

// Call once before the server starts taking requests.
export async function loadInternalState(database) {
  db = database;
  await ensureTables();

  const { rows } = await db.query("SELECT key, value FROM internal_state");
  const state = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (Array.isArray(state.users) && state.users.length) global.internalUsers = state.users;
  if (state.sessions && typeof state.sessions === "object") global.internalSessions = new Map(Object.entries(state.sessions));
  if (Array.isArray(state.saved_replies)) global.internalSavedReplies = state.saved_replies;

  const chats = await db.query("SELECT id, data FROM internal_chats");
  if (chats.rows.length) {
    global.internalChats = chats.rows
      .map((row) => {
        savedChatJson.set(row.id, JSON.stringify(row.data));
        return row.data;
      })
      .sort((a, b) => (a._order ?? 0) - (b._order ?? 0))
      .map(({ _order, ...chat }) => chat);
  }
  console.log(`✅ Internal chat loaded: ${global.internalChats.length} chats, ${global.internalUsers.length} users, ${global.internalSessions.size} sessions`);

  // First run: store the starting employee list so their ids stay fixed from now on.
  if (!state.users) await saveNow();
}

// Saves after any change made through these routes (anything but a read).
export function internalSaveMiddleware(req, res, next) {
  if (req.method !== "GET") res.on("finish", () => { if (res.statusCode < 400) scheduleInternalSave(); });
  next();
}
