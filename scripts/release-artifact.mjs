import { assertReleaseToolchain } from "./release-toolchain.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { checkoutCommit, isMain, readRelease, validateCheckout } from "./release-gate.mjs";

// Deliberately exact: adding a shipped file requires an explicit release review.
export const NPM_PACKAGE_FILES = Object.freeze([
  "package.json", "README.md", "README.fr.md", "LICENSE", "LICENSE.fr.md",
  "CHANGELOG.md", "CHANGELOG.fr.md", "SECURITY.md", "SECURITY.fr.md",
  "CONTRIBUTING.md", "CONTRIBUTING.fr.md",
  "ftp-servers.example.json", "install.cmd", "install.sh", "server.json",
  "docs/RELEASE.md", "docs/RELEASE.fr.md",
  "docs/SECURITY-MODEL.md", "docs/SECURITY-MODEL.fr.md",
  "docs/LANGUAGES.md", "docs/LANGUAGES.fr.md",
  "docs/TRANSFERS.md", "docs/TRANSFERS.fr.md",
  "docs/RESOURCE-BOUNDS.md", "docs/RESOURCE-BOUNDS.fr.md",
  "docs/STATE-STORAGE.md", "docs/STATE-STORAGE.fr.md",
  "docs/WORKFLOW-MODEL.md", "docs/WORKFLOW-MODEL.fr.md",
  "docs/AGENT-PERFORMANCE.md", "docs/AGENT-PERFORMANCE.fr.md",
  "src/index.js", "src/config.js", "src/clients.js", "src/atomic-write.js",
  "src/tools.js", "src/setup.js", "src/remote-path.js", "src/redact.js", "src/operations.js",
  "src/i18n.js", "src/locales/en.js", "src/locales/fr.js",
  "src/transfers.js", "src/errors.js", "src/tool-registry.js",
  "src/scanner.js", "src/admission.js",
  "src/state/index.mjs", "src/state/codec.mjs", "src/state/io.mjs",
  "src/state/records.mjs", "src/state/store.mjs", "src/state/writer.mjs",
  "src/workflow/model.mjs", "src/workflow/events.mjs", "src/workflow/budget.mjs",
  "src/durable/schemas.js", "src/durable/state.js", "src/durable/plan.js", "src/durable/status.js",
  "src/durable/confirmation.js", "src/durable/engine.js", "src/durable-tools.js",
  "src/locales/runtime.en.js", "src/locales/runtime.fr.js", "src/locales/errors.en.js", "src/locales/errors.fr.js",
  "docs/ERROR-CONTRACT.md", "docs/ERROR-CONTRACT.fr.md",
  "docs/SCRIPTED-EVALUATIONS.md", "docs/SCRIPTED-EVALUATIONS.fr.md",
  "src/local-path.js", "src/filezilla.js", "src/adapters/ftp.js", "src/adapters/sftp.js",
  "evaluations/README.md", "evaluations/README.fr.md",
  "evaluations/read-only.xml", "evaluations/read-only.fr.xml", "evaluations/fixture/README.txt",
  "evaluations/fixture/catalog/alpha.txt", "evaluations/fixture/catalog/bravo.txt",
  "evaluations/fixture/catalog/charlie.txt", "evaluations/fixture/catalog/delta.txt",
  "evaluations/fixture/catalog/echo.txt", "evaluations/fixture/catalog/foxtrot.txt",
  "evaluations/fixture/reports/checks.txt", "evaluations/fixture/reports/release.txt",
]);
export const SOURCE_FILES = Object.freeze([...NPM_PACKAGE_FILES, "package-lock.json"]);
export const PACKAGE_FILES = NPM_PACKAGE_FILES;

export function distributionFiles(distribution = "npm") {
  assert.ok(distribution === "npm" || distribution === "source", "Distribution must be npm or source");
  return distribution === "source" ? SOURCE_FILES : NPM_PACKAGE_FILES;
}

