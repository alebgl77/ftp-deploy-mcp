import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { isMain, readRelease } from "./release-gate.mjs";

// Deliberately exact: adding a shipped file requires an explicit release review.
export const PACKAGE_FILES = [
  "package.json", "README.md", "README.fr.md", "LICENSE", "CHANGELOG.md", "SECURITY.md",
  "ftp-servers.example.json", "install.cmd", "install.sh", "server.json",
  "docs/RELEASE.md", "docs/SECURITY-MODEL.md",
  "src/index.js", "src/config.js", "src/clients.js", "src/atomic-write.js",
  "src/tools.js", "src/setup.js", "src/remote-path.js", "src/redact.js",
  "src/local-path.js", "src/filezilla.js", "src/adapters/ftp.js", "src/adapters/sftp.js",
  "evaluations/README.md", "evaluations/read-only.xml", "evaluations/fixture/README.txt",
  "evaluations/fixture/catalog/alpha.txt", "evaluations/fixture/catalog/bravo.txt",
  "evaluations/fixture/catalog/charlie.txt", "evaluations/fixture/catalog/delta.txt",
  "evaluations/fixture/catalog/echo.txt", "evaluations/fixture/catalog/foxtrot.txt",
  "evaluations/fixture/reports/checks.txt", "evaluations/fixture/reports/release.txt",
];

export function validateFiles(files) {
  assert.ok(Array.isArray(files), "Package file list is required");
  assert.equal(new Set(files).size, files.length, "Duplicate package path");
  assert.deepEqual([...files].sort(), [...PACKAGE_FILES].sort(), "Package contents differ from the reviewed allowlist");
}

export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function validatePack(pack, release) {
  assert.ok(Array.isArray(pack) && pack.length === 1, "Exactly one packed artifact is required");
  const item = pack[0];
  assert.equal(item.name, release.name, "Packed name mismatch");
  assert.equal(item.version, release.version, "Packed version mismatch");
  assert.equal(item.filename, `${release.name}-${release.version}.tgz`, "Unexpected artifact filename");
  validateFiles(item.files?.map((file) => file.path));
  return item;
}

export function checkArtifact(record, release) {
  for (const key of ["name", "version", "mcpName"]) assert.equal(record[key], release[key], `Artifact ${key} mismatch`);
  assert.equal(path.basename(record.tarball), `${release.name}-${release.version}.tgz`, "Unexpected artifact filename");
  assert.equal(integrity(readFileSync(record.tarball)), record.integrity, "Artifact changed after validation");
  return record;
}

export function validatePublished(metadata, release, expectedIntegrity) {
  for (const key of ["name", "version", "mcpName"]) assert.equal(metadata[key], release[key], `Published ${key} mismatch`);
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "Published SHA512 integrity is required");
  if (expectedIntegrity !== undefined) assert.equal(metadata.dist.integrity, expectedIntegrity, "Published tarball integrity mismatch");
  return metadata;
}

export async function verifyPublished(release, expectedIntegrity, { fetchImpl = fetch, sleep = setTimeout, attempts = 6 } = {}) {
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 6, "Invalid retry bound");
  const url = `https://registry.npmjs.org/${encodeURIComponent(release.name)}/${encodeURIComponent(release.version)}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (response.status === 404 && attempt < attempts) {
      await response.body?.cancel();
      await sleep(5000);
      continue;
    }
    assert.equal(response.status, 200, `npm verification failed: HTTP ${response.status}`);
    return validatePublished(await response.json(), release, expectedIntegrity);
  }
}

if (isMain(import.meta.url)) {
  const [mode, file] = process.argv.slice(2);
  assert.ok(["inspect", "check", "verify-npm"].includes(mode) && process.argv.length <= 4, "Usage: release-artifact.mjs inspect|check|verify-npm [record/pack JSON]");
  const { release } = readRelease();
  if (mode === "inspect") {
    const item = validatePack(JSON.parse(readFileSync(file, "utf8")), release);
    const tarball = path.resolve(path.dirname(file), item.filename);
    assert.ok(!/[\r\n]/.test(tarball), "Invalid artifact path");
    const digest = integrity(readFileSync(tarball));
    assert.equal(digest, item.integrity, "Packed integrity mismatch");
    const tar = (args) => execFileSync("tar", args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    const entries = tar(["-tzf", tarball]).trim().split(/\r?\n/);
    assert.ok(entries.every((entry) => entry.startsWith("package/")), "Unexpected archive prefix");
    validateFiles(entries.map((entry) => entry.slice("package/".length)));
    assert.ok(tar(["-tvzf", tarball]).trim().split(/\r?\n/).every((entry) => entry.startsWith("-")), "Archive may contain only regular files");
    const packed = JSON.parse(tar(["-xOzf", tarball, "package/package.json"]));
    for (const key of ["name", "version", "mcpName"]) assert.equal(packed[key], release[key], `Archive ${key} mismatch`);
    const record = { ...release, tarball, integrity: digest };
    writeFileSync(`${file}.verified.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
    console.log(`Validated ${item.files.length} files: ${item.filename}\n${digest}`);
  } else {
    const record = file ? checkArtifact(JSON.parse(readFileSync(file, "utf8")), release) : undefined;
    if (mode === "check") assert.ok(record, "Artifact record is required");
    if (mode === "verify-npm") {
      const published = await verifyPublished(release, record?.integrity);
      console.log(`Verified npm ${release.name}@${release.version}\n${published.dist.integrity}`);
    } else console.log("Artifact bytes unchanged");
  }
}
