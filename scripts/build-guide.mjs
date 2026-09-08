import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--output"), "Usage: node scripts/build-guide.mjs [--output <file.html>]");
const data = JSON.parse(readFileSync(path.join(site, "project-data.json"), "utf8"));
assert.equal(data.schemaVersion, 1, "Unsupported project data schema");
for (const key of ["roadmap", "nodes", "quality", "protocols", "commits", "competitors"]) {
  assert.ok(Array.isArray(data[key]), `Missing data array: ${key}`);
}

// Raster illustrations are optional while the dossier is being assembled.
// An included illustration is embedded; opening the result never needs a server.
for (const illustration of data.illustrations ?? []) {
  const asset = path.resolve(site, illustration.file);
  const relative = path.relative(path.join(site, "assets"), asset);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Illustration must be inside site/assets");
  const bytes = readFileSync(asset);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Illustration must be a PNG");
  illustration.dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  delete illustration.file;
}

const serialized = JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const template = readFileSync(path.join(site, "guide.template.html"), "utf8");
assert.equal(template.split("__PROJECT_DATA__").length, 2, "Expected exactly one project data marker");
const html = template.replace("__PROJECT_DATA__", () => serialized);
const destinations = new Set([path.join(site, "index.html")]);
if (args.length) destinations.add(path.resolve(args[1]));
for (const destination of destinations) {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, html, "utf8");
  console.log(`Guide built: ${destination} (${Buffer.byteLength(html)} bytes, ${data.illustrations?.length ?? 0} embedded illustration(s))`);
}