export function artifactFilename(release, distribution = "npm") {
  distributionFiles(distribution);
  return `${release.name}-${release.version}${distribution === "source" ? "-source.tar.gz" : ".tgz"}`;
}

export function validateFiles(files, distribution = "npm") {
  assert.ok(Array.isArray(files), "Package file list is required");
  assert.equal(new Set(files).size, files.length, "Duplicate package path");
  assert.deepEqual([...files].sort(), [...distributionFiles(distribution)].sort(), "Package contents differ from the reviewed allowlist");
}

export function integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// `npm pack --json` emits an array through npm 11 and an object keyed by package name from
// npm 12. Accept both so a release never depends on the runner's bundled npm version.
export function packEntries(pack) {
  if (Array.isArray(pack)) return pack;
  if (pack && typeof pack === "object") return Object.values(pack);
  return [];
}

export function validatePack(pack, release, distribution = "npm") {
  const entries = packEntries(pack);
  assert.ok(entries.length === 1, "Exactly one packed artifact is required");
  const item = entries[0];
  assert.equal(item.name, release.name, "Packed name mismatch");
  assert.equal(item.version, release.version, "Packed version mismatch");
  assert.equal(item.filename, artifactFilename(release, distribution), "Unexpected artifact filename");
  if (distribution === "source" || item.distribution !== undefined) assert.equal(item.distribution, distribution, "Packed distribution mismatch");
  validateFiles(item.files?.map((file) => file.path), distribution);
  return item;
}

export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_TAR_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_INSPECTION_MS = 90000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A bounded descriptor read remains bounded if the file grows after stat. Callers keep
// this private buffer for the entire inspection; tar never reopens the archive path.
export function readBoundedFile(file, limit) {
  assertReleaseToolchain();
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_ARCHIVE_BYTES, "Invalid byte bound");
  assert.ok(lstatSync(file).isFile(), "Expected a regular file");
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile(), "Expected a regular file descriptor");
    assert.ok(stat.size <= limit, `File exceeds ${limit} byte limit`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const count = readSync(fd, buffer, size, Math.min(65536, limit + 1 - size), null);
      if (!count) break;
      size += count;
    }
    assert.ok(size <= limit, `File exceeds ${limit} byte limit`);
    assert.equal(size, stat.size, "File size changed during bounded read");
    return Buffer.from(buffer.subarray(0, size));
  } finally { closeSync(fd); }
}

function canonical(file) {
  assert.equal(typeof file, "string", "Explicit absolute path is required");
  assert.ok(path.isAbsolute(file) && !/[\r\n]/.test(file), "Explicit absolute path is required");
  return realpathSync(file);
}

function budget({ now = () => performance.now(), timeoutMs = MAX_INSPECTION_MS } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_INSPECTION_MS, "Invalid inspection time bound");
  const deadline = now() + timeoutMs;
  return () => {
    const remaining = Math.floor(deadline - now());
    assert.ok(remaining > 0, "Total artifact inspection deadline exceeded");
    return Math.min(15000, remaining);
  };
}

function sourceBytes(root, checkpoint) {
  const bytes = new Map();
  for (const file of SOURCE_FILES) {
    checkpoint();
    const absolute = path.join(root, file);
    assert.equal(canonical(absolute), absolute, `Source path must not contain links: ${file}`);
    bytes.set(file, readBoundedFile(absolute, MAX_FILE_BYTES));
  }
  return bytes;
}

