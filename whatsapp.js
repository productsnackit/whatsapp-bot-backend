import axios from "axios";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

function sanitizeWhatsAppBody(message) {
  return String(message || "")
    .replace(/[❌✅💳💸🔒📸⚠️📍🔄⏳📦📷🚫💰🧾₹]/gu, "")   // 👈 added u flag
    .replace(/\*\*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendWhatsApp(to, message) {
  try {
    const safeMessage = sanitizeWhatsAppBody(message);
    const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

    const data = {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: {
        body: safeMessage,
      },
    };

    const response = await axios.post(url, data, {
  headers: {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
});

console.log("✅ WhatsApp Meta response:", response.data);
console.log("✅ WhatsApp sent to:", to);
  } catch (err) {
    console.log("❌ WhatsApp send error:", err.response?.data || err.message);
  }
}

// Used for refiller CAPA tasks: report the outcome instead of only logging it,
// so the dashboard can show whether the task reached the refiller.
async function postToWhatsApp(data) {
  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, data, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    return { ok: true, id: response.data?.messages?.[0]?.id || null };
  } catch (err) {
    const error = err.response?.data?.error;
    console.log("❌ WhatsApp send error:", error || err.message);
    return { ok: false, code: error?.code || null, error: error?.error_data?.details || error?.message || err.message };
  }
}

// Message with up to 3 reply buttons ([{ id, title }], title max 20 characters).
// WhatsApp only delivers this within 24 hours of the person's last message to us.
export function sendWhatsAppButtons(to, body, buttons) {
  return postToWhatsApp({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body).slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map(({ id, title }) => ({ type: "reply", reply: { id, title: String(title).slice(0, 20) } })) },
    },
  });
}

// Meta-approved template: works any time. bodyParams fill {{1}}, {{2}}…; buttonPayloads go to its quick-reply buttons in order.
export function sendWhatsAppTemplate(to, name, language, bodyParams = [], buttonPayloads = []) {
  return postToWhatsApp({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [
        { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) },
        ...buttonPayloads.map((payload, index) => ({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] })),
      ],
    },
  });
}
