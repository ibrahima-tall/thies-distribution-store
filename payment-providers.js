const crypto = require("node:crypto");

const onlineMethods = new Set(["mobile_money", "card"]);
const providerMethods = {
  paydunya: new Set(["mobile_money", "card"]),
  cinetpay: new Set(["mobile_money", "card"]),
  fedapay: new Set(["mobile_money", "card"])
};
const providerNames = { paydunya: "PayDunya", cinetpay: "CinetPay", fedapay: "FedaPay" };
const checkoutDomains = {
  paydunya: "paydunya.com",
  cinetpay: "cinetpay.com",
  fedapay: "fedapay.com"
};

function publicUrl() {
  const value = process.env.TRD_PUBLIC_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isProviderConfigured(provider) {
  if (!publicUrl()) return false;
  if (provider === "paydunya") {
    return Boolean(process.env.PAYDUNYA_MASTER_KEY && process.env.PAYDUNYA_PRIVATE_KEY && process.env.PAYDUNYA_TOKEN && process.env.TRD_STORE_NAME);
  }
  if (provider === "cinetpay") {
    return Boolean(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID);
  }
  if (provider === "fedapay") {
    return Boolean(process.env.FEDAPAY_SECRET_KEY);
  }
  return false;
}

function listConfiguredProviders() {
  return Object.keys(providerNames)
    .filter(isProviderConfigured)
    .map(id => ({
      id,
      name: providerNames[id],
      methods: [...providerMethods[id]]
    }));
}

function safePaymentUrl(value, provider) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Le prestataire n’a pas renvoyé un lien de paiement valide.");
  }
  const allowedDomain = checkoutDomains[provider];
  if (url.protocol !== "https:" || url.username || url.password ||
      !allowedDomain || (url.hostname !== allowedDomain && !url.hostname.endsWith(`.${allowedDomain}`))) {
    throw new Error("Le lien de paiement renvoyé par le prestataire est invalide ou non sécurisé.");
  }
  return url.toString();
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(`Le prestataire de paiement est momentanément inaccessible : ${error.message}`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Réponse invalide du prestataire de paiement (HTTP ${response.status}).`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Réponse invalide du prestataire de paiement (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    console.error("Payment provider error", { status: response.status, providerCode: data.code || data.response_code });
    throw new Error("Le prestataire a refusé la requête. Vérifiez la configuration marchande.");
  }
  return data;
}

function nameParts(fullName) {
  const [firstname, ...rest] = fullName.trim().split(/\s+/);
  return { firstname: firstname || "Client", lastname: rest.join(" ") || firstname || "Client" };
}

function senegalPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  const localNumber = digits.startsWith("00221") ? digits.slice(5) :
    digits.startsWith("221") ? digits.slice(3) : digits.replace(/^0/, "");
  if (!/^\d{9}$/.test(localNumber)) {
    throw Object.assign(new Error("Le numéro de téléphone doit être un numéro sénégalais valide."), { status: 400 });
  }
  return localNumber;
}

function buildReturnUrl(orderNumber) {
  const url = new URL("/", publicUrl());
  url.searchParams.set("payment", "return");
  url.searchParams.set("order", orderNumber);
  return url.toString();
}

function buildNotifyUrl(provider) {
  return new URL(`/api/payments/notify/${provider}`, `${publicUrl()}/`).toString();
}

async function createPayDunyaCheckout(order) {
  const sandbox = (process.env.PAYDUNYA_MODE || "test").toLowerCase() !== "live";
  const baseUrl = sandbox ? "https://app.paydunya.com/sandbox-api/v1" : "https://app.paydunya.com/api/v1";
  const items = Object.fromEntries(order.items.map((item, index) => [`item_${index}`, {
    name: item.name,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.unitPrice * item.quantity,
    description: item.name
  }]));
  if (order.shippingFee) {
    items.shipping = { name: "Livraison", quantity: 1, unit_price: order.shippingFee, total_price: order.shippingFee, description: "Frais de livraison" };
  }
  const result = await requestJson(`${baseUrl}/checkout-invoice/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
      "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
      "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN
    },
    body: JSON.stringify({
      invoice: { total_amount: order.total, description: `Commande ${order.orderNumber}`, items },
      store: { name: process.env.TRD_STORE_NAME, phone: order.customer.phone, website_url: publicUrl() },
      custom_data: { order_number: order.orderNumber },
      actions: {
        return_url: buildReturnUrl(order.orderNumber),
        cancel_url: buildReturnUrl(order.orderNumber),
        callback_url: buildNotifyUrl("paydunya")
      }
    })
  });
  if (result.response_code !== "00" || !result.token) {
    throw new Error("PayDunya n’a pas pu créer cette facture. Vérifiez le mode et les clés API.");
  }
  return { reference: String(result.token), checkoutUrl: safePaymentUrl(result.response_text, "paydunya") };
}