function fileInventory(bytes) {
  return [...bytes].map(([file, content]) => ({ path: file, size: content.length, sha256: sha256(content) })).sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function inventoryDestination(file, root) {
  assert.ok(path.isAbsolute(file) && !/[\r\n]/.test(file), "Explicit absolute inventory path is required");
  const absolute = path.join(realpathSync(path.dirname(file)), path.basename(file));
  const relative = path.relative(root, absolute);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Store the source inventory outside the source checkout");
  return absolute;
}

function assertSourceObjects(source, bytes) {
  for (const [field, file] of [["pkg", "package.json"], ["lock", "package-lock.json"], ["server", "server.json"]]) {
    assert.deepEqual(source[field], JSON.parse(bytes.get(file)), `Source objects differ from approved bytes: ${file}`);
  }
}

export function captureSourceInventory(file, options) {
  assertReleaseToolchain();
  const checkpoint = budget(options);
  const sourceRoot = canonical(options.sourceRoot);
  const inventoryPath = inventoryDestination(file, sourceRoot);
  const bytes = sourceBytes(sourceRoot, checkpoint);
  const source = readRelease(sourceRoot, process.env.GITHUB_REF, { sourceOnly: options.sourceOnly === true });
  assertSourceObjects(source, bytes);
  const { release } = source;
  const commit = options.sourceOnly === true ? checkoutCommit(sourceRoot) : validateCheckout(sourceRoot, release, process.env.GITHUB_REF, SOURCE_FILES);
  const snapshot = { schemaVersion: 1, scope: options.sourceOnly === true ? "source-only" : "publication", release, commit, files: fileInventory(bytes) };
  assert.deepEqual(fileInventory(sourceBytes(sourceRoot, checkpoint)), snapshot.files, "Source changed during inventory capture");
  checkpoint();
  const serialized = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(inventoryPath, serialized, { flag: "wx" });
  return { snapshot, inventoryPath, inventorySha256: sha256(serialized) };
}

export function approvedSource(options, checkpoint = budget(options)) {
  assertReleaseToolchain();
  checkpoint();
  const sourceRoot = canonical(options.sourceRoot);
  const inventoryPath = canonical(options.inventoryPath);
  inventoryDestination(inventoryPath, sourceRoot);
  assert.match(options.expectedInventorySha256 ?? "", /^[a-f0-9]{64}$/, "Original inventory SHA256 is required");
  const serialized = readBoundedFile(inventoryPath, MAX_FILE_BYTES);
  assert.equal(sha256(serialized), options.expectedInventorySha256, "Source inventory changed after capture");
  const snapshot = JSON.parse(serialized);
  assert.deepEqual(Object.keys(snapshot).sort(), ["schemaVersion", "scope", "release", "commit", "files"].sort(), "Invalid inventory schema");
  assert.equal(snapshot.schemaVersion, 1, "Unsupported inventory schema");
  assert.equal(snapshot.scope, options.sourceOnly === true ? "source-only" : "publication", "Source inventory scope mismatch");
  assert.match(snapshot.commit, /^[a-f0-9]{40}$/, "Inventory commit is required");
  validateFiles(snapshot.files?.map((entry) => entry.path), "source");
  const bytes = sourceBytes(sourceRoot, checkpoint);
  assert.deepEqual(snapshot.files, fileInventory(bytes), "Source bytes differ from the original inventory");
  const source = readRelease(sourceRoot, process.env.GITHUB_REF, { sourceOnly: options.sourceOnly === true });
  assertSourceObjects(source, bytes);
  assert.deepEqual(snapshot.release, source.release, "Source inventory release mismatch");
  const commit = options.sourceOnly === true ? checkoutCommit(sourceRoot) : validateCheckout(sourceRoot, source.release, process.env.GITHUB_REF, SOURCE_FILES);
  assert.equal(snapshot.commit, commit, "Source inventory commit mismatch");
  checkpoint();
  return { ...source, sourceRoot, inventoryPath, inventorySha256: options.expectedInventorySha256, snapshot, bytes };
}

function inspectBytes(tarball, digest, source, checkpoint, distribution) {
  inspectArchiveBytes(readBoundedFile(tarball, MAX_ARCHIVE_BYTES), digest, source, checkpoint, distribution);
}

function confined(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function extractedFile(root, file) {
  const parts = ["package", ...file.split("/")];
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.resolve(directory, part);
    assert.ok(confined(root, directory), `Extracted path escapes the private directory: ${file}`);
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Expected a real extracted directory: ${file}`);
    assert.equal(realpathSync(directory), directory, `Extracted directory must not contain links: ${file}`);
  }
  const target = path.resolve(directory, parts.at(-1));
  assert.ok(confined(root, target), `Extracted path escapes the private directory: ${file}`);
  const stat = lstatSync(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular extracted file: ${file}`);
  const resolved = realpathSync(target);
  assert.ok(confined(root, resolved), `Extracted path escapes the private directory: ${file}`);
  assert.equal(resolved, target, `Extracted path must not contain links: ${file}`);
  return target;
}

function removeExtraction(root, files) {
  const entries = new Set([root]);
  for (const file of files) {
    const target = path.resolve(root, "package", ...file.split("/"));
    entries.add(target);
    for (let directory = path.dirname(target); directory !== root; directory = path.dirname(directory)) entries.add(directory);
  }
  for (const entry of [...entries].sort((left, right) => left.length - right.length)) {
    try {
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) continue;
      const resolved = realpathSync(entry);
      if (resolved !== root && (!confined(root, resolved) || resolved !== entry)) continue;
      if (stat.isDirectory()) chmodSync(entry, 0o700);
      else if (stat.isFile()) chmodSync(entry, 0o600);
    } catch { /* best-effort permission restore before forced removal */ }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function assertPlainRegularTar(rawTar) {
  assert.equal(rawTar.length % 512, 0, "TAR bytes must contain complete records");
  for (let offset = 0; offset < rawTar.length;) {
    const header = rawTar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { offset += 512; continue; }
    assert.ok(header[156] === 0 || header[156] === 48, "Archive may contain only plain regular-file headers");
    const encodedSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    assert.match(encodedSize, /^[0-7]+$/, "Archive contains an unsupported TAR size field");
    const size = Number.parseInt(encodedSize, 8);
    assert.ok(Number.isSafeInteger(size) && size <= MAX_TAR_BYTES, "Archive TAR entry exceeds byte bound");
    offset += 512 + Math.ceil(size / 512) * 512;
    assert.ok(offset <= rawTar.length, "Archive TAR entry exceeds available bytes");
  }
}

function inspectArchiveBytes(archive, digest, source, checkpoint, distribution) {
  const files = distributionFiles(distribution);
  assert.equal(integrity(archive), digest, "Packed integrity mismatch or artifact changed after validation");
  // bsdtar can miss later gzip members. Decode once with strict gzip validation and
  // an aggregate cap, then reject any hidden nonzero tail that gunzip did not consume.
  checkpoint();
  const { buffer: rawTar, engine } = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES, info: true });
  assert.ok(Number.isInteger(engine.bytesWritten) && engine.bytesWritten >= 0 && engine.bytesWritten <= archive.length, "Invalid gzip consumption boundary");
  assert.ok(archive.subarray(engine.bytesWritten).every((byte) => byte === 0), "Unconsumed nonzero bytes after gzip stream");
  checkpoint();
  assertPlainRegularTar(rawTar);
  checkpoint();
  const tar = (args) => {
    const output = execFileSync("tar", ["--ignore-zeros", ...args, "-f", "-"], {
      input: rawTar, timeout: checkpoint(), maxBuffer: MAX_FILE_BYTES, windowsHide: true,
      env: { ...process.env, TAR_OPTIONS: "" },
    });
    checkpoint();
    return output;
  };
  const entries = tar(["-t"]).toString("utf8").trimEnd().split(/\r?\n/);
  assert.ok(entries.every((entry) => entry.startsWith("package/")), "Unexpected archive prefix");
  validateFiles(entries.map((entry) => entry.slice("package/".length)), distribution);
  const types = tar(["-tv"]).toString("utf8").trimEnd().split(/\r?\n/);
  assert.equal(types.length, files.length, "Archive type list count mismatch");
  assert.ok(types.every((entry) => entry.startsWith("-")), "Archive may contain only regular files");
  // The allowlist and type list are checked before one complete extraction from
  // the same immutable TAR bytes. Private, canonical staging makes every later
  // descriptor read both bounded and independent from the original archive path.
  const extractionPath = mkdtempSync(path.join(os.tmpdir(), "ftp-release-inspect-"));
  let extractionRoot = extractionPath;
  try {
    extractionRoot = realpathSync(extractionPath);
    chmodSync(extractionRoot, 0o700);
    tar(["-x", "-C", extractionRoot]);
    for (const file of files) {
      checkpoint();
      const content = readBoundedFile(extractedFile(extractionRoot, file), MAX_FILE_BYTES);
      if (file === "package.json") assert.deepEqual(JSON.parse(content), source.pkg, "Archive package manifest differs from the reviewed package.json");
      if (file === "package-lock.json") assert.deepEqual(JSON.parse(content), source.lock, "Archive dependency graph differs from the reviewed package lock");
      assert.ok(content.equals(source.bytes.get(file)), `Archive file differs from reviewed source bytes: ${file}`);
    }
  } finally { removeExtraction(extractionRoot, files); }
  checkpoint();
}

