import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { gunzipSync, gzipSync } from "node:zlib";
import { MAX_ARCHIVE_BYTES, MAX_FILE_BYTES, MAX_TAR_BYTES, SOURCE_FILES as PACKAGE_FILES, NPM_PACKAGE_FILES, approvedSource, buildSourceArtifact, captureSourceInventory, checkArtifact, fetchNpmArtifact, inspectArtifact, integrity, readBoundedFile, registryTarballURL } from "../scripts/release-artifact.mjs";
import { readRelease, validateCheckout } from "../scripts/release-gate.mjs";

const repo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ftp-release-artifact-")));
const sourceRoot = path.join(temp, "source");
const buildRoot = path.join(temp, "build");
const packageRoot = path.join(buildRoot, "package");
const inventoryPath = path.join(temp, "source-inventory.json");
const packFile = path.join(temp, "release-pack.json");
const proofFile = `${packFile}.verified.json`;
const outputFile = path.join(temp, "workflow-output.txt");
const git = (args) => execFileSync("git", ["-c", "core.hooksPath=" + path.join(temp, "no-hooks"), "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-C", sourceRoot, ...args], {
  windowsHide: true, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
});
let release, tarball, archive, inventoryBytes, options;
function pack(bytes = archive) {
  writeFileSync(tarball, bytes);
  writeFileSync(packFile, JSON.stringify([{ ...release, distribution: "source", filename: path.basename(tarball), integrity: integrity(bytes), files: PACKAGE_FILES.map((file) => ({ path: file })) }]));
}
function archiveFromBuild(files = PACKAGE_FILES) {
  return execFileSync("tar", ["--ignore-zeros", "--format=ustar", "-czf", "-", "-C", buildRoot, ...files.map((file) => `package/${file}`)], {
    windowsHide: true, timeout: 15000, maxBuffer: MAX_ARCHIVE_BYTES,
  });
}
function reset() {
  for (const file of PACKAGE_FILES) copyFileSync(path.join(sourceRoot, file), path.join(packageRoot, file));
  writeFileSync(inventoryPath, inventoryBytes);
  rmSync(proofFile, { force: true });
  rmSync(outputFile, { force: true });
  pack();
}
function rejected(bytes, pattern, inspectOptions = options, label) {
  pack(bytes);
  assert.throws(() => inspectArtifact(packFile, inspectOptions), pattern, label);
  assert.equal(existsSync(proofFile), false, "No proof may be written on failure");
  assert.equal(existsSync(outputFile), false, "No workflow output may be written on failure");
}
function changedArchive(file, mutate) {
  const target = path.join(packageRoot, file);
  const original = readFileSync(target);
  try { writeFileSync(target, mutate(original)); return archiveFromBuild(); }
  finally { writeFileSync(target, original); }
}

