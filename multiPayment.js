/* =========================================================
    CHARGED MORE THAN ONCE
    Refund option 5: the customer paid several times for one purchase. The bot asks whether
    they got a product and how many times they were charged, then takes each payment (a
    screenshot, read automatically, or a typed transaction ID). Every payment is kept in the
    ticket's "payments" list:
      { utr, app_id, app, amount, amount_uncertain, image, source: "screenshot" | "typed" }
    Refund policy: got nothing → everything paid; got one product → everything but one payment.
========================================================= */

export const CHARGED_MORE_THAN_ONCE = "Charged More Than Once";

export const PRODUCT_QUESTION = `🛒 *DID YOU GET A PRODUCT?*

1️⃣ Yes, I got one product
2️⃣ No, I got nothing

Please reply with *1* or *2*`;

export const COUNT_QUESTION = `💳 *HOW MANY TIMES WERE YOU CHARGED?*

Reply with the number, e.g. *2*`;

export function paymentPrompt(number, total) {
  return `📸 *SEND PAYMENT ${number} OF ${total}*

Send the screenshot of this payment from your UPI app (GPay, PhonePe, Paytm…). We'll read the transaction ID and amount from it.

You can also type the transaction ID instead.${number > 1 ? "\n\nReply *DONE* if you have no more payments." : ""}`;
}

const COUNT_WORDS = { once: 1, one: 1, twice: 2, two: 2, double: 2, thrice: 3, three: 3, triple: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "2", "2 times", "twice", "three" → the number; anything else → null.
export function parseChargeCount(text) {
  const value = String(text || "").toLowerCase();
  const number = value.match(/\b(\d{1,2})\b/);
  if (number) return Number(number[1]);
  const word = value.split(/[^a-z]+/).find((item) => COUNT_WORDS[item]);
  return word ? COUNT_WORDS[word] : null;
}

// Every transaction ID in a message: "663761717225 663761741945", one per line, or typed in
// groups ("6637 6171 7225"). 12-digit UPI IDs, PhonePe's T-IDs and long order IDs count;
// phone numbers (10 digits) and amounts don't.
export function extractTransactionIds(text) {
  const value = String(text || "").replace(/\b(\d{4})[ -](\d{4})[ -](\d{4})\b/g, "$1$2$3");
  const ids = [];
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
    const phonePe = /^T\d{20,23}$/i.test(token);
    const digits = (token.match(/\d/g) || []).length;
    if (phonePe || /^\d{12}$/.test(token) || (token.length >= 12 && token.length <= 35 && digits >= 8)) {
      const id = phonePe ? token.toUpperCase() : token;
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// The one ID shown for a payment: PhonePe's own transaction ID, else the UPI transaction ID.
export function paymentId(payment) {
  if (payment?.app === "PhonePe" && /^T\d{22}$/.test(payment.app_id || "")) return payment.app_id;
  return payment?.utr || "";
}

export const paymentIds = (payment) => [payment?.utr, payment?.app_id].filter(Boolean);

// What to refund, when every amount is known: null when the team has to decide.
export function refundFor(payments, productReceived) {
  const list = (payments || []).filter((payment) => paymentId(payment) || payment.image);
  if (!list.length || productReceived == null) return null;
  if (list.some((payment) => payment.amount == null || payment.amount_uncertain)) return null;
  const total = list.reduce((sum, payment) => sum + Number(payment.amount), 0);
  if (!productReceived) return total;
  // Got one product: one payment was for it. Only clear when there are several equal payments.
  if (list.length < 2 || new Set(list.map((payment) => Number(payment.amount))).size !== 1) return null;
  return total - Number(list[0].amount);
}

const shortId = (id) => (id.length > 8 ? `…${id.slice(-4)}` : id);

// "Rs 20 · 663761717225" (₹ is removed from WhatsApp messages, so "Rs").
function paymentLine(payment) {
  const amount = payment.amount != null && !payment.amount_uncertain ? `Rs ${payment.amount}` : "";
  return [amount, paymentId(payment) || (payment.image ? "screenshot saved" : "")].filter(Boolean).join(" · ");
}

export function receivedMessage(payment, number) {
  const amount = payment.amount != null && !payment.amount_uncertain ? `Rs ${payment.amount}, ` : "";
  const id = paymentId(payment);
  return `✅ Payment ${number} received (${amount}${id ? shortId(id) : "screenshot"}).`;
}

export function doneMessage(payments, productReceived, { idle = false } = {}) {
  const list = payments.filter((payment) => paymentId(payment) || payment.image);
  return `${idle ? "We didn't hear from you for a while, so we've submitted your request with the payments you sent.\n\n" : ""}✅ *TICKET SUBMITTED SUCCESSFULLY!*

📋 We've received ${list.length === 1 ? "1 payment" : `${list.length} payments`}:
${list.map((payment, index) => `${index + 1}. ${paymentLine(payment)}`).join("\n")}

Our team will check ${list.length === 1 ? "it" : "them"} and refund ${productReceived ? "the extra amount" : "your money"} within 24 hours.

Thank you for choosing Snackit!`;
}

/* Adds what one message brought to the payments list.
   incoming: { screenshot } (one payment read from an image) or { typed: [ids] }.
   usedElsewhere(ids) → true when another request already has that payment.
   A typed ID first completes a screenshot whose ID couldn't be read. */
export async function mergePayments(current, incoming, usedElsewhere) {
  const payments = (current || []).map((payment) => ({ ...payment }));
  const notes = [];
  let added = null;
  const inList = (ids) => payments.some((payment) => paymentIds(payment).some((id) => ids.includes(id)));

  const check = async (ids) => {
    if (inList(ids)) {
      notes.push(`You already sent this payment (${shortId(ids[0])}).`);
      return false;
    }
    if (await usedElsewhere(ids)) {
      notes.push(`This payment (${shortId(ids[0])}) is already part of another request, so it wasn't added.`);
      return false;
    }
    return true;
  };

  if (incoming.screenshot) {
    const payment = incoming.screenshot;
    const ids = paymentIds(payment);
    if (!ids.length || (await check(ids))) {
      payments.push(payment);
      added = payment;
    }
  }

  for (const id of incoming.typed || []) {
    if (!(await check([id]))) continue;
    const waiting = payments.findLastIndex((payment) => !paymentId(payment));
    if (waiting >= 0) payments[waiting] = { ...payments[waiting], utr: id, id_typed: true };
    else payments.push({ utr: id, source: "typed" });
    added = payments[waiting >= 0 ? waiting : payments.length - 1];
  }
  // A screenshot whose ID couldn't be read (and no ID typed with it): the customer is asked to type it.
  return { payments, notes, added, needsId: Boolean(added && !paymentId(added)) };
}