export function inspectArtifact(file, options) {
  assertReleaseToolchain();
  const checkpoint = budget(options);
  const source = approvedSource(options, checkpoint);
  const distribution = options.distribution ?? "npm";
  const item = validatePack(JSON.parse(readBoundedFile(file, MAX_FILE_BYTES)), source.release, distribution);
  if (options.expectedIntegrity !== undefined) {
    assert.match(options.expectedIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "Original build SHA512 is required");
    assert.equal(item.integrity, options.expectedIntegrity, "Packed integrity differs from the original build integrity");
  }
  const tarball = canonical(path.resolve(path.dirname(file), item.filename));
  assert.equal(path.basename(tarball), item.filename, "Unexpected canonical artifact filename");
  inspectBytes(tarball, item.integrity, source, checkpoint, distribution);
  const record = { schemaVersion: 1, distribution, filename: artifactFilename(source.release, distribution), prefix: "package/", scope: source.snapshot.scope, ...source.release, commit: source.snapshot.commit,
    tarball, integrity: item.integrity, sourceRoot: source.sourceRoot, inventoryPath: source.inventoryPath, inventorySha256: source.inventorySha256 };
  checkpoint();
  writeFileSync(`${file}.verified.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return { item, record };
}

export function checkArtifact(record, options) {
  assertReleaseToolchain();
  const checkpoint = budget(options);
  const source = approvedSource(options, checkpoint);
  const distribution = options.distribution ?? "npm";
  assert.match(options.expectedIntegrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "Original artifact SHA512 is required");
  const tarball = canonical(options.expectedTarball);
  assert.equal(tarball, options.expectedTarball, "Original canonical artifact path is required");
  assert.equal(path.basename(tarball), artifactFilename(source.release, distribution), "Unexpected artifact filename");
  const expected = { schemaVersion: 1, distribution, filename: artifactFilename(source.release, distribution), prefix: "package/", scope: source.snapshot.scope, ...source.release, commit: source.snapshot.commit,
    tarball, integrity: options.expectedIntegrity, sourceRoot: source.sourceRoot, inventoryPath: source.inventoryPath, inventorySha256: source.inventorySha256 };
  assert.deepEqual(record, expected, "Artifact proof differs from original workflow bindings");
  inspectBytes(tarball, options.expectedIntegrity, source, checkpoint, distribution);
  return record;
}

function artifactMetadata(source, distribution, archive) {
  return { ...source.release, distribution, filename: artifactFilename(source.release, distribution), integrity: integrity(archive),
    files: distributionFiles(distribution).map((file) => ({ path: file, size: source.bytes.get(file).length })) };
}

function writeArtifactFiles(file, source, item, archive) {
  const metadataPath = inventoryDestination(file, source.sourceRoot);
  const tarball = path.join(path.dirname(metadataPath), item.filename);
  const written = [];
  try {
    writeFileSync(tarball, archive, { flag: "wx" }); written.push(tarball);
    writeFileSync(metadataPath, JSON.stringify([item], null, 2) + "\n", { flag: "wx" }); written.push(metadataPath);
    return { tarball: canonical(tarball), metadataPath };
  } catch (error) {
    for (const owned of written) rmSync(owned, { force: true });
    throw error;
  }
}

export function buildSourceArtifact(file, options) {
  assertReleaseToolchain();
  assert.ok(options.distribution === undefined || options.distribution === "source", "Source builder requires source distribution");
  const checkpoint = budget(options);
  const source = approvedSource(options, checkpoint);
  const staging = mkdtempSync(path.join(os.tmpdir(), "ftp-source-build-"));
  let archive;
  try {
    for (const name of SOURCE_FILES) {
      checkpoint();
      const target = path.join(staging, "package", name);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, source.bytes.get(name), { flag: "wx", mode: 0o600 });
    }
    archive = execFileSync("tar", ["--ignore-zeros", "--format=ustar", "-czf", "-", "-C", staging, ...SOURCE_FILES.map((name) => `package/${name}`)], {
      timeout: checkpoint(), maxBuffer: MAX_ARCHIVE_BYTES, windowsHide: true, env: { ...process.env, TAR_OPTIONS: "" },
    });
    assert.ok(archive.length <= MAX_ARCHIVE_BYTES, "Source archive exceeds compressed byte limit");
    inspectArchiveBytes(archive, integrity(archive), source, checkpoint, "source");
  } finally { rmSync(staging, { recursive: true, force: true }); }
  checkpoint();
  const item = artifactMetadata(source, "source", archive);
  const { tarball } = writeArtifactFiles(file, source, item, archive);
  return { item, tarball };
}

export function registryTarballURL(release) {
  return `https://registry.npmjs.org/${release.name}/-/${artifactFilename(release, "npm")}`;
}

export async function downloadRegistryArchive(url, { fetchImpl = fetch, checkpoint = budget() } = {}) {
  assertReleaseToolchain();
  assert.match(url, /^https:\/\/registry\.npmjs\.org\/ftp-deploy-mcp\/-\/ftp-deploy-mcp-\d+\.\d+\.\d+\.tgz$/, "Only the fixed official npm tarball URL is allowed");
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(checkpoint()) });
  let reader;
  const chunks = [];
  let size = 0;
  try {
    checkpoint();
    assert.equal(response.status, 200, `npm tarball download failed: HTTP ${response.status}`);
    if (response.url) assert.equal(response.url, url, "Registry tarball URL changed");
    const declared = response.headers?.get("content-length");
    if (declared !== null && declared !== undefined) assert.ok(/^\d+$/.test(declared) && Number(declared) <= MAX_ARCHIVE_BYTES, "Registry tarball Content-Length exceeds byte bound");
    reader = response.body.getReader();
    while (true) {
      checkpoint();
      const { done, value } = await reader.read();
      checkpoint();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= MAX_ARCHIVE_BYTES, "Registry tarball exceeds compressed byte bound");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    else await response.body?.cancel();
  }
  checkpoint();
  return Buffer.concat(chunks, size);
}

