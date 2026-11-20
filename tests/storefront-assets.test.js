const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("storefront images are local and typography uses installed system fonts", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8"));
  const references = [
    ...products.map(product => product.image),
    ...[...html.matchAll(/\bsrc=["'](\/[^"']+)["']/g)].map(match => match[1]),
    ...[...html.matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)].map(match => match[1])
  ];

  assert.doesNotMatch(html, /https?:\/\/(?:images\.unsplash\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/);
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.ok(reference.startsWith("/assets/") || reference === "/product-placeholder.svg", `${reference} must be served locally`);
    assert.ok(fs.existsSync(path.join(root, reference.slice(1))), `${reference} must exist in the project`);
  }
});

test("storefront branding and hero match the supplied Thiès Distribution reference", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(html, /THIÈS DISTRIBUTION/);
  assert.match(html, /MBI/);
  assert.match(html, /Service client : \+221 77 123 45 67/);
  assert.match(html, /Nos Marques/);
  assert.match(html, /href="tel:\+221771234567"/);
  assert.match(html, /\/assets\/hero-thies-distribution\.jpg/);
});

test("the charger uses the supplied offline product photo", () => {
  const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8"));
  const charger = products.find(product => product.id === 7);

  assert.ok(charger, "charger product must exist");
  assert.equal(charger.image, "/assets/product-charger.jpg");
  assert.ok(fs.existsSync(path.join(root, charger.image.slice(1))), "charger photo must be bundled locally");
});

test("printer category has clearly marked non-purchasable demonstration products", () => {
  const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8"));
  const printers = products.filter(product => product.category === "Imprimantes");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const storefront = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin.html"), "utf8");

  assert.equal(printers.length, 3);
  for (const printer of printers) {
    assert.equal(printer.price, null);
    assert.equal(printer.priceOnRequest, true);
    assert.equal(printer.stock, 0);
    assert.equal(printer.tag, "Prix à confirmer");
    assert.equal(printer.image, "/assets/category-printer.jpg");
    assert.match(printer.description, /confirm/i);
  }
  assert.match(storefront, /p\.priceOnRequest\?"Prix à confirmer"/);
  assert.match(storefront, /p\.priceOnRequest\|\|p\.stock<1/);
  assert.match(server, /if \(product\.priceOnRequest \|\| !Number\.isSafeInteger\(product\.price\)/);
  assert.match(server, /priceOnRequest, description:/);
  assert.match(admin, /name="priceOnRequest"/);
  assert.match(admin, /name="description"/);
});

test("clicking a product opens its own details without changing the product or comparison modal", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const detailHandler = html.match(/function showProduct\(id\) \{([\s\S]*?)\n    \}/)?.[1];

  assert.ok(detailHandler, "product details handler must exist");
  assert.match(html, /id="productDetailModal"/);
  assert.match(html, /id="productDetailContent"/);
  assert.match(html, /onclick="showProduct\(\$\{p\.id\}\)"/);
  assert.match(html, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/);
  assert.match(detailHandler, /productDetailContent/);
  assert.match(detailHandler, /productDetailModal/);
  assert.match(detailHandler, /p\.category/);
  assert.match(detailHandler, /p\.warranty/);
  assert.doesNotMatch(detailHandler, /compareContent|compareModal/);
  assert.doesNotMatch(detailHandler, /addToCart\(p\.id\);document/);
});