async function createCinetPayCheckout(order) {
  const customerName = nameParts(order.customer.name);
  const phone = senegalPhone(order.customer.phone);
  const result = await requestJson("https://api-checkout.cinetpay.com/v2/payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: process.env.CINETPAY_API_KEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: order.orderNumber,
      amount: order.total,
      currency: "XOF",
      description: `Commande ${order.orderNumber}`,
      customer_id: `221${phone}`,
      customer_name: customerName.firstname,
      customer_surname: customerName.lastname,
      customer_email: order.customer.email || "client@trdtech.sn",
      customer_phone_number: `221${phone}`,
      customer_address: order.customer.address,
      customer_city: "Dakar",
      customer_country: "SN",
      customer_state: "Dakar",
      customer_zip_code: "00000",
      return_url: buildReturnUrl(order.orderNumber),
      notify_url: buildNotifyUrl("cinetpay"),
      channels: order.paymentMethod === "card" ? "CREDIT_CARD" : "MOBILE_MONEY",
      metadata: order.orderNumber,
      lang: "fr"
    })
  });
  if (result.code !== "201" || !result.data?.payment_url) {
    console.error("CinetPay checkout rejected", { code: result.code, message: result.message });
    throw new Error("CinetPay n’a pas pu créer ce paiement. Vérifiez le site ID et les clés API.");
  }
  return { reference: order.orderNumber, checkoutUrl: safePaymentUrl(result.data.payment_url, "cinetpay") };
}

async function createFedaPayCheckout(order) {
  const sandbox = (process.env.FEDAPAY_MODE || "sandbox").toLowerCase() !== "live";
  const apiUrl = sandbox ? "https://sandbox-api.fedapay.com/v1" : "https://api.fedapay.com/v1";
  const customerName = nameParts(order.customer.name);
  const phone = senegalPhone(order.customer.phone);
  const result = await requestJson(`${apiUrl}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}` },
    body: JSON.stringify({
      description: `Commande ${order.orderNumber}`,
      amount: order.total,
      currency: { iso: "XOF" },
      mode: order.paymentMethod === "mobile_money" ? "free_sn" : "card",
      callback_url: buildReturnUrl(order.orderNumber),
      custom_metadata: { order_number: order.orderNumber },
      customer: {
        email: order.customer.email || undefined,
        firstname: customerName.firstname,
        lastname: customerName.lastname,
        phone_number: { number: Number(phone), country: "SN" }
      }
    })
  });
  const transaction = result["v1/transactions"] || result.transaction || result.data || result;
  if (!transaction.id) throw new Error("FedaPay n’a pas renvoyé de référence de transaction.");
  const tokenResult = await requestJson(`${apiUrl}/transactions/${encodeURIComponent(transaction.id)}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}` }
  });
  const token = tokenResult["v1/transactions"] || tokenResult.transaction || tokenResult.data || tokenResult;
  return {
    reference: String(transaction.id),
    checkoutUrl: safePaymentUrl(token.url || token.payment_url, "fedapay")
  };
}

async function createCheckout(provider, order) {
  if (!isProviderConfigured(provider)) {
    throw Object.assign(new Error(`${providerNames[provider] || "Ce prestataire"} n’est pas configuré. Ajoutez ses clés et l’URL publique HTTPS au serveur.`), { status: 503 });
  }
  if (!providerMethods[provider]?.has(order.paymentMethod) || !onlineMethods.has(order.paymentMethod)) {
    throw Object.assign(new Error(`${providerNames[provider]} ne prend pas en charge ce mode de paiement pour le Sénégal.`), { status: 400 });
  }
  if (provider === "paydunya") return createPayDunyaCheckout(order);
  if (provider === "cinetpay") return createCinetPayCheckout(order);
  return createFedaPayCheckout(order);
}

function providerHeaders(provider) {
  if (provider === "paydunya") {
    return {
      "PAYDUNYA-MASTER-KEY": process.env.PAYDUNYA_MASTER_KEY,
      "PAYDUNYA-PRIVATE-KEY": process.env.PAYDUNYA_PRIVATE_KEY,
      "PAYDUNYA-TOKEN": process.env.PAYDUNYA_TOKEN
    };
  }
  if (provider === "fedapay") return { Authorization: `Bearer ${process.env.FEDAPAY_SECRET_KEY}` };
  return {};
}

async function verifyPayDunya(order) {
  const sandbox = (process.env.PAYDUNYA_MODE || "test").toLowerCase() !== "live";
  const baseUrl = sandbox ? "https://app.paydunya.com/sandbox-api/v1" : "https://app.paydunya.com/api/v1";
  const result = await requestJson(`${baseUrl}/checkout-invoice/confirm/${encodeURIComponent(order.paymentReference)}`, {
    headers: providerHeaders("paydunya")
  });
  const invoice = result.invoice || result;
  return {
    paid: invoice.status === "completed" && Number(invoice.total_amount) === order.total &&
      String(invoice.custom_data?.order_number || "") === order.orderNumber,
    failed: ["failed", "cancelled"].includes(invoice.status),
    reference: String(order.paymentReference)
  };
}