before(() => {
  for (const file of PACKAGE_FILES) {
    for (const target of [sourceRoot, packageRoot]) {
      mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
      copyFileSync(path.join(repo, file), path.join(target, file));
    }
  }
  // Disposable test repository only: these fixture refs are never release evidence.
  git(["init", "--quiet"]);
  git(["add", "--", "."]);
  git(["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "--quiet", "-m", "isolated fixture"]);
  const captured = captureSourceInventory(inventoryPath, { sourceRoot, sourceOnly: true });
  inventoryBytes = readFileSync(inventoryPath);
  options = { sourceRoot, sourceOnly: true, distribution: "source", inventoryPath, expectedInventorySha256: captured.inventorySha256 };
  release = captured.snapshot.release;
  tarball = path.join(temp, `${release.name}-${release.version}-source.tar.gz`);
  archive = archiveFromBuild();
  pack();
});
after(() => rmSync(temp, { recursive: true, force: true }));

test("real tar accepts all 82 exact source files and an exclusive proof rechecks unchanged", () => {
  reset();
  const { item, record } = inspectArtifact(packFile, options);
  assert.equal(item.files.length, 82);
  assert.equal(record.scope, "source-only");
  const proof = readFileSync(proofFile);
  assert.deepEqual(checkArtifact(record, { ...options, expectedIntegrity: record.integrity, expectedTarball: record.tarball }), record);
  assert.deepEqual(readFileSync(proofFile), proof, "Recheck must not rewrite the proof");
  assert.throws(() => inspectArtifact(packFile, options), /EEXIST/);
});

test("source builder uses approved bytes and source proofs cannot pass as npm", () => {
  reset(); const destination = path.join(temp, "source-builder"); mkdirSync(destination);
  const metadata = path.join(destination, "pack.json");
  const { item } = buildSourceArtifact(metadata, options);
  assert.equal(item.distribution, "source"); assert.equal(item.files.length, 82);
  const { record } = inspectArtifact(metadata, options);
  assert.equal(record.prefix, "package/");
  assert.equal(record.filename, `${release.name}-${release.version}-source.tar.gz`);
  assert.throws(() => checkArtifact(record, { ...options, distribution: "npm", expectedIntegrity: record.integrity, expectedTarball: record.tarball }));
  assert.throws(() => checkArtifact({ ...record, distribution: "npm" }, { ...options, expectedIntegrity: record.integrity, expectedTarball: record.tarball }));
  assert.throws(() => inspectArtifact(metadata, { ...options, distribution: "npm" }));
  assert.throws(() => buildSourceArtifact(metadata, options), /EEXIST/);
  assert.equal(NPM_PACKAGE_FILES.length, 81);
  assert.ok(!NPM_PACKAGE_FILES.includes("package-lock.json"));
});

for (const [name, mutate] of [
  ["optional dependency", (pkg) => { pkg.optionalDependencies = { rogue: "1.0.0" }; }],
  ["peer dependency", (pkg) => { pkg.peerDependencies = { rogue: "1.0.0" }; }],
  ["installation hook", (pkg) => { pkg.scripts.postinstall = "node malicious.js"; }],
  ["changed production pin", (pkg) => { pkg.dependencies["basic-ftp"] = "6.0.0"; }],
]) test(`recomputed tar integrity cannot hide manifest attack: ${name}`, () => {
  reset();
  rejected(changedArchive("package.json", (bytes) => { const pkg = JSON.parse(bytes); mutate(pkg); return JSON.stringify(pkg); }), /manifest differs/);
});
test("reordered manifest JSON is rejected because reviewed bytes are exact", () => {
  reset();
  rejected(changedArchive("package.json", (bytes) => JSON.stringify(JSON.parse(bytes))), /source bytes/);
});
test("package lock graph drift with recomputed tar integrity is rejected", () => {
  reset();
  rejected(changedArchive("package-lock.json", (bytes) => {
    const lock = JSON.parse(bytes); lock.packages["node_modules/basic-ftp"].integrity = integrity(Buffer.from("replacement")); return JSON.stringify(lock);
  }), /dependency graph differs/);
});
test("ordinary runtime substitution and line-ending normalization are rejected", () => {
  for (const [file, mutate] of [["src/tools.js", (bytes) => Buffer.concat([bytes, Buffer.from("\n// substituted\n")])],
    ["install.cmd", (bytes) => {
      const text = bytes.toString("utf8");
      const changed = Buffer.from(text.includes("\r\n") ? text.replaceAll("\r\n", "\n") : text.replaceAll("\n", "\r\n"));
      assert.ok(!changed.equals(bytes), "Line-ending fixture must actually change source bytes");
      return changed;
    }]]) {
    reset(); rejected(changedArchive(file, mutate), /source bytes/);
  }
});

for (const file of ["package.json", "package-lock.json", "server.json"]) {
  for (const mode of ["capture", "approval"]) test(`source objects stay bound to captured bytes during ${mode}: ${file}`, (t) => {
    reset(); const originalRead = fs.readFileSync; const target = path.join(sourceRoot, file);
    const changed = JSON.parse(originalRead(target));
    if (file === "package-lock.json") changed.packages["node_modules/basic-ftp"].integrity = integrity(Buffer.from("changed resolution"));
    else changed.description = "concurrent unapproved reread";
    const destination = path.join(temp, `raced-${mode}-${file}`);
    t.mock.method(fs, "readFileSync", (input, ...args) => typeof input === "string" && input === target ? JSON.stringify(changed) : originalRead(input, ...args));
    syncBuiltinESMExports();
    try {
      assert.throws(() => mode === "capture" ? captureSourceInventory(destination, options) : approvedSource(options), /Source objects differ from approved bytes/);
      assert.equal(existsSync(destination), false, "No raced source inventory may be written");
      assert.equal(existsSync(proofFile), false, "No raced source proof may be written");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("hidden duplicate after one zero block and appended archives are rejected", () => {
  const raw = gunzipSync(archive);
  const extra = gunzipSync(archiveFromBuild(["package.json"]));
  const zero = Buffer.alloc(512);
  let contentEnd = raw.length;
  while (contentEnd >= 512 && raw.subarray(contentEnd - 512, contentEnd).equals(zero)) contentEnd -= 512;
  for (const [label, bytes, pattern] of [
    ["one zero TAR block", gzipSync(Buffer.concat([raw.subarray(0, contentEnd), zero, extra])), /Duplicate package path|allowlist/],
    ["appended raw TAR", gzipSync(Buffer.concat([raw, extra])), /Duplicate package path|allowlist/],
    ["adjacent canonical gzip members", Buffer.concat([gzipSync(raw), gzipSync(extra)]), /Duplicate package path|allowlist/],
    ["second member after bsdtar gzip padding", Buffer.concat([archive, gzipSync(extra)]), /Unconsumed nonzero bytes|Duplicate package path/],
  ]) {
    reset(); rejected(bytes, pattern, options, label);
  }
});
test("complete gzip validation rejects hidden members, corruption, truncation and decompression overflow", () => {
  // bsdtar pads compressed stdout with NULs. Canonical members put their CRC/ISIZE
  // in the final eight bytes, so corruption/truncation tests target gzip itself.
  const first = gzipSync(gunzipSync(archive));
  const extra = gzipSync(gunzipSync(archiveFromBuild(["package.json"])));
  const badFirstCRC = Buffer.from(first); badFirstCRC[badFirstCRC.length - 8] ^= 1;
  const badSecondCRC = Buffer.from(extra); badSecondCRC[badSecondCRC.length - 8] ^= 1;
  for (const [label, bytes] of [
    ["member after explicit NUL padding", Buffer.concat([archive, Buffer.alloc(512), extra])],
    ["first member CRC", badFirstCRC], ["first member truncated trailer", first.subarray(0, first.length - 8)],
    ["second adjacent member CRC", Buffer.concat([first, badSecondCRC])],
    ["second adjacent member truncated trailer", Buffer.concat([first, extra.subarray(0, extra.length - 8)])],
    ["invalid gzip", Buffer.from("not gzip")], ["32 MiB decompressed cap", gzipSync(Buffer.alloc(MAX_TAR_BYTES + 1))],
  ]) { reset(); rejected(bytes, undefined, options, label); }
});
test("normal gzip, terminal zero padding and members reconstructing one conforming TAR are accepted", () => {
  const raw = gunzipSync(archive);
  const middle = Math.floor(raw.length / 2);
  for (const bytes of [archive, Buffer.concat([archive, Buffer.alloc(512)]), Buffer.concat([gzipSync(raw.subarray(0, middle)), gzipSync(raw.subarray(middle))])]) {
    reset(); pack(bytes); assert.equal(inspectArtifact(packFile, options).item.files.length, 82);
  }
});
test("unlisted, traversal, directory and link headers are rejected before extraction", () => {
  const raw = gunzipSync(archive);
  // Mutate the known first USTAR header generated by real tar; production has no tar parser.
  for (const [name, type] of [["package/unknown", "0"], ["package/../package.json", "0"], ["package/package.json", "5"], ["package/package.json", "2"], ["package/package.json", "1"]]) {
    const altered = Buffer.from(raw);
    altered.fill(0, 0, 100); altered.write(name, 0, "ascii"); altered[156] = type.charCodeAt(0);
    altered.fill(32, 148, 156);
    let checksum = 0; for (const value of altered.subarray(0, 512)) checksum += value;
    altered.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    reset(); rejected(gzipSync(altered));
  }
});

test("inventory mutation, missing/extra paths, wrong commit and wrong source fail closed", () => {
  for (const mutate of [
    (snapshot) => { snapshot.files[0].sha256 = "0".repeat(64); },
    (snapshot) => { snapshot.files.pop(); },
    (snapshot) => { snapshot.files.push({ path: "src/unknown", size: 0, sha256: "0".repeat(64) }); },
    (snapshot) => { snapshot.commit = "0".repeat(40); },
    (snapshot) => { snapshot.sourceRoot = packageRoot; },
    (snapshot) => { snapshot.extra = true; },
  ]) {
    reset(); const snapshot = JSON.parse(inventoryBytes); mutate(snapshot);
    writeFileSync(inventoryPath, JSON.stringify(snapshot));
    rejected(archive, /inventory changed/);
    const altered = { ...options, expectedInventorySha256: createHash("sha256").update(readFileSync(inventoryPath)).digest("hex") };
    rejected(archive, undefined, altered);
  }
  reset(); rejected(archive, undefined, { ...options, sourceRoot: packageRoot });
});
test("a changed source file cannot be approved by a newly matching archive", () => {
  reset(); const target = path.join(sourceRoot, "src/tools.js"); const original = readFileSync(target);
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from("\n// changed source")]));
    rejected(changedArchive("src/tools.js", () => readFileSync(target)), /Source bytes differ/);
  } finally { writeFileSync(target, original); }
});
test("source-only inventory cannot pass the publication inspection mode", () => {
  reset(); rejected(archive, /scope mismatch/, { ...options, sourceOnly: false });
});
test("an inventory remains valid at a different source root with the identical commit and files", () => {
  reset(); const moved = path.join(temp, "moved-source");
  fs.cpSync(sourceRoot, moved, { recursive: true });
  const { record } = inspectArtifact(packFile, { ...options, sourceRoot: moved });
  assert.equal(record.sourceRoot, moved);
  assert.deepEqual(readFileSync(inventoryPath), inventoryBytes);
});
test("privileged inspection rejects recompression with rewritten pack JSON against original integrity", () => {
  reset(); const recompressed = gzipSync(gunzipSync(archive), { level: 1 });
  assert.notEqual(integrity(recompressed), integrity(archive));
  rejected(recompressed, /original build integrity/, { ...options, expectedIntegrity: integrity(archive) });
});
test("original bindings reject archive+proof substitution and same-basename redirects", () => {
  reset(); const { record } = inspectArtifact(packFile, options);
  const bound = { ...options, expectedIntegrity: record.integrity, expectedTarball: record.tarball };
  for (const field of ["expectedIntegrity", "expectedTarball", "expectedInventorySha256", "inventoryPath", "sourceRoot"]) {
    const missing = { ...bound }; delete missing[field]; assert.throws(() => checkArtifact(record, missing));
  }
  const changed = changedArchive("src/tools.js", (bytes) => Buffer.concat([bytes, Buffer.from("\n// substitute")]));
  pack(changed);
  assert.throws(() => checkArtifact({ ...record, integrity: integrity(changed) }, bound), /original workflow bindings/);
  assert.throws(() => checkArtifact(record, bound), /integrity mismatch|artifact changed/);
  const redirected = path.join(temp, "redirected", path.basename(tarball));
  mkdirSync(path.dirname(redirected)); writeFileSync(redirected, archive);
  assert.throws(() => checkArtifact({ ...record, tarball: redirected }, bound), /original workflow bindings/);
  assert.throws(() => checkArtifact({ ...record, sourceRoot: packageRoot }, bound), /original workflow bindings/);
});

test("archive/file byte caps and deadlines reject without proof or outputs", () => {
  reset(); rejected(Buffer.alloc(MAX_ARCHIVE_BYTES + 1), /byte limit/);
  reset(); rejected(changedArchive("src/tools.js", () => Buffer.alloc(MAX_FILE_BYTES + 1, 65)));
  reset(); rejected(archive, /deadline/, { ...options, now: (() => { let tick = 0; return () => (tick += 90001); })() });
  // Exhaust the deadline between validation stages, including the final pre-proof checkpoint.
  let calls = 0;
  reset(); const baseline = inspectArtifact(packFile, { ...options, now: () => { calls += 1; return 0; } });
  assert.equal(baseline.item.files.length, 82);
  for (const at of [90, calls]) {
    reset(); let current = 0;
    rejected(archive, /deadline/, { ...options, now: () => (++current >= at ? 90001 : 0) });
  }
});
test("bounded source reads reject oversize, missing files and invalid byte bounds", () => {
  reset(); const target = path.join(sourceRoot, "src/tools.js"); const original = readFileSync(target);
  try {
    writeFileSync(target, Buffer.alloc(MAX_FILE_BYTES + 1)); rejected(archive, /byte limit/);
    rmSync(target); rejected(archive, /ENOENT/);
  } finally { writeFileSync(target, original); }
  assert.throws(() => readBoundedFile(target, 0));
  assert.throws(() => readBoundedFile(target, MAX_ARCHIVE_BYTES + 1));
  assert.throws(() => readBoundedFile(sourceRoot, 1), /regular file/);
});
test("failed CLI inspection never appends workflow outputs", () => {
  reset(); pack(changedArchive("src/tools.js", (bytes) => Buffer.concat([bytes, Buffer.from("changed")])));
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/release-artifact.mjs"), "preflight", packFile,
    "--distribution", "source", "--source-root", sourceRoot, "--inventory", inventoryPath, "--inventory-sha256", options.expectedInventorySha256], {
    windowsHide: true, encoding: "utf8", timeout: 90000, env: { ...process.env, GITHUB_OUTPUT: outputFile },
  });
  assert.notEqual(result.status, 0); assert.equal(existsSync(proofFile), false); assert.equal(existsSync(outputFile), false);
});
test("all tar invocations inspect the same immutable buffer even if its path is replaced", (t) => {
  reset(); const changed = changedArchive("src/tools.js", (bytes) => Buffer.concat([bytes, Buffer.from("changed")]));
  const originalExec = childProcess.execFileSync;
  const inputs = [];
  t.mock.method(childProcess, "execFileSync", (command, args, settings) => {
    if (command === "tar") {
      assert.ok(args.includes("--ignore-zeros"));
      assert.equal(args[args.indexOf("-f") + 1], "-");
      inputs.push(settings.input);
      if (inputs.length === 1) writeFileSync(tarball, changed);
    }
    return originalExec(command, args, settings);
  });
  syncBuiltinESMExports();
  let record;
  try {
    ({ record } = inspectArtifact(packFile, options));
    assert.equal(inputs.length, PACKAGE_FILES.length + 2);
    assert.ok(inputs.every((input) => input === inputs[0] && input.equals(gunzipSync(archive))));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.throws(() => checkArtifact(record, { ...options, expectedIntegrity: record.integrity, expectedTarball: record.tarball }), /integrity mismatch|artifact changed/);
});
test("descriptor reads cap concurrent file growth and always close the descriptor", (t) => {
  const file = path.join(temp, "growing-input"); writeFileSync(file, "small");
  const originalStat = fs.fstatSync;
  const originalRead = fs.readSync;
  let descriptor, requested = 0;
  t.mock.method(fs, "fstatSync", (fd, ...args) => {
    descriptor = fd; const stat = originalStat(fd, ...args); writeFileSync(file, Buffer.alloc(2048)); return stat;
  });
  t.mock.method(fs, "readSync", (fd, bytes, offset, length, position) => { requested += length; return originalRead(fd, bytes, offset, length, position); });
  syncBuiltinESMExports();
  try { assert.throws(() => readBoundedFile(file, 1024), /byte limit/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(requested <= 1025);
  assert.throws(() => originalStat(descriptor), /EBADF/);
});
test("registry qualification inspects the actual npm archive and preserves its original integrity", async () => {
  reset(); const destination = path.join(temp, "registry-good"); mkdirSync(destination);
  const metadata = path.join(destination, "pack.json");
  const npmArchive = archiveFromBuild(NPM_PACKAGE_FILES);
  const url = registryTarballURL(release);
  const fetchImpl = async (requested) => requested === url
    ? new Response(npmArchive, { status: 200 })
    : new Response(JSON.stringify({ ...release, dist: { tarball: url, integrity: integrity(npmArchive) } }), { status: 200 });
  const npmOptions = { ...options, distribution: "npm" };
  const { item, record } = await fetchNpmArtifact(metadata, npmOptions, { fetchImpl });
  assert.equal(item.files.length, 81); assert.equal(record.distribution, "npm");
  assert.equal(record.integrity, integrity(npmArchive));
  assert.deepEqual(readFileSync(record.tarball), npmArchive);
  checkArtifact(record, { ...npmOptions, expectedIntegrity: record.integrity, expectedTarball: record.tarball });
  assert.throws(() => checkArtifact(record, { ...npmOptions, distribution: "source", expectedIntegrity: record.integrity, expectedTarball: record.tarball }));
});
test("registry qualification rejects bad metadata, substituted bytes and source archives without outputs", async () => {
  reset(); const npmArchive = archiveFromBuild(NPM_PACKAGE_FILES); const url = registryTarballURL(release);
  for (const [label, bytes, dist] of [
    ["url", npmArchive, { tarball: "https://example.com/evil", integrity: integrity(npmArchive) }],
    ["digest", npmArchive, { tarball: url, integrity: integrity(Buffer.from("changed")) }],
    ["source", archive, { tarball: url, integrity: integrity(archive) }],
  ]) {
    const destination = path.join(temp, `registry-bad-${label}`); mkdirSync(destination); const metadata = path.join(destination, "pack.json");
    const fetchImpl = async (requested) => requested === url ? new Response(bytes, { status: 200 }) : new Response(JSON.stringify({ ...release, dist }), { status: 200 });
    await assert.rejects(fetchNpmArtifact(metadata, { ...options, distribution: "npm" }, { fetchImpl }), undefined, label);
    assert.deepEqual(fs.readdirSync(destination), [], label + " must write no artifact, metadata or proof");
  }
});
test("publication context binds the real clean tag commit and tracked source inventory", (t) => {
  reset(); git(["tag", `v${release.version}`]);
  const ref = `refs/tags/v${release.version}`;
  const eventCommit = git(["rev-parse", "HEAD"]).trim();
  assert.equal(validateCheckout(sourceRoot, release, ref, PACKAGE_FILES, eventCommit), eventCommit);
  assert.throws(() => validateCheckout(path.join(sourceRoot, "src"), release, ref, [], eventCommit), /Source root must be the checkout root/);
  const aliasRoot = path.join(temp, "source-alias");
  fs.symlinkSync(sourceRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(validateCheckout(aliasRoot, release, ref, PACKAGE_FILES, eventCommit), eventCommit);
    assert.throws(() => validateCheckout(path.join(aliasRoot, "src"), release, ref, [], eventCommit), /Source root must be the checkout root/);
  } finally { rmSync(aliasRoot); }
  if (process.platform === "win32") {
    // cmd expands the current fixture directory without interpolating its path.
    const shortRoot = execFileSync("cmd.exe", ["/d", "/c", "for %I in (.) do @echo %~fsI"], {
      cwd: sourceRoot, encoding: "utf8", windowsHide: true, timeout: 15000,
    }).trim();
    assert.equal(realpathSync.native(shortRoot), realpathSync.native(sourceRoot));
    if (realpathSync(shortRoot) !== realpathSync.native(shortRoot)) {
      assert.equal(validateCheckout(shortRoot, release, ref, PACKAGE_FILES, eventCommit), eventCommit);
      assert.throws(() => validateCheckout(path.join(shortRoot, "src"), release, ref, [], eventCommit), /Source root must be the checkout root/);
      t.diagnostic("Validated the real Windows 8.3 alias and rejected its subdirectory");
    } else t.diagnostic("This Windows volume supplies no distinct 8.3 alias; directory alias checked above");
  }
  assert.throws(() => validateCheckout(sourceRoot, release, ref, PACKAGE_FILES, "0".repeat(40)), /event commit/);
  assert.throws(() => validateCheckout(sourceRoot, release, "refs/heads/main", PACKAGE_FILES));
  assert.throws(() => validateCheckout(sourceRoot, release, ref, [...PACKAGE_FILES, "untracked.txt"], eventCommit));
  const target = path.join(sourceRoot, "src/tools.js"); const original = readFileSync(target);
  try { writeFileSync(target, "modified"); assert.throws(() => validateCheckout(sourceRoot, release, ref, PACKAGE_FILES, eventCommit), /unchanged checkout/); }
  finally { writeFileSync(target, original); }
  const originalRef = process.env.GITHUB_REF;
  const originalSha = process.env.GITHUB_SHA;
  try {
    process.env.GITHUB_REF = ref; // This process-local fixture ref is never qualification evidence.
    process.env.GITHUB_SHA = eventCommit;
    const snapshot = captureSourceInventory(path.join(temp, "publication.json"), { sourceRoot });
    assert.equal(snapshot.snapshot.scope, "publication");
    const strict = { sourceRoot, distribution: "source", inventoryPath: snapshot.inventoryPath, expectedInventorySha256: snapshot.inventorySha256 };
    const { record } = inspectArtifact(packFile, strict);
    assert.equal(record.scope, "publication");
    assert.deepEqual(checkArtifact(record, { ...strict, expectedIntegrity: record.integrity, expectedTarball: record.tarball }), record);
    const mockFetch = path.join(temp, "mock-registry.mjs");
    writeFileSync(mockFetch, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ ...release, dist: { integrity: integrity(archive) } }))}, { status: 200 });`);
    const bare = spawnSync(process.execPath, ["--import", pathToFileURL(mockFetch).href, path.join(repo, "scripts/release-artifact.mjs"), "verify-npm",
      "--source-root", sourceRoot, "--expected-integrity", integrity(Buffer.from("wrong original integrity"))], {
      windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });
    assert.notEqual(bare.status, 0, "Bare verify-npm must enforce the original integrity");
    assert.match(bare.stderr, /Published tarball integrity mismatch/);
    assert.equal(existsSync(outputFile), false);
    git(["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "different fixture commit"]);
    assert.throws(() => readRelease(sourceRoot, ref), /event commit/);
    process.env.GITHUB_SHA = git(["rev-parse", "HEAD"]).trim();
    assert.throws(() => readRelease(sourceRoot, ref), /tag must point/);
  } finally {
    if (originalRef === undefined) delete process.env.GITHUB_REF; else process.env.GITHUB_REF = originalRef;
    if (originalSha === undefined) delete process.env.GITHUB_SHA; else process.env.GITHUB_SHA = originalSha;
  }
});
