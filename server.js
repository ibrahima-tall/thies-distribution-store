const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Le chargement du fichier .env nécessite Node.js 20.12 ou plus récent.");
  }
  process.loadEnvFile(ENV_FILE);
}
const paymentProviders = require("./payment-providers");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.TRD_ADMIN_PASSWORD;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const trackingAttempts = new Map();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};
const allowedStatuses = new Set(["pending", "preparing", "shipped", "delivered", "cancelled"]);
const allowedPaymentStatuses = new Set(["awaiting_confirmation", "payable_on_delivery", "paid", "failed", "refunded", "cancelled"]);
const orderTransitions = {
  pending: new Set(["pending", "preparing", "cancelled"]),
  preparing: new Set(["preparing", "shipped", "cancelled"]),
  shipped: new Set(["shipped", "delivered", "cancelled"]),
  delivered: new Set(["delivered"]),
  cancelled: new Set(["cancelled"])
};

function initializeStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    const products = JSON.parse(fs.readFileSync(path.join(ROOT, "products.json"), "utf8"));
    writeStore({ products, orders: [] });
  }
  const store = readStore();
  let migrated = false;
  for (const order of store.orders) {
    if (order.status === "paid") {
      order.status = "pending";
      order.paymentStatus = "paid";
      migrated = true;
    } else if (order.paymentStatus === "pending") {
      order.paymentStatus = order.paymentMethod === "cod" ? "payable_on_delivery" : "awaiting_confirmation";
      migrated = true;
    }
    if (order.status === "cancelled" && !["paid", "refunded", "cancelled"].includes(order.paymentStatus)) {
      order.paymentStatus = "cancelled";
      migrated = true;
    }
  }
  if (migrated) writeStore(store);
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch (error) {
    throw new Error(`Impossible de lire le catalogue et les commandes : ${error.message}`);
  }
}

function writeStore(store) {
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STORE_FILE);
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...headers
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("La requête est trop volumineuse."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Le corps de la requête doit être un objet JSON."), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Le corps de la requête doit être un JSON valide."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function getSession(req) {
  const token = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("trd_admin="))?.slice("trd_admin=".length);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function assertCsrf(req, session) {
  if (req.headers["x-csrf-token"] !== session.csrfToken) {
    throw Object.assign(new Error("Jeton de sécurité invalide. Rechargez la page."), { status: 403 });
  }
}

function validateProduct(input) {
  const fields = ["name", "brand", "category", "condition", "image"];
  for (const field of fields) {
    if (typeof input[field] !== "string" || !input[field].trim() || input[field].length > 500) {
      throw Object.assign(new Error(`Le champ « ${field} » est obligatoire.`), { status: 400 });
    }
  }
  const priceOnRequest = input.priceOnRequest === true;
  const price = priceOnRequest ? null : Number(input.price);
  const stock = Number(input.stock);
  if ((!priceOnRequest && (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000)) ||
      !Number.isSafeInteger(stock) || stock < 0 || stock > 1_000_000) {
    throw Object.assign(new Error("Le prix ou le stock est invalide."), { status: 400 });
  }
  const oldPrice = input.oldPrice === null || input.oldPrice === "" || input.oldPrice === undefined ? null : Number(input.oldPrice);
  if (priceOnRequest && oldPrice !== null) {
    throw Object.assign(new Error("Un produit dont le prix est à confirmer ne peut pas avoir de prix barré."), { status: 400 });
  }
  if (oldPrice !== null && (!Number.isSafeInteger(oldPrice) || oldPrice < price)) {
    throw Object.assign(new Error("Le prix barré doit être supérieur ou égal au prix de vente."), { status: 400 });
  }
  const imagePath = input.image.trim();
  if (!/^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|svg)$/i.test(imagePath) ||
      !fs.existsSync(path.join(ROOT, imagePath.slice(1)))) {
    throw Object.assign(new Error("Choisissez une image locale disponible dans le dossier assets."), { status: 400 });
  }
  return {
    name: input.name.trim(), brand: input.brand.trim(), category: input.category.trim(),
    condition: input.condition.trim(), image: imagePath, price, oldPrice,
    priceOnRequest, description: typeof input.description === "string" ? input.description.trim().slice(0, 600) : "",
    stock, rating: 0, reviews: 0, tag: typeof input.tag === "string" ? input.tag.trim().slice(0, 40) : null,
    storage: String(input.storage || "—").slice(0, 80),
    ram: String(input.ram || "—").slice(0, 80),
    warranty: String(input.warranty || "12 mois").slice(0, 80)
  };
}

