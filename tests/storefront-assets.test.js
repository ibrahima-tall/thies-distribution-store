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