export async function fetchNpmArtifact(file, options, { fetchImpl = fetch } = {}) {
  assertReleaseToolchain();
  assert.ok(options.distribution === undefined || options.distribution === "npm", "Registry download requires npm distribution");
  const checkpoint = budget(options);
  const source = approvedSource(options, checkpoint);
  const metadata = await verifyPublished(source.release, options.expectedIntegrity, { fetchImpl, attempts: 1 });
  const url = registryTarballURL(source.release);
  assert.equal(metadata.dist.tarball, url, "Registry metadata must name the fixed official npm tarball URL");
  const archive = await downloadRegistryArchive(url, { fetchImpl, checkpoint });
  inspectArchiveBytes(archive, metadata.dist.integrity, source, checkpoint, "npm");
  const item = artifactMetadata(source, "npm", archive);
  checkpoint();
  const { tarball, metadataPath } = writeArtifactFiles(file, source, item, archive);
  const record = { schemaVersion: 1, distribution: "npm", filename: item.filename, prefix: "package/", scope: source.snapshot.scope,
    ...source.release, commit: source.snapshot.commit, tarball, integrity: item.integrity,
    sourceRoot: source.sourceRoot, inventoryPath: source.inventoryPath, inventorySha256: source.inventorySha256 };
  checkpoint();
  writeFileSync(`${metadataPath}.verified.json`, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return { item, record };
}

export function validatePublished(metadata, release, expectedIntegrity) {
  for (const key of ["name", "version", "mcpName"]) assert.equal(metadata[key], release[key], `Published ${key} mismatch`);
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, "Published SHA512 integrity is required");
  if (expectedIntegrity !== undefined) assert.equal(metadata.dist.integrity, expectedIntegrity, "Published tarball integrity mismatch");
  return metadata;
}

const NPM_VERIFICATION_DEADLINE_MS = 15 * 60_000;
const NPM_VERIFICATION_REQUEST_MS = 15_000;
const NPM_VERIFICATION_ATTEMPTS = 32;
const NPM_RETRY_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function retryAfterMs(response, wallClock) {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const value = response.headers?.get?.("retry-after");
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const delay = seconds * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  const date = Date.parse(trimmed);
  const current = wallClock();
  return Number.isFinite(date) && Number.isFinite(current) ? Math.max(0, date - current) : undefined;
}

function redirectFailure(error) {
  return [error?.message, error?.cause?.message, error?.cause?.code]
    .some((value) => typeof value === "string" && /redirect/i.test(value));
}

function transportFailure(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || (error instanceof TypeError && error.cause !== undefined);
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch { /* best-effort release of an unused body */ }
}

export async function verifyPublished(release, expectedIntegrity, {
  fetchImpl = fetch,
  sleep = setTimeout,
  now = () => performance.now(),
  wallClock = Date.now,
  random = Math.random,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  deadlineMs = NPM_VERIFICATION_DEADLINE_MS,
  requestTimeoutMs = NPM_VERIFICATION_REQUEST_MS,
  attempts = NPM_VERIFICATION_ATTEMPTS,
} = {}) {
  assertReleaseToolchain();
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= NPM_VERIFICATION_ATTEMPTS, "Invalid retry bound");
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= NPM_VERIFICATION_DEADLINE_MS, "Invalid verification deadline");
  assert.ok(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= NPM_VERIFICATION_REQUEST_MS, "Invalid request timeout");
  const url = `https://registry.npmjs.org/${encodeURIComponent(release.name)}/${encodeURIComponent(release.version)}`;
  const deadline = now() + deadlineMs;
  let lastFailure;

  const exhausted = (attempt) => {
    const detail = lastFailure?.message ? `: ${lastFailure.message}` : "";
    return new Error(`npm verification deadline or attempt bound exhausted after ${attempt} attempt(s)${detail}`, { cause: lastFailure });
  };

  const retry = async (attempt, response) => {
    if (attempt >= attempts) throw exhausted(attempt);
    const remaining = deadline - now();
    if (remaining <= 0) throw exhausted(attempt);
    const ceiling = Math.min(60_000, 5_000 * (2 ** (attempt - 1)));
    const draw = random();
    assert.ok(Number.isFinite(draw) && draw >= 0 && draw <= 1, "Invalid retry jitter");
    const retryAfter = response ? retryAfterMs(response, wallClock) : undefined;
    const delay = Math.min(remaining, Math.max(ceiling / 2 + draw * ceiling / 2, retryAfter ?? 0));
    await sleep(delay);
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < 1) throw exhausted(attempt - 1);
    const timeout = Math.max(1, Math.floor(Math.min(requestTimeoutMs, remaining)));
    let response;
    try {
      response = await fetchImpl(url, {
        signal: timeoutSignal(timeout),
        redirect: "error",
        headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
    } catch (error) {
      if (redirectFailure(error) || !transportFailure(error)) throw error;
      lastFailure = error;
      await retry(attempt);
      continue;
    }

    if (deadline - now() <= 0) {
      await cancelBody(response);
      throw exhausted(attempt);
    }
    if (response.status !== 200) {
      await cancelBody(response);
      lastFailure = new Error(`npm verification failed: HTTP ${response.status}`);
      if (!NPM_RETRY_STATUSES.has(response.status)) throw lastFailure;
      await retry(attempt, response);
      continue;
    }

    let metadata;
    try {
      metadata = await response.json();
    } catch (error) {
      if (!transportFailure(error)) throw error;
      lastFailure = error;
      await retry(attempt);
      continue;
    }
    if (deadline - now() <= 0) throw exhausted(attempt);
    return validatePublished(metadata, release, expectedIntegrity);
  }
  throw exhausted(attempts);
}

