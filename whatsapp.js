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