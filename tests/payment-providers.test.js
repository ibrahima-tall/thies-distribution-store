const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const providers = require("../payment-providers");

const originalFetch = global.fetch;
const envKeys = [
  "TRD_PUBLIC_URL", "TRD_STORE_NAME",
  "PAYDUNYA_MODE", "PAYDUNYA_MASTER_KEY", "PAYDUNYA_PRIVATE_KEY", "PAYDUNYA_TOKEN",
  "CINETPAY_API_KEY", "CINETPAY_SITE_ID",
  "FEDAPAY_MODE", "FEDAPAY_SECRET_KEY", "FEDAPAY_WEBHOOK_SECRET"
];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

function configureAllProviders() {
  process.env.TRD_PUBLIC_URL = "https://shop.example.sn";
  process.env.TRD_STORE_NAME = "TRD Tech";
  process.env.PAYDUNYA_MODE = "test";
  process.env.PAYDUNYA_MASTER_KEY = "master-test";
  process.env.PAYDUNYA_PRIVATE_KEY = "private-test";
  process.env.PAYDUNYA_TOKEN = "token-test";
  process.env.CINETPAY_API_KEY = "cinetpay-test";
  process.env.CINETPAY_SITE_ID = "123456";
  process.env.FEDAPAY_MODE = "sandbox";
  process.env.FEDAPAY_SECRET_KEY = "fedapay-test";
  process.env.FEDAPAY_WEBHOOK_SECRET = "wh_test_endpoint";
}

function mockResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test.afterEach(() => {
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("only exposes fully configured HTTPS providers and their supported methods", () => {
  configureAllProviders();
  const configured = providers.listConfiguredProviders();
  assert.deepEqual(configured.map(provider => provider.id), ["paydunya", "cinetpay", "fedapay"]);
  assert.deepEqual(configured.find(provider => provider.id === "fedapay").methods.sort(), ["card", "mobile_money"]);
  delete process.env.CINETPAY_API_KEY;
  assert.ok(!providers.listConfiguredProviders().some(provider => provider.id === "cinetpay"));
  process.env.TRD_PUBLIC_URL = "http://localhost:3000";
  assert.deepEqual(providers.listConfiguredProviders(), []);
});

test("creates a PayDunya hosted invoice without exposing credentials to the checkout response", async () => {
  configureAllProviders();
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return mockResponse({ response_code: "00", response_text: "https://app.paydunya.com/checkout/invoice/token", token: "invoice-1" });
  };
  const result = await providers.createCheckout("paydunya", {
    orderNumber: "TRD-2026-ORDER001",
    total: 32000,
    shippingFee: 3000,
    paymentMethod: "mobile_money",
    customer: { name: "Client Test", phone: "+221770000000", email: "client@example.sn" },
    items: [{ name: "Chargeur", quantity: 1, unitPrice: 29000 }]
  });
  assert.equal(result.reference, "invoice-1");
  assert.equal(new URL(result.checkoutUrl).protocol, "https:");
  assert.match(request.url, /sandbox-api\/v1\/checkout-invoice\/create$/);
  assert.equal(request.options.headers["PAYDUNYA-PRIVATE-KEY"], "private-test");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.invoice.total_amount, 32000);
  assert.equal(payload.custom_data.order_number, "TRD-2026-ORDER001");
  assert.equal(new URL(payload.actions.callback_url).protocol, "https:");
});

test("creates CinetPay checkout with XOF, method channel and server notification URL", async () => {
  configureAllProviders();
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return mockResponse({ code: "201", data: { payment_url: "https://checkout.cinetpay.com/session" } });
  };
  const result = await providers.createCheckout("cinetpay", {
    orderNumber: "TRD-2026-ORDER002",
    total: 32000,
    shippingFee: 3000,
    paymentMethod: "mobile_money",
    customer: { name: "Client Test", phone: "+221770000000", email: null, address: "Dakar" },
    items: [{ name: "Chargeur", quantity: 1, unitPrice: 29000 }]
  });
  assert.equal(result.reference, "TRD-2026-ORDER002");
  assert.match(request.url, /api-checkout\.cinetpay\.com\/v2\/payment$/);
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.currency, "XOF");
  assert.equal(payload.channels, "MOBILE_MONEY");
  assert.equal(payload.customer_name, "Client");
  assert.equal(payload.customer_surname, "Test");
  assert.equal(payload.customer_phone_number, "221770000000");
  assert.equal(payload.notify_url, "https://shop.example.sn/api/payments/notify/cinetpay");

  global.fetch = async (url, options) => {
    request = { url, options };
    return mockResponse({ code: "201", data: { payment_url: "https://checkout.cinetpay.com/card-session" } });
  };
  await providers.createCheckout("cinetpay", {
    orderNumber: "TRD-2026-ORDER008",
    total: 32000,
    paymentMethod: "card",
    customer: { name: "Client Test", phone: "770000000", email: null, address: "Dakar" },
    items: []
  });
  assert.equal(JSON.parse(request.options.body).channels, "CREDIT_CARD");
});

