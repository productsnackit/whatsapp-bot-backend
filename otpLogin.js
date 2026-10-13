/* =========================================================
    LOGIN WITH A ONE-TIME CODE (OTP) ON WHATSAPP
    Anyone with a WhatsApp number on file can log in with a code instead of their password:
    employees (Employees & Access → WhatsApp number), refillers (Refill Audit → Refillers) and the
    owner (ADMIN_PHONE). They type their number, get a 6-digit code on WhatsApp, type it in.
      • a code works for 5 minutes and 5 tries; a new code at most every 45 seconds, 5 an hour;
      • codes are never stored as typed (only a hash) and never logged.
    WhatsApp only delivers to someone who hasn't messaged us in 24 hours through an approved
    template: create an "Authentication" template in Meta (with a copy-code button) and set
    OTP_TEMPLATE_NAME (default "login_code") and OTP_TEMPLATE_LANG (default "en"). Without it the
    code goes as a normal message, which only reaches people who messaged us in the last day.
========================================================= */
import crypto from "crypto";
import { sendWhatsAppPayload } from "./whatsapp.js";

const CODE_MINUTES = 5;
const pending = new Map(); // phone → { hash, expires, tries, sends: [times] }
const phoneDigits = (phone) => { const digits = String(phone || "").replace(/\D/g, ""); return digits.length === 10 ? `91${digits}` : digits; };
const hashOf = (phone, code) => crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");

async function sendCode(phone, code) {
  const name = process.env.OTP_TEMPLATE_NAME || "login_code";
  const viaTemplate = await sendWhatsAppPayload({
    messaging_product: "whatsapp", to: phone, type: "template",
    template: {
      name, language: { code: process.env.OTP_TEMPLATE_LANG || "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
      ],
    },
  }).catch((err) => ({ ok: false, error: err.message }));
  if (viaTemplate?.ok) return { ok: true };
  console.log(`OTP template "${name}" failed, trying a normal message:`, viaTemplate?.error);
  const plain = await sendWhatsAppPayload({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: `${code} is your Snackit login code. It works for ${CODE_MINUTES} minutes. Don't share it with anyone.` } });
  return { ok: Boolean(plain?.ok) };
}

// findAccount(phone) → an account or null; startSession(account, req) → the login response.
export function registerOtpRoutes(app, { findAccount, startSession }) {
  app.post("/login/otp/send", async (req, res) => {
    try {
      const phone = phoneDigits(req.body?.phone);
      if (!/^\d{11,13}$/.test(phone)) return res.status(400).json({ error: "Enter your 10-digit mobile number" });
      const account = await findAccount(phone);
      if (!account) return res.status(404).json({ error: "This number isn't registered. Ask the office to add your WhatsApp number, or log in with your password." });
      const now = Date.now();
      const entry = pending.get(phone) || { sends: [] };
      entry.sends = entry.sends.filter((at) => now - at < 3600000);
      const last = entry.sends[entry.sends.length - 1];
      if (last && now - last < 45000) return res.status(429).json({ error: `Please wait ${Math.ceil((45000 - (now - last)) / 1000)} seconds before asking for a new code.` });
      if (entry.sends.length >= 5) return res.status(429).json({ error: "Too many codes asked for. Try again in an hour, or log in with your password." });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const sent = await sendCode(phone, code);
      if (!sent.ok) return res.status(502).json({ error: "Couldn't send the code on WhatsApp. Please log in with your password, or try again." });
      pending.set(phone, { hash: hashOf(phone, code), expires: now + CODE_MINUTES * 60000, tries: 0, sends: [...entry.sends, now] });
      res.json({ success: true, to: `+${phone.slice(0, 2)} ••••• ${phone.slice(-5)}`, minutes: CODE_MINUTES });
    } catch (err) {
      console.log("OTP SEND ERROR:", err.message);
      res.status(500).json({ error: "Couldn't send the code. Please try again." });
    }
  });

  app.post("/login/otp/verify", async (req, res) => {
    try {
      const phone = phoneDigits(req.body?.phone);
      const code = String(req.body?.code || "").replace(/\D/g, "");
      const entry = pending.get(phone);
      if (!entry || Date.now() > entry.expires) return res.status(401).json({ error: "The code has expired. Tap “Send code” again." });
      if (entry.tries >= 5) { pending.delete(phone); return res.status(401).json({ error: "Too many wrong codes. Ask for a new code." }); }
      const good = crypto.timingSafeEqual(Buffer.from(hashOf(phone, code)), Buffer.from(entry.hash));
      if (!good) { entry.tries += 1; return res.status(401).json({ error: `Wrong code. ${5 - entry.tries} tries left.` }); }
      pending.delete(phone);
      const account = await findAccount(phone);
      if (!account) return res.status(401).json({ error: "This number isn't registered any more." });
      res.json(await startSession(account, req));
    } catch (err) {
      console.log("OTP VERIFY ERROR:", err.message);
      res.status(500).json({ error: "Couldn't log you in. Please try again." });
    }
  });
}
