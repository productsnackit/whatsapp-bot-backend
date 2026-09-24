/* =========================================================
    PHONE NOTIFICATIONS FOR INTERNAL CHAT (Web Push)
    Each device that turns on notifications is saved against the
    person's username ("admin" for the admin login), so it survives
    server restarts even though employee ids and sessions do not.
    VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are
    generated once and kept in the database.
========================================================= */
import webpush from "web-push";

let ready = null;

async function setup(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_key TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query("CREATE INDEX IF NOT EXISTS push_subscriptions_user_key ON push_subscriptions (user_key)");
  await db.query("CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    const saved = await db.query("SELECT value FROM app_secrets WHERE key = 'vapid_keys'");
    if (saved.rows[0]) {
      ({ publicKey, privateKey } = JSON.parse(saved.rows[0].value));
    } else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      await db.query(
        "INSERT INTO app_secrets (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ publicKey, privateKey })]
      );
      // Another instance may have saved keys first; always use the stored pair.
      ({ publicKey, privateKey } = JSON.parse((await db.query("SELECT value FROM app_secrets WHERE key = 'vapid_keys'")).rows[0].value));
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:product@snackit.in", publicKey, privateKey);
  return publicKey;
}

function pushReady(db) {
  if (!ready) {
    ready = setup(db).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

export function pushUserKey(user) {
  return user?.role === "admin" ? "admin" : String(user?.username || "");
}

export function registerPushRoutes(app, { db, auth }) {
  pushReady(db).catch((err) => console.error("PUSH SETUP ERROR:", err.message));

  app.get("/internal/push/public-key", auth, async (req, res) => {
    try {
      res.json({ publicKey: await pushReady(db) });
    } catch (err) {
      res.status(500).json({ error: "Notifications are not available right now" });
    }
  });

  app.post("/internal/push/subscribe", auth, async (req, res) => {
    try {
      const subscription = req.body?.subscription;
      const userKey = pushUserKey(req.user);
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth || !userKey) {
        return res.status(400).json({ error: "Invalid subscription" });
      }
      await pushReady(db);
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, user_key, subscription) VALUES ($1, $2, $3)
         ON CONFLICT (endpoint) DO UPDATE SET user_key = EXCLUDED.user_key, subscription = EXCLUDED.subscription`,
        [subscription.endpoint, userKey, subscription]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("PUSH SUBSCRIBE ERROR:", err.message);
      res.status(500).json({ error: "Could not turn on notifications" });
    }
  });

  app.post("/internal/push/unsubscribe", auth, async (req, res) => {
    try {
      if (req.body?.endpoint) await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [req.body.endpoint]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Could not turn off notifications" });
    }
  });
}

// Fire-and-forget: never blocks or fails the chat request.
export async function sendPushToUsers(db, userKeys, payload) {
  try {
    const keys = [...new Set(userKeys.filter(Boolean).map(String))];
    if (!keys.length) return;
    await pushReady(db);
    const { rows } = await db.query("SELECT endpoint, subscription FROM push_subscriptions WHERE user_key = ANY($1)", [keys]);
    const body = JSON.stringify(payload);
    await Promise.all(rows.map(async ({ endpoint, subscription }) => {
      try {
        await webpush.sendNotification(subscription, body, { TTL: 60 * 60 * 24, urgency: "high" });
      } catch (err) {
        // The phone uninstalled the app or turned notifications off.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
        } else {
          console.error("PUSH SEND ERROR:", err.statusCode || "", err.message);
        }
      }
    }));
  } catch (err) {
    console.error("PUSH ERROR:", err.message);
  }
}