test("creates a FedaPay transaction and then obtains its hosted checkout token", async () => {
  configureAllProviders();
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/transactions")) {
      return mockResponse({ "v1/transactions": { id: 42 } }, 201);
    }
    return mockResponse({ "v1/transactions": { url: "https://checkout.fedapay.com/session" } });
  };
  const result = await providers.createCheckout("fedapay", {
    orderNumber: "TRD-2026-ORDER003",
    total: 32000,
    paymentMethod: "mobile_money",
    customer: { name: "Client Test", phone: "+221770000000", email: null },
    items: []
  });
  assert.equal(result.reference, "42");
  const transaction = JSON.parse(requests[0].options.body);
  assert.equal(transaction.mode, "free_sn");
  assert.equal(transaction.currency.iso, "XOF");
  assert.equal(transaction.custom_metadata.order_number, "TRD-2026-ORDER003");
  assert.equal(transaction.customer.phone_number.number, 770000000);
  assert.match(requests[1].url, /\/transactions\/42\/token$/);
  requests.length = 0;
  await providers.createCheckout("fedapay", {
    orderNumber: "TRD-2026-ORDER011",
    total: 32000,
    paymentMethod: "card",
    customer: { name: "Client Test", phone: "770000000", email: null },
    items: []
  });
  assert.equal(JSON.parse(requests[0].options.body).mode, "card");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fedapay-test");
});

test("rejects methods a provider does not support and rejects non-HTTPS checkout links", async () => {
  configureAllProviders();
  await assert.rejects(() => providers.createCheckout("fedapay", {
    paymentMethod: "unsupported", orderNumber: "TRD-2026-ORDER004", total: 1, items: [], customer: { name: "Test" }
  }), /ne prend pas en charge/);
  global.fetch = async () => mockResponse({ response_code: "00", response_text: "http://unsafe.example/pay", token: "invoice-2" });
  await assert.rejects(() => providers.createCheckout("paydunya", {
    orderNumber: "TRD-2026-ORDER005", total: 1, paymentMethod: "mobile_money",
    customer: { name: "Test", phone: "770000000" }, items: []
  }), /invalide ou non sécurisé/);
  global.fetch = async () => mockResponse({ response_code: "00", response_text: "https://unsafe.example/pay", token: "invoice-3" });
  await assert.rejects(() => providers.createCheckout("paydunya", {
    orderNumber: "TRD-2026-ORDER005", total: 1, paymentMethod: "mobile_money",
    customer: { name: "Test", phone: "770000000" }, items: []
  }), /invalide ou non sécurisé/);
});

test("verifies payment against the provider and matches the order amount and reference", async () => {
  configureAllProviders();
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/checkout-invoice\/confirm\/invoice-6$/);
    assert.equal(options.headers["PAYDUNYA-PRIVATE-KEY"], "private-test");
    return mockResponse({ invoice: { status: "completed", total_amount: "32000", custom_data: { order_number: "TRD-2026-ORDER006" } } });
  };
  const verified = await providers.verifyPayment({
    paymentProvider: "paydunya", paymentReference: "invoice-6", paymentStatus: "awaiting_confirmation",
    total: 32000, orderNumber: "TRD-2026-ORDER006"
  });
  assert.equal(verified.paid, true);
  assert.equal(providers.referenceMatches("paydunya", { paymentProvider: "paydunya", paymentReference: "invoice-6" }, "invoice-6"), true);

  global.fetch = async () => mockResponse({ invoice: { status: "completed", total_amount: "32001", custom_data: { order_number: "TRD-2026-ORDER006" } } });
  const wrongAmount = await providers.verifyPayment({
    paymentProvider: "paydunya", paymentReference: "invoice-6", paymentStatus: "awaiting_confirmation",
    total: 32000, orderNumber: "TRD-2026-ORDER006"
  });
  assert.equal(wrongAmount.paid, false);
});

