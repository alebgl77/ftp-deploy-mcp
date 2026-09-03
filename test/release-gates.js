import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MCP_NAME, PACKAGE_NAME, SCHEMA, validateMetadata } from "../scripts/release-gate.mjs";
import { PACKAGE_FILES, checkArtifact, integrity, validateFiles, validatePack, validatePublished, verifyPublished } from "../scripts/release-artifact.mjs";

const release = { name: PACKAGE_NAME, version: "0.2.0", mcpName: MCP_NAME };
const ref = "refs/tags/v0.2.0";
const digest = integrity(Buffer.from("reviewed tarball"));
function fixture() {
  return {
    pkg: { ...release, bin: { [PACKAGE_NAME]: "src/index.js" } },
    lock: { name: PACKAGE_NAME, version: release.version, packages: { "": { name: PACKAGE_NAME, version: release.version } } },
    server: { $schema: SCHEMA, name: MCP_NAME, version: release.version, description: "Release fixture", packages: [{
      registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: PACKAGE_NAME,
      version: release.version, transport: { type: "stdio" },
    }] },
  };
}
function gate(data, tag = ref, runtime) {
  return validateMetadata(data.pkg, data.lock, data.server, tag, runtime);
}
function published() {
  return { ...release, dist: { integrity: digest } };
}

test("release gate accepts only coherent stable metadata and runtime", () => {
  assert.deepEqual(gate(fixture(), ref, "0.2.0"), release);
});

