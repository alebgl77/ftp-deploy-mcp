import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--output"), "Usage: node scripts/build-guide.mjs [--output <file.html>]");
const data = JSON.parse(readFileSync(path.join(site, "project-data.json"), "utf8"));
assert.equal(data.schemaVersion, 2, "Unsupported project data schema");
assert.equal(data.defaultLocale, "fr", "French must remain the default locale");
assert.deepEqual(Object.keys(data.locales).sort(), ["en", "fr"], "Both locales are required");
data.ui = JSON.parse(readFileSync(path.join(site, "i18n.json"), "utf8"));
assert.deepEqual(Object.keys(data.ui).sort(), ["en", "fr"], "Both UI locales are required");

// Locales share a shape, stable identifiers and numeric facts. Translated prose
// stays editable, but missing fields or fact drift fail the build.
const immutable = new Set(["schemaVersion", "project", "version", "repository", "head", "toolCount", "value", "id", "x", "y", "w", "h", "current", "source", "extraSources", "roadmap", "dependencies", "priority", "level", "sha", "commit", "url", "path"]);
function checkParity(left, right, location = "", field = "") {
  assert.equal(typeof right, typeof left, `Locale type mismatch: ${location}`);
  if (Array.isArray(left)) {
    assert.ok(Array.isArray(right), `Locale array missing: ${location}`);
    assert.equal(left.length, right.length, `Locale array length mismatch: ${location}`);
    left.forEach((value, index) => checkParity(value, right[index], `${location}[${index}]`, field));
  } else if (left !== null && typeof left === "object") {
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `Locale keys mismatch: ${location}`);
    for (const key of Object.keys(left)) checkParity(left[key], right[key], `${location}.${key}`, key);
  } else if (typeof left === "string") {
    assert.ok(left.trim() && right.trim(), `Empty translation: ${location}`);
    if ((location.startsWith("content.") && immutable.has(field)) || (field === "status" && location.startsWith("content.roadmap"))) assert.equal(right, left, `Immutable locale fact mismatch: ${location}`);
    if (!["prompt", "file"].includes(field)) assert.deepEqual((left.match(/\d+(?:[./-]\d+)*/g) ?? []).sort(), (right.match(/\d+(?:[./-]\d+)*/g) ?? []).sort(), `Numeric fact mismatch: ${location}`);
    assert.deepEqual((left.match(/\{\w+\}/g) ?? []).sort(), (right.match(/\{\w+\}/g) ?? []).sort(), `Translation placeholders mismatch: ${location}`);
  } else assert.equal(right, left, `Locale value mismatch: ${location}`);
}
checkParity(data.locales.fr, data.locales.en, "content");
checkParity(data.ui.fr, data.ui.en, "ui");
const template = readFileSync(path.join(site, "guide.template.html"), "utf8");
const staticBody = template.split("<body>")[1].split('<script id="project-data"')[0];
const staticLabels = [...staticBody.matchAll(/>([^<>]+)(?=<)/g)].map((match) => match[1].trim());
staticLabels.push(...[...staticBody.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]+)"/g)].map((match) => match[1]));
const invariantLabels = new Set(["f/", "ftp-deploy-mcp", "Français", "English", "P0", "P1"]);
for (const label of staticLabels) if (/[a-zÀ-ÿ]/i.test(label) && !invariantLabels.has(label)) assert.ok(Object.hasOwn(data.ui.fr.static, label), `Untranslated template label: ${label}`);

for (const [locale, content] of Object.entries(data.locales)) {
  assert.equal(new URL(content.repository).protocol, "https:", "Repository link must use HTTPS");
  for (const key of ["roadmap", "nodes", "scenarios", "quality", "protocols", "commits", "competitors", "documents", "illustrations"]) assert.ok(Array.isArray(content[key]), `Missing ${locale} data array: ${key}`);

// Raster illustrations are optional while the dossier is being assembled.
// An included illustration is embedded; opening the result never needs a server.
for (const illustration of content.illustrations) {
  const asset = path.resolve(site, illustration.file);
  const relative = path.relative(path.join(site, "assets"), asset);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Illustration must be inside site/assets");
  const bytes = readFileSync(asset);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Illustration must be a PNG");
  illustration.dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  delete illustration.file;
}
}

const serialized = JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
assert.equal(template.split("__PROJECT_DATA__").length, 2, "Expected exactly one project data marker");
const html = template.replace("__PROJECT_DATA__", () => serialized);
const destinations = new Set([path.join(site, "index.html")]);
if (args.length) destinations.add(path.resolve(args[1]));
for (const destination of destinations) {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, html, "utf8");
  console.log(`Guide built: ${destination} (${Buffer.byteLength(html)} bytes, FR/EN parity verified, ${Object.values(data.locales).reduce((count, content) => count + content.illustrations.length, 0)} embedded illustration(s))`);
}