async function verifyCinetPay(order) {
  const result = await requestJson("https://api-checkout.cinetpay.com/v2/payment/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: process.env.CINETPAY_API_KEY,
      site_id: process.env.CINETPAY_SITE_ID,
      transaction_id: order.orderNumber
    })
  });
  const transaction = result.data || {};
  return {
    paid: result.code === "00" && transaction.status === "ACCEPTED" &&
      String(transaction.transaction_id || "") === order.orderNumber &&
      Number(transaction.amount) === order.total && transaction.currency === "XOF",
    failed: ["REFUSED", "CANCELED", "CANCELLED"].includes(String(transaction.status || "").toUpperCase()),
    reference: order.orderNumber
  };
}

async function verifyFedaPay(order) {
  const sandbox = (process.env.FEDAPAY_MODE || "sandbox").toLowerCase() !== "live";
  const apiUrl = sandbox ? "https://sandbox-api.fedapay.com/v1" : "https://api.fedapay.com/v1";
  const result = await requestJson(`${apiUrl}/transactions/${encodeURIComponent(order.paymentReference)}`, {
    headers: providerHeaders("fedapay")
  });
  const transaction = result["v1/transactions"] || result.transaction || result.data || result;
  return {
    paid: transaction.status === "approved" && Number(transaction.amount) === order.total &&
      String(transaction.id || "") === String(order.paymentReference) &&
      String(transaction.custom_metadata?.order_number || transaction.metadata?.order_number || "") === order.orderNumber,
    failed: ["canceled", "declined"].includes(String(transaction.status || "").toLowerCase()),
    reference: String(transaction.id)
  };
}

async function verifyPayment(order) {
  if (!order.paymentProvider || !order.paymentReference || !isProviderConfigured(order.paymentProvider)) {
    throw new Error("Les informations de vérification du paiement sont absentes ou le prestataire n’est plus configuré.");
  }
  if (order.paymentProvider === "paydunya") return verifyPayDunya(order);
  if (order.paymentProvider === "cinetpay") return verifyCinetPay(order);
  if (order.paymentProvider === "fedapay") return verifyFedaPay(order);
  throw new Error("Prestataire de paiement inconnu.");
}

function webhookReference(provider, body) {
  if (provider === "paydunya") {
    let data = body.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    return String(body.token || data?.token || body["data[token]"] || "");
  }
  if (provider === "cinetpay") return String(body.cpm_trans_id || body.transaction_id || "");
  if (provider === "fedapay") return String(body.entity?.id || body.data?.id || body.id || "");
  return "";
}

function compareFedaPaySignature(providedSignature, rawBody) {
  const secret = process.env.FEDAPAY_WEBHOOK_SECRET;
  if (!secret || typeof providedSignature !== "string" || typeof rawBody !== "string") return false;
  const signatureParts = providedSignature.split(",").map(part => {
    const separator = part.indexOf("=");
    return separator < 0 ? null : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(Boolean);
  const timestamp = Number(signatureParts.find(([key]) => key === "t")?.[1]);
  const signatures = signatureParts.filter(([key]) => key === "s").map(([, value]) => value);
  if (!Number.isSafeInteger(timestamp) || !signatures.length ||
      Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  return signatures.some(signature => {
    if (!/^[a-f\d]{64}$/i.test(signature)) return false;
    const received = Buffer.from(signature, "hex");
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  });
}

async function resolveWebhookReference(provider, body) {
  if (provider !== "fedapay") return webhookReference(provider, body);
  const eventId = body.id || body.data?.id;
  if (!eventId) return "";
  const sandbox = (process.env.FEDAPAY_MODE || "sandbox").toLowerCase() !== "live";
  const apiUrl = sandbox ? "https://sandbox-api.fedapay.com/v1" : "https://api.fedapay.com/v1";
  const result = await requestJson(`${apiUrl}/events/${encodeURIComponent(eventId)}`, {
    headers: providerHeaders("fedapay")
  });
  const event = result["v1/events"] || result.event || result.data || result;
  return String(event.entity?.id || event.object_id || "");
}

function referenceMatches(provider, order, reference) {
  if (provider === "cinetpay") return order.orderNumber === reference && order.paymentProvider === provider;
  return order.paymentReference === reference && order.paymentProvider === provider;
}

function getProviderMethods(provider) {
  return providerMethods[provider] ? [...providerMethods[provider]] : [];
}

function comparePayDunyaHash(providedHash) {
  const masterKey = process.env.PAYDUNYA_MASTER_KEY;
  if (!masterKey || typeof providedHash !== "string" || !/^[a-f\d]{128}$/i.test(providedHash)) return false;
  const expected = Buffer.from(crypto.createHash("sha512").update(masterKey).digest("hex"), "hex");
  let received;
  try { received = Buffer.from(providedHash, "hex"); } catch { return false; }
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = {
  createCheckout,
  comparePayDunyaHash,
  compareFedaPaySignature,
  getProviderMethods,
  isProviderConfigured,
  listConfiguredProviders,
  onlineMethods,
  referenceMatches,
  resolveWebhookReference,
  verifyPayment,
  webhookReference
};