function validateCustomer(customer) {
  if (!customer || typeof customer !== "object") {
    throw Object.assign(new Error("Les coordonnées du client sont obligatoires."), { status: 400 });
  }
  const name = String(customer.name || "").trim();
  const phone = String(customer.phone || "").trim();
  const address = String(customer.address || "").trim();
  const normalizedPhone = normalizeSenegalPhone(phone);
  if (name.length < 2 || name.length > 120 || !/^[+0-9 ()-]{8,24}$/.test(phone) ||
      !normalizedPhone || address.length < 5 || address.length > 300) {
    throw Object.assign(new Error("Vérifiez le nom, le téléphone et l’adresse de livraison."), { status: 400 });
  }
  const email = String(customer.email || "").trim();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw Object.assign(new Error("L’adresse e-mail est invalide."), { status: 400 });
  }
  return { name, phone: normalizedPhone, address, email: email || null };
}

function normalizeSenegalPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const localNumber = digits.startsWith("00221") ? digits.slice(5) :
    digits.startsWith("221") ? digits.slice(3) : digits.replace(/^0/, "");
  return /^\d{9}$/.test(localNumber) ? `+221${localNumber}` : null;
}

function readWebhookBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("La notification du prestataire est trop volumineuse."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      try {
        if ((req.headers["content-type"] || "").toLowerCase().includes("application/x-www-form-urlencoded")) {
          resolve({ payload: Object.fromEntries(new URLSearchParams(rawBody)), rawBody });
        } else {
          const parsed = rawBody ? JSON.parse(rawBody) : {};
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(Object.assign(new Error("La notification doit contenir un objet."), { status: 400 }));
            return;
          }
          resolve({ payload: parsed, rawBody });
        }
      } catch {
        reject(Object.assign(new Error("Notification du prestataire invalide."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isOnlinePaymentMethod(method) {
  return paymentProviders.onlineMethods.has(method);
}

async function updatePaymentFromProvider(order) {
  if (!["awaiting_confirmation", "cancelled"].includes(order.paymentStatus) || !order.paymentProvider) return false;
  const verification = await paymentProviders.verifyPayment(order);
  const store = readStore();
  const currentOrder = store.orders.find(item => item.orderNumber === order.orderNumber);
  if (!currentOrder || currentOrder.paymentProvider !== order.paymentProvider ||
      currentOrder.paymentReference !== order.paymentReference ||
      !["awaiting_confirmation", "cancelled"].includes(currentOrder.paymentStatus)) return false;
  if (verification.paid) {
    currentOrder.paymentStatus = "paid";
    currentOrder.providerVerifiedAt = new Date().toISOString();
    if (currentOrder.status === "cancelled") currentOrder.refundRequired = true;
  } else if (verification.failed && currentOrder.paymentStatus === "awaiting_confirmation") {
    currentOrder.paymentStatus = "failed";
    currentOrder.providerVerifiedAt = new Date().toISOString();
  } else {
    return false;
  }
  writeStore(store);
  Object.assign(order, currentOrder);
  return true;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/payment-options") {
    sendJson(res, 200, { providers: paymentProviders.listConfiguredProviders() });
    return;
  }
  if (req.method === "GET" && pathname === "/api/products") {
    sendJson(res, 200, readStore().products);
    return;
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    const body = await readBody(req);
    const customer = validateCustomer(body.customer);
    const paymentMethod = String(body.paymentMethod || "");
    if (!["mobile_money", "card", "cod", "bank_transfer"].includes(paymentMethod)) {
      throw Object.assign(new Error("Le mode de paiement choisi n’est pas disponible."), { status: 400 });
    }
    const paymentProvider = isOnlinePaymentMethod(paymentMethod) ? String(body.paymentProvider || "") : null;
    if (isOnlinePaymentMethod(paymentMethod) &&
        !paymentProviders.listConfiguredProviders().some(provider => provider.id === paymentProvider && provider.methods.includes(paymentMethod))) {
      throw Object.assign(new Error("Choisissez une passerelle configurée qui accepte ce mode de paiement. Les cartes et paiements Mobile Money ne peuvent pas être confirmés manuellement."), { status: 400 });
    }
    if (body.business && (typeof body.companyName !== "string" || !body.companyName.trim() || body.companyName.length > 160)) {
      throw Object.assign(new Error("Le nom de l’entreprise est obligatoire pour un devis professionnel."), { status: 400 });
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
      throw Object.assign(new Error("Le panier est vide ou invalide."), { status: 400 });
    }

    const store = readStore();
    const quantities = new Map();
    for (const requested of body.items) {
      if (!requested || typeof requested !== "object") {
        throw Object.assign(new Error("Un produit ou une quantité du panier est invalide."), { status: 400 });
      }
      const id = Number(requested.id);
      const quantity = Number(requested.quantity);
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw Object.assign(new Error("Un produit ou une quantité du panier est invalide."), { status: 400 });
      }
      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }
    const orderItems = [];
    for (const [id, quantity] of quantities) {
      const product = store.products.find(item => item.id === id);
      if (!product || quantity > 30) {
        throw Object.assign(new Error("Un produit ou une quantité du panier est invalide."), { status: 400 });
      }
      if (product.priceOnRequest || !Number.isSafeInteger(product.price) || product.price < 1) {
        throw Object.assign(new Error(`Le prix de « ${product.name} » doit être confirmé avant toute commande.`), { status: 409 });
      }
      if (product.stock < quantity) {
        throw Object.assign(new Error(`Stock insuffisant pour « ${product.name} ». Stock disponible : ${product.stock}.`), { status: 409 });
      }
      orderItems.push({ productId: product.id, name: product.name, quantity, unitPrice: product.price });
    }
    const subtotal = orderItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    if (paymentMethod === "cod" && subtotal > 150000) {
      throw Object.assign(new Error("Le paiement à la livraison est limité à 150 000 FCFA. Choisissez Mobile Money, carte ou virement."), { status: 400 });
    }
    const shippingFee = subtotal >= 100000 ? 0 : 3000;
    for (const item of orderItems) {
      store.products.find(product => product.id === item.productId).stock -= item.quantity;
    }
    const order = {
      orderNumber: `TRD-${new Date().getFullYear()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      createdAt: new Date().toISOString(),
      customer: { ...customer, companyName: body.business ? body.companyName.trim() : null, taxId: body.business && typeof body.taxId === "string" ? body.taxId.trim().slice(0, 40) : null },
      items: orderItems,
      subtotal,
      shippingFee,
      total: subtotal + shippingFee,
      paymentMethod,
      paymentProvider,
      paymentReference: paymentProvider === "cinetpay" ? null : null,
      paymentStatus: paymentMethod === "cod" ? "payable_on_delivery" : "awaiting_confirmation",
      status: "pending"
    };
    if (paymentProvider === "cinetpay") order.paymentReference = order.orderNumber;
    store.orders.unshift(order);
    writeStore(store);
    if (paymentProvider) {
      try {
        const checkout = await paymentProviders.createCheckout(paymentProvider, order);
        const currentStore = readStore();
        const currentOrder = currentStore.orders.find(item => item.orderNumber === order.orderNumber);
        if (!currentOrder || currentOrder.status === "cancelled") {
          throw new Error("La commande a été annulée avant la finalisation du paiement.");
        }
        currentOrder.paymentReference = checkout.reference;
        writeStore(currentStore);
        sendJson(res, 201, { orderNumber: order.orderNumber, total: order.total, paymentMethod, paymentProvider, paymentStatus: order.paymentStatus, status: order.status, checkoutUrl: checkout.checkoutUrl });
        return;
      } catch (error) {
        const currentStore = readStore();
        const currentOrder = currentStore.orders.find(item => item.orderNumber === order.orderNumber);
        if (currentOrder && currentOrder.status !== "cancelled") {
          for (const item of currentOrder.items) {
            const product = currentStore.products.find(entry => entry.id === item.productId);
            if (product) product.stock += item.quantity;
          }
          currentOrder.status = "cancelled";
          currentOrder.paymentStatus = "failed";
          currentOrder.paymentFailureReason = error.message.slice(0, 300);
          writeStore(currentStore);
        }
        throw Object.assign(new Error(`Le paiement n’a pas pu être initialisé ; votre stock a été libéré. ${error.message}`), { status: error.status || 502 });
      }
    }
    sendJson(res, 201, { orderNumber: order.orderNumber, total: order.total, paymentMethod, paymentProvider, paymentStatus: order.paymentStatus, status: order.status });
    return;
  }

  const paymentNotifyMatch = pathname.match(/^\/api\/payments\/notify\/(paydunya|cinetpay|fedapay)$/);
  if (req.method === "POST" && paymentNotifyMatch) {
    const provider = paymentNotifyMatch[1];
    if (!paymentProviders.isProviderConfigured(provider)) {
      sendJson(res, 503, { error: "Ce prestataire de paiement n’est pas configuré." });
      return;
    }
    if (provider === "fedapay" && !process.env.FEDAPAY_WEBHOOK_SECRET) {
      sendJson(res, 503, { error: "Configurez le secret du webhook FedaPay dans .env avant d’activer ses notifications." });
      return;
    }
    const { payload, rawBody } = await readWebhookBody(req);
    if (provider === "paydunya" && !paymentProviders.comparePayDunyaHash(payload.hash)) {
      sendJson(res, 401, { error: "Signature PayDunya invalide." });
      return;
    }
    if (provider === "fedapay" &&
        !paymentProviders.compareFedaPaySignature(req.headers["x-fedapay-signature"], rawBody)) {
      sendJson(res, 401, { error: "Signature FedaPay invalide." });
      return;
    }
    const reference = await paymentProviders.resolveWebhookReference(provider, payload);
    if (!reference) {
      sendJson(res, 200, { received: true, ignored: true });
      return;
    }
    const store = readStore();
    const order = store.orders.find(item => paymentProviders.referenceMatches(provider, item, reference));
    if (!order) {
      sendJson(res, 404, { error: "Commande associée à cette notification introuvable." });
      return;
    }
    if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
      sendJson(res, 200, { received: true });
      return;
    }
    await updatePaymentFromProvider(order);
    sendJson(res, 200, { received: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/orders/track") {
    const address = req.socket.remoteAddress || "unknown";
    const attempts = trackingAttempts.get(address) || { count: 0, since: Date.now() };
    if (Date.now() - attempts.since > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.since = Date.now();
    }
    if (attempts.count >= 30) {
      trackingAttempts.set(address, attempts);
      sendJson(res, 429, { error: "Trop de recherches. Réessayez dans 15 minutes." });
      return;
    }
    attempts.count += 1;
    trackingAttempts.set(address, attempts);
    const body = await readBody(req);
    const orderNumber = String(body.orderNumber || "").trim().toUpperCase();
    const phone = normalizeSenegalPhone(body.phone);
    const store = readStore();
    const order = store.orders.find(item => item.orderNumber === orderNumber && normalizeSenegalPhone(item.customer.phone) === phone);
    if (!order) {
      sendJson(res, 404, { error: "Commande introuvable. Vérifiez le numéro de commande et le téléphone utilisés lors de l’achat." });
      return;
    }
    let verificationMessage = null;
    if (["awaiting_confirmation", "cancelled"].includes(order.paymentStatus) && order.paymentProvider) {
      try {
        await updatePaymentFromProvider(order);
      } catch (error) {
        console.error("Payment verification failed", { provider: order.paymentProvider, orderNumber: order.orderNumber, message: error.message });
        verificationMessage = "Le paiement est en cours de vérification. Réessayez dans quelques instants.";
      }
    }
    sendJson(res, 200, { orderNumber: order.orderNumber, status: order.status, paymentMethod: order.paymentMethod, paymentProvider: order.paymentProvider, paymentStatus: order.paymentStatus, verificationMessage, createdAt: order.createdAt, total: order.total, items: order.items.map(({ name, quantity }) => ({ name, quantity })) });
    return;
  }

  if (!pathname.startsWith("/api/admin/")) {
    sendJson(res, 404, { error: "Route API introuvable." });
    return;
  }
  if (pathname === "/api/admin/login" && req.method === "POST") {
    if (!ADMIN_PASSWORD) {
      sendJson(res, 503, { error: "Définissez TRD_ADMIN_PASSWORD avant de démarrer le serveur." });
      return;
    }
    const configuredPassword = Buffer.from(ADMIN_PASSWORD);
    if (configuredPassword.length > 256) {
      sendJson(res, 503, { error: "Le mot de passe administrateur dépasse la longueur maximale autorisée." });
      return;
    }
    const address = req.socket.remoteAddress || "unknown";
    const attempts = loginAttempts.get(address) || { count: 0, since: Date.now() };
    if (Date.now() - attempts.since > 15 * 60 * 1000) {
      attempts.count = 0;
      attempts.since = Date.now();
    }
    if (attempts.count >= 10) {
      sendJson(res, 429, { error: "Trop de tentatives. Réessayez dans 15 minutes." });
      return;
    }
    const body = await readBody(req);
    const submittedPassword = typeof body.password === "string" ? Buffer.from(body.password) : Buffer.alloc(0);
    const passwordMatches = submittedPassword.length <= 256 && submittedPassword.length === configuredPassword.length &&
      crypto.timingSafeEqual(submittedPassword, configuredPassword);
    if (!passwordMatches) {
      attempts.count += 1;
      loginAttempts.set(address, attempts);
      sendJson(res, 401, { error: "Mot de passe incorrect." });
      return;
    }
    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJson(res, 200, { authenticated: true, csrfToken }, { "Set-Cookie": `trd_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    return;
  }

  if (pathname === "/api/admin/logout" && req.method === "POST") {
    const session = getSession(req);
    if (session) {
      assertCsrf(req, session);
      const token = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("trd_admin="))?.slice("trd_admin=".length);
      if (token) sessions.delete(token);
    }
    sendJson(res, 200, { authenticated: false }, { "Set-Cookie": "trd_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    return;
  }
  if (pathname === "/api/admin/session" && req.method === "GET") {
    const session = getSession(req);
    sendJson(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false });
    return;
  }

  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Connexion administrateur requise." });
    return;
  }
  if (req.method !== "GET") assertCsrf(req, session);

  if (pathname === "/api/admin/orders" && req.method === "GET") {
    sendJson(res, 200, readStore().orders);
    return;
  }
  if (pathname === "/api/admin/products" && req.method === "POST") {
    const store = readStore();
    const product = { id: Math.max(0, ...store.products.map(item => item.id)) + 1, ...validateProduct(await readBody(req)) };
    store.products.push(product);
    writeStore(store);
    sendJson(res, 201, product);
    return;
  }
  const productMatch = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if (productMatch && req.method === "PUT") {
    const store = readStore();
    const index = store.products.findIndex(item => item.id === Number(productMatch[1]));
    if (index < 0) {
      sendJson(res, 404, { error: "Produit introuvable." });
      return;
    }
    store.products[index] = { ...store.products[index], ...validateProduct(await readBody(req)), id: store.products[index].id };
    writeStore(store);
    sendJson(res, 200, store.products[index]);
    return;
  }
  if (productMatch && req.method === "DELETE") {
    const store = readStore();
    const id = Number(productMatch[1]);
    if (!store.products.some(item => item.id === id)) {
      sendJson(res, 404, { error: "Produit introuvable." });
      return;
    }
    if (store.orders.some(order => order.items.some(item => item.productId === id))) {
      sendJson(res, 409, { error: "Ce produit apparaît dans une commande et ne peut pas être supprimé. Mettez son stock à zéro." });
      return;
    }
    store.products = store.products.filter(item => item.id !== id);
    writeStore(store);
    sendJson(res, 200, { deleted: true });
    return;
  }
  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (orderMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!allowedStatuses.has(body.status)) {
      throw Object.assign(new Error("Statut de commande invalide."), { status: 400 });
    }
    const store = readStore();
    const order = store.orders.find(item => item.orderNumber === decodeURIComponent(orderMatch[1]));
    if (!order) {
      sendJson(res, 404, { error: "Commande introuvable." });
      return;
    }
    if (order.status === "cancelled" && body.status !== "cancelled") {
      sendJson(res, 409, { error: "Une commande annulée ne peut pas être réactivée." });
      return;
    }
    if (!orderTransitions[order.status]?.has(body.status)) {
      sendJson(res, 409, { error: "Cette transition de commande n’est pas autorisée. Suivez les étapes de préparation, d’expédition et de livraison." });
      return;
    }
    if (order.paymentStatus === "paid" && body.status === "cancelled") {
      sendJson(res, 409, { error: "Cette commande est déjà marquée payée. Remboursez le client avant de pouvoir l’annuler." });
      return;
    }
    if (order.status === "delivered" && body.status === "cancelled") {
      sendJson(res, 409, { error: "Une commande livrée ne peut pas être annulée ici. Utilisez la procédure de retour ou de SAV." });
      return;
    }
    if (body.status === "cancelled" && order.status !== "cancelled") {
      for (const item of order.items) {
        const product = store.products.find(entry => entry.id === item.productId);
        if (product) product.stock += item.quantity;
      }
      if (order.paymentStatus !== "paid") order.paymentStatus = "cancelled";
    }
    order.status = body.status;
    writeStore(store);
    sendJson(res, 200, order);
    return;
  }
  const paymentMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/payment$/);
  if (paymentMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!allowedPaymentStatuses.has(body.paymentStatus)) {
      throw Object.assign(new Error("Statut de paiement invalide."), { status: 400 });
    }
    const store = readStore();
    const order = store.orders.find(item => item.orderNumber === decodeURIComponent(paymentMatch[1]));
    if (!order) {
      sendJson(res, 404, { error: "Commande introuvable." });
      return;
    }
    if (order.status === "cancelled" && body.paymentStatus !== order.paymentStatus &&
        !(order.paymentStatus === "paid" && body.paymentStatus === "refunded")) {
      sendJson(res, 409, { error: "Le paiement d’une commande annulée ne peut pas être modifié." });
      return;
    }
    if (body.paymentStatus === "payable_on_delivery" && order.paymentMethod !== "cod") {
      sendJson(res, 409, { error: "Seule une commande en paiement à la livraison peut utiliser ce statut." });
      return;
    }
    if (body.paymentStatus === "awaiting_confirmation" && order.paymentMethod === "cod") {
      sendJson(res, 409, { error: "Une commande à régler à la livraison ne peut pas être mise en attente d’un paiement en ligne." });
      return;
    }
    if (body.paymentStatus === "paid" && order.paymentMethod === "cod" && order.status !== "delivered") {
      sendJson(res, 409, { error: "Confirmez d’abord que la commande a été livrée et réglée au livreur." });
      return;
    }
    if (body.paymentStatus === "paid" && order.paymentProvider && order.paymentStatus !== "paid") {
      const verification = await paymentProviders.verifyPayment(order);
      if (!verification.paid) {
        sendJson(res, 409, { error: "Le prestataire n’a pas confirmé le paiement. Le statut reste inchangé." });
        return;
      }
      order.providerVerifiedAt = new Date().toISOString();
    }
    if (body.paymentStatus === "failed" && !["awaiting_confirmation", "failed"].includes(order.paymentStatus)) {
      sendJson(res, 409, { error: "Seul un paiement en attente de confirmation peut être déclaré en échec." });
      return;
    }
    if (body.paymentStatus === "cancelled" && order.status !== "cancelled") {
      sendJson(res, 409, { error: "Annulez d’abord la commande avant d’annuler son paiement." });
      return;
    }
    if (body.paymentStatus === "refunded" && order.paymentStatus !== "paid") {
      sendJson(res, 409, { error: "Seul un paiement confirmé peut être marqué comme remboursé." });
      return;
    }
    if (order.paymentStatus === "refunded" && body.paymentStatus !== "refunded") {
      sendJson(res, 409, { error: "Un paiement remboursé ne peut pas être réactivé." });
      return;
    }
    if (order.paymentStatus === "paid" && !["paid", "refunded"].includes(body.paymentStatus)) {
      sendJson(res, 409, { error: "Un paiement confirmé ne peut pas être remis en attente ou déclaré en échec." });
      return;
    }
    order.paymentStatus = body.paymentStatus;
    if (body.paymentStatus === "refunded") {
      order.refundRequired = false;
      order.refundedAt = new Date().toISOString();
    }
    writeStore(store);
    sendJson(res, 200, order);
    return;
  }
  sendJson(res, 404, { error: "Route d’administration introuvable." });
}

initializeStore();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Page introuvable");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? "Une erreur interne est survenue. Consultez le journal du serveur." : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`${process.env.TRD_STORE_NAME || "Thiès Distribution"} disponible sur http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.warn("Espace admin désactivé : définissez TRD_ADMIN_PASSWORD avant le démarrage.");
});