if (isMain(import.meta.url)) {
  assertReleaseToolchain();
  const [mode, ...args] = process.argv.slice(2);
  const file = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  assert.ok(["snapshot", "build-source", "fetch-npm", "preflight", "inspect", "check", "verify-npm"].includes(mode), "Unknown release artifact command");
  const names = { "--source-root": "sourceRoot", "--inventory": "inventoryPath", "--inventory-sha256": "expectedInventorySha256",
    "--expected-integrity": "expectedIntegrity", "--expected-tarball": "expectedTarball", "--distribution": "distribution" };
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--source-only") {
      assert.ok(!Object.hasOwn(options, "sourceOnly"), "Duplicate source-only option");
      options.sourceOnly = true;
    } else {
      const name = names[args[i]];
      assert.ok(name && args[i + 1] && !Object.hasOwn(options, name), "Invalid or duplicate artifact option");
      options[name] = args[++i];
    }
  }
  if (mode === "preflight") options.sourceOnly = true;
  if (["inspect", "verify-npm", "fetch-npm"].includes(mode)) assert.ok(!options.sourceOnly, "Publication commands reject source-only scope");
  if (options.distribution !== undefined) distributionFiles(options.distribution);
  if (mode === "snapshot") {
    const { inventorySha256 } = captureSourceInventory(file, options);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `inventory-sha256=${inventorySha256}\n`);
    console.log(`Source inventory SHA256: ${inventorySha256}`);
  } else if (mode === "build-source") {
    const { item, tarball } = buildSourceArtifact(file, options);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\nintegrity=${item.integrity}\n`);
    console.log(`Built source installation archive: ${item.files.length} files\n${tarball}\n${item.integrity}`);
  } else if (mode === "inspect" || mode === "preflight" || mode === "fetch-npm") {
    const { item, record } = mode === "fetch-npm" ? await fetchNpmArtifact(file, options) : inspectArtifact(file, options);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${record.tarball}\nintegrity=${record.integrity}\n`);
    console.log(`Validated ${item.files.length} files (${record.scope}): ${item.filename}\n${record.integrity}\n${record.tarball}`);
  } else {
    const record = file ? checkArtifact(JSON.parse(readBoundedFile(file, MAX_FILE_BYTES)), options) : undefined;
    if (mode === "check") assert.ok(record, "Artifact record is required");
    if (mode === "verify-npm") {
      assert.ok(options.distribution === undefined || options.distribution === "npm", "npm verification refuses source distribution");
      const { release } = readRelease(options.sourceRoot ?? process.cwd());
      const published = await verifyPublished(release, options.expectedIntegrity);
      console.log(`Verified npm ${release.name}@${release.version}\n${published.dist.integrity}`);
    } else console.log("Artifact and all source bytes match the original workflow bindings");
  }
}