test("CinetPay confirms only the exact transaction, amount and XOF currency", async () => {
  configureAllProviders();
  const order = {
    paymentProvider: "cinetpay",
    paymentReference: "TRD-2026-ORDER009",
    orderNumber: "TRD-2026-ORDER009",
    total: 32000
  };
  global.fetch = async () => mockResponse({
    code: "00",
    data: { status: "ACCEPTED", transaction_id: order.orderNumber, amount: 32000, currency: "XOF" }
  });
  assert.equal((await providers.verifyPayment(order)).paid, true);

  global.fetch = async () => mockResponse({
    code: "00",
    data: { status: "ACCEPTED", amount: 32000, currency: "XOF" }
  });
  assert.equal((await providers.verifyPayment(order)).paid, false);

  global.fetch = async () => mockResponse({
    code: "00",
    data: { status: "ACCEPTED", transaction_id: order.orderNumber, amount: 32000, currency: "EUR" }
  });
  assert.equal((await providers.verifyPayment(order)).paid, false);
});

test("FedaPay confirms only the returned transaction ID, order metadata and amount", async () => {
  configureAllProviders();
  const order = {
    paymentProvider: "fedapay",
    paymentReference: "42",
    orderNumber: "TRD-2026-ORDER010",
    total: 32000
  };
  global.fetch = async () => mockResponse({
    "v1/transactions": {
      id: 42, status: "approved", amount: 32000,
      custom_metadata: { order_number: order.orderNumber }
    }
  });
  assert.equal((await providers.verifyPayment(order)).paid, true);

  global.fetch = async () => mockResponse({
    "v1/transactions": {
      id: 43, status: "approved", amount: 32000,
      custom_metadata: { order_number: order.orderNumber }
    }
  });
  assert.equal((await providers.verifyPayment(order)).paid, false);
});

test("validates FedaPay webhook signatures and resolves event IDs to transaction IDs", async () => {
  configureAllProviders();
  const rawBody = JSON.stringify({ id: 76, object: "event" });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", process.env.FEDAPAY_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`).digest("hex");
  const header = `t=${timestamp},s=${signature}`;
  assert.equal(providers.compareFedaPaySignature(header, rawBody), true);
  assert.equal(providers.compareFedaPaySignature(header, `${rawBody} `), false);
  assert.equal(providers.compareFedaPaySignature(`t=${timestamp - 301},s=${signature}`, rawBody), false);

  global.fetch = async url => {
    assert.match(String(url), /\/events\/76$/);
    return mockResponse({ "v1/events": { entity: { id: 42 } } });
  };
  assert.equal(await providers.resolveWebhookReference("fedapay", { id: 76 }), "42");
});

test("checks provider notifications with remote payment verification and validates PayDunya hashes", () => {
  configureAllProviders();
  const digest = crypto.createHash("sha512").update(process.env.PAYDUNYA_MASTER_KEY).digest("hex");
  assert.equal(providers.comparePayDunyaHash(digest), true);
  assert.equal(providers.comparePayDunyaHash("00"), false);
  assert.equal(providers.comparePayDunyaHash(`${digest}zz`), false);
  assert.equal(providers.webhookReference("paydunya", { "data[token]": "invoice-7" }), "invoice-7");
  assert.equal(providers.webhookReference("paydunya", { data: '{"token":"invoice-8"}' }), "invoice-8");
  assert.equal(providers.webhookReference("cinetpay", { cpm_trans_id: "TRD-2026-ORDER007" }), "TRD-2026-ORDER007");
  assert.equal(providers.webhookReference("fedapay", { entity: { id: 7 } }), "7");
  assert.equal(providers.referenceMatches("cinetpay", { orderNumber: "TRD-2026-ORDER007", paymentProvider: "cinetpay" }, "TRD-2026-ORDER007"), true);
});