for (const tag of [undefined, "", "refs/heads/main", "refs/heads/v0.2.0", "refs/tags/0.2.0", "refs/tags/v0.1.0", "refs/tags/v0.2.0-rc.1", "refs/tags/v0.2.0\n"]) {
  test(`release gate rejects non-matching ref ${JSON.stringify(tag)}`, () => {
    const data = fixture();
    assert.throws(() => validateMetadata(data.pkg, data.lock, data.server, tag));
  });
}
for (const version of [undefined, 2, "", "v0.2.0", "01.2.0", "0.2", "0.2.0-rc.1", "0.2.0+build", "0.2.0\n"]) {
  test(`release gate rejects non-stable version ${JSON.stringify(version)}`, () => {
    const data = fixture();
    data.pkg.version = version;
    assert.throws(() => gate(data, `refs/tags/v${version}`));
  });
}
for (const [label, mutate] of [
  ["package name", (d) => { d.pkg.name = "another-package"; }],
  ["mcpName", (d) => { d.pkg.mcpName = "io.github.other/server"; }],
  ["lock name", (d) => { d.lock.name = "other"; }],
  ["lock version", (d) => { d.lock.version = "0.1.0"; }],
  ["lock root name", (d) => { d.lock.packages[""].name = "other"; }],
  ["lock root version", (d) => { d.lock.packages[""].version = "0.1.0"; }],
  ["missing lock root", (d) => { delete d.lock.packages[""]; }],
  ["schema", (d) => { d.server.$schema = "old-schema"; }],
  ["server name", (d) => { d.server.name = "io.github.other/server"; }],
  ["server version", (d) => { d.server.version = "0.1.0"; }],
  ["extra package", (d) => { d.server.packages.push({ ...d.server.packages[0] }); }],
  ["missing package", (d) => { d.server.packages = []; }],
  ["registry type", (d) => { d.server.packages[0].registryType = "pypi"; }],
  ["registry URL", (d) => { d.server.packages[0].registryBaseUrl = "https://other.invalid"; }],
  ["identifier", (d) => { d.server.packages[0].identifier = "other"; }],
  ["package version", (d) => { d.server.packages[0].version = "0.1.0"; }],
  ["transport", (d) => { d.server.packages[0].transport.type = "http"; }],
  ["executable", (d) => { d.pkg.bin[PACKAGE_NAME] = "test/index.js"; }],
  ["missing description", (d) => { delete d.server.description; }],
  ["empty description", (d) => { d.server.description = ""; }],
  ["long description", (d) => { d.server.description = "x".repeat(101); }],
]) {
  test(`release gate rejects divergent ${label}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => gate(data));
  });
}
for (const runtime of ["0.1.0", "", "0.2.0\nextra"]) {
  test(`release gate rejects runtime ${JSON.stringify(runtime)}`, () => assert.throws(() => gate(fixture(), ref, runtime)));
}

test("archive allowlist accepts exactly the reviewed files", () => validateFiles(PACKAGE_FILES));
for (const file of ["ftp-servers.json", ".env", ".npmrc", ".git/config", ".Codex/routing-ledger.md", "test/credentials.json", "docs/secret.pem", "src/.env", "../outside", "/absolute", "src\\index.js"]) {
  test(`archive allowlist excludes ${file}`, () => assert.throws(() => validateFiles([...PACKAGE_FILES, file])));
}
test("archive rejects missing or duplicate files", () => {
  assert.throws(() => validateFiles(PACKAGE_FILES.slice(1)));
  assert.throws(() => validateFiles([...PACKAGE_FILES, PACKAGE_FILES[0]]));
  assert.throws(() => validateFiles(undefined));
});
test("pack metadata binds a single archive to the release", () => {
  const pack = { ...release, filename: `${PACKAGE_NAME}-0.2.0.tgz`, files: PACKAGE_FILES.map((file) => ({ path: file })) };
  assert.equal(validatePack([pack], release), pack);
  for (const invalid of [[], [pack, pack], [{ ...pack, name: "other" }], [{ ...pack, version: "0.1.0" }], [{ ...pack, filename: "../escape.tgz" }]]) {
    assert.throws(() => validatePack(invalid, release));
  }
});
test("artifact mutation, missing bytes, identity drift and filename drift fail closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ftp-release-unit-"));
  try {
    const tarball = path.join(root, `${PACKAGE_NAME}-0.2.0.tgz`);
    writeFileSync(tarball, "reviewed tarball");
    const record = { ...release, tarball, integrity: digest };
    assert.equal(checkArtifact(record, release), record);
    for (const key of ["name", "version", "mcpName"]) assert.throws(() => checkArtifact({ ...record, [key]: "other" }, release));
    assert.throws(() => checkArtifact({ ...record, tarball: path.join(root, "other.tgz") }, release));
    writeFileSync(tarball, "modified tarball");
    assert.throws(() => checkArtifact(record, release));
    rmSync(tarball);
    assert.throws(() => checkArtifact(record, release));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public npm metadata must match identity and the exact validated SHA512", () => {
  assert.equal(validatePublished(published(), release, digest).dist.integrity, digest);
  for (const key of ["name", "version", "mcpName"]) assert.throws(() => validatePublished({ ...published(), [key]: "other" }, release, digest));
  for (const value of [undefined, "sha1-bad", "sha512-invalid", integrity(Buffer.from("different tarball"))]) {
    assert.throws(() => validatePublished({ ...release, dist: { integrity: value } }, release, digest));
  }
});
test("npm verification retries only propagation 404s and checks exact-version URL", async () => {
  let calls = 0;
  let canceled = 0;
  const delays = [];
  const result = await verifyPublished(release, digest, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://registry.npmjs.org/ftp-deploy-mcp/0.2.0");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      calls += 1;
      return calls < 3 ? { status: 404, body: { cancel: async () => { canceled += 1; } } } : { status: 200, json: async () => published() };
    },
    sleep: async (ms) => delays.push(ms),
  });
  assert.equal(result.version, release.version);
  assert.equal(calls, 3);
  assert.equal(canceled, 2);
  assert.deepEqual(delays, [5000, 5000]);
});
test("npm propagation retry budget is finite", async () => {
  let calls = 0;
  let sleeps = 0;
  await assert.rejects(verifyPublished(release, digest, {
    fetchImpl: async () => { calls += 1; return { status: 404 }; },
    sleep: async () => { sleeps += 1; },
  }), /HTTP 404/);
  assert.equal(calls, 6);
  assert.equal(sleeps, 5);
});
for (const status of [401, 403, 429, 500, 302]) {
  test(`npm HTTP ${status} fails immediately without treating it as absence`, async () => {
    let calls = 0;
    await assert.rejects(verifyPublished(release, digest, {
      fetchImpl: async () => { calls += 1; return { status }; },
      sleep: async () => assert.fail("Must not retry HTTP errors"),
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  });
}
test("npm transport errors, bad JSON and mismatched metadata never pass or retry", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("network/timeout"); },
    async () => ({ status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }),
    async () => ({ status: 200, json: async () => ({ ...published(), mcpName: "wrong" }) }),
  ]) {
    await assert.rejects(verifyPublished(release, digest, { fetchImpl, sleep: async () => assert.fail("Must not retry invalid results") }));
  }
});

test("publication workflows remain manual, pinned and secret-scoped", () => {
  const root = new URL("../.github/workflows/", import.meta.url);
  for (const file of ["release.yml", "publish-mcp.yml"]) {
    const source = readFileSync(new URL(file, root), "utf8");
    assert.match(source, /workflow_dispatch:/);
    assert.doesNotMatch(source, /^\s+(push|pull_request):/m);
    assert.match(source, /^permissions: \{\}/m);
    assert.match(source, /persist-credentials: false/);
    assert.match(source, /timeout-minutes:/);
    assert.match(source, /cancel-in-progress: false/);
    assert.match(source, /node scripts\/release-gate\.mjs --runtime/);
    for (const use of source.matchAll(/uses: ([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  }
  const npm = readFileSync(new URL("release.yml", root), "utf8");
  assert.equal((npm.match(/npm pack /g) || []).length, 1);
  assert.match(npm, /npm publish "\$RELEASE_TARBALL" --ignore-scripts --provenance/);
  assert.equal((npm.match(/secrets\./g) || []).length, 1);
  const mcp = readFileSync(new URL("publish-mcp.yml", root), "utf8");
  assert.doesNotMatch(mcp, /releases\/latest|secrets\./);
  assert.match(mcp, /PUBLISHER_SHA256: [a-f0-9]{64}/);
  assert.match(mcp, /sha256sum --check --strict/);
  assert.ok(mcp.indexOf("release-artifact.mjs verify-npm") < mcp.indexOf("login github-oidc"));
});
