import { assertReleaseToolchain, RELEASE_NODE_VERSION, releaseToolchainVersions } from "../scripts/release-toolchain.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MCP_NAME, PACKAGE_NAME, SCHEMA, PRODUCTION_PINS, validateChangelog, validateDependencies, validateMetadata, validateSourceMetadata } from "../scripts/release-gate.mjs";
import { PACKAGE_FILES, MAX_ARCHIVE_BYTES, checkArtifact, downloadRegistryArchive, integrity, validateFiles, validatePack, validatePublished, verifyPublished } from "../scripts/release-artifact.mjs";


assertReleaseToolchain();
const release = { name: PACKAGE_NAME, version: "0.2.0", mcpName: MCP_NAME };
const ref = "refs/tags/v0.2.0";
const digest = integrity(Buffer.from("reviewed tarball"));
function fixture() {
  return {
    pkg: { ...release, bin: { [PACKAGE_NAME]: "src/index.js" }, dependencies: { ...PRODUCTION_PINS } },
    lock: { name: PACKAGE_NAME, version: release.version, lockfileVersion: 3, packages: { "": { name: PACKAGE_NAME, version: release.version, dependencies: { ...PRODUCTION_PINS } }, ...Object.fromEntries(Object.entries(PRODUCTION_PINS).map(([name, version]) => [`node_modules/${name}`, { version, resolved: `https://registry.npmjs.org/${name}/-/fixture-${version}.tgz`, integrity: digest }])) } },
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

test("source metadata validation does not invent a publication ref", () => {
  const { pkg, lock, server } = fixture();
  assert.deepEqual(validateSourceMetadata(pkg, lock, server, release.version), release);
  assert.throws(() => validateMetadata(pkg, lock, server, undefined));
});

for (const field of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "overrides", "workspaces"]) {
  for (const value of [null, {}, [], ""]) test(`root policy rejects presence of ${field}=${JSON.stringify(value)}`, () => {
    for (const location of ["manifest", "lock"]) {
      const { pkg, lock } = fixture();
      (location === "manifest" ? pkg : lock.packages[""])[field] = value;
      assert.throws(() => validateDependencies(pkg, lock));
    }
  });
}
for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepublishOnly", "prepack", "postpack", "publish", "postpublish"]) {
  test(`root policy rejects ${hook} even when empty`, () => {
    for (const location of ["manifest", "lock"]) {
      const { pkg, lock } = fixture();
      (location === "manifest" ? pkg : lock.packages[""]).scripts = { [hook]: "" };
      assert.throws(() => validateDependencies(pkg, lock));
    }
  });
}
for (const resolved of ["http://registry.npmjs.org/a.tgz", "https://other.invalid/a.tgz", "https://registry.npmjs.org.evil.invalid/a.tgz", "https://user:secret@registry.npmjs.org/a.tgz", "https://@registry.npmjs.org/a.tgz", "https://registry.npmjs.org/a.tgz?query", "https://registry.npmjs.org/a.tgz#fragment", "https://registry.npmjs.org/a.tgz?", "https://registry.npmjs.org/a.tgz#", "file:../local", "git+https://github.com/example/repo", null]) {
  test(`lock policy rejects unsafe resolution ${JSON.stringify(resolved)}`, () => {
    const { pkg, lock } = fixture();
    lock.packages["node_modules/basic-ftp"].resolved = resolved;
    assert.throws(() => validateDependencies(pkg, lock));
  });
}
for (const [key, value] of [["integrity", null], ["integrity", "sha1-invalid"], ["integrity", "sha512-invalid"], ["version", "^6.0.1"], ["link", false]]) {
  test(`lock policy rejects invalid ${key}=${value}`, () => {
    const { pkg, lock } = fixture();
    lock.packages["node_modules/basic-ftp"][key] = value;
    assert.throws(() => validateDependencies(pkg, lock));
  });
}
test("root policy preserves legitimate transitive flags and ordinary named scripts", () => {
  const { pkg, lock } = fixture();
  pkg.scripts = { test: "node --test", setup: "node setup.js" };
  Object.assign(lock.packages["node_modules/basic-ftp"], { peer: true, optional: true, hasInstallScript: true, peerDependencies: { other: "^1" }, peerDependenciesMeta: { other: { optional: true } } });
  validateDependencies(pkg, lock);
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
test("scripted evaluation and pure workflow files ship without tests, tooling or results", () => {
  assert.equal(PACKAGE_FILES.length, 83);
  for (const file of ["docs/SCRIPTED-EVALUATIONS.md", "docs/SCRIPTED-EVALUATIONS.fr.md", "docs/WORKFLOW-MODEL.md", "docs/WORKFLOW-MODEL.fr.md",
    "src/workflow/model.mjs", "src/workflow/events.mjs", "src/workflow/budget.mjs"]) assert.ok(PACKAGE_FILES.includes(file));
  for (const file of ["scripts/evaluation/run.mjs", "test/fixtures/evaluation/corpus.spec.json", ".tmp/evaluations/reports/latest.json",
    "test/workflow/model.test.mjs", "test/workflow/events.test.mjs", "test/workflow/budget.test.mjs", "test/workflow/helpers.mjs", "review-inventory.json"]) {
    assert.throws(() => validateFiles([...PACKAGE_FILES, file]));
  }
});
for (const file of ["ftp-servers.json", ".env", ".npmrc", ".git/config", ".Codex/routing-ledger.md", "test/credentials.json", "docs/secret.pem", "src/.env", "../outside", "/absolute", "src\\index.js"]) {
  test(`archive allowlist excludes ${file}`, () => assert.throws(() => validateFiles([...PACKAGE_FILES, file])));
}
test("archive rejects missing or duplicate files", () => {
  assert.throws(() => validateFiles(PACKAGE_FILES.slice(1)));
  assert.throws(() => validateFiles([...PACKAGE_FILES, PACKAGE_FILES[0]]));
  assert.throws(() => validateFiles(undefined));
});
test("changelog gate requires a dated newest section matching the release", () => {
  assert.equal(validateChangelog(`# Changelog

## [0.2.0] - 2026-09-09

### Added

## [0.1.0] - 2026-07-20
`, "0.2.0", "CHANGELOG.md"), "2026-09-09");
  assert.equal(validateChangelog("# Changelog\r\n\r\n## [0.2.0] - 2026-09-09\r\n", "0.2.0", "CHANGELOG.fr.md"), "2026-09-09");
  for (const bad of [
    "## [0.2.0] - Release candidate (2026-09-03)",
    "## [0.2.0] - Version candidate (2026-09-03)",
    "## [0.1.0] - 2026-07-20",
    "## [0.2.0]",
    "## [0.2.0] - 2026-09-09 (pending)",
    "## [0.2.0] - 2026-9-9",
    "no release section here",
  ]) assert.throws(() => validateChangelog(bad, "0.2.0", "CHANGELOG.md"));
});
for (const date of ["0001-01-01", "0099-12-31", "1900-02-28", "2000-02-29", "2100-03-01", "2024-02-29"]) {
  test(`changelog calendar accepts ${date}`, () => assert.equal(validateChangelog(`## [0.2.0] - ${date}`, "0.2.0", "fixture"), date));
}
for (const date of ["0000-01-01", "2026-00-01", "2026-01-00", "2026-13-01", "2026-04-31", "2026-02-29", "1900-02-29", "2100-02-29"]) {
  test(`changelog calendar rejects ${date}`, () => assert.throws(() => validateChangelog(`## [0.2.0] - ${date}`, "0.2.0", "fixture")));
}

test("pack metadata binds a single archive to the release", () => {
  const pack = { ...release, filename: `${PACKAGE_NAME}-0.2.0.tgz`, files: PACKAGE_FILES.map((file) => ({ path: file })) };
  assert.equal(validatePack([pack], release), pack);
  // npm 11 and earlier emit an array; npm 12 emits an object keyed by package name.
  assert.equal(validatePack({ [PACKAGE_NAME]: pack }, release), pack);
  for (const invalid of [[], [pack, pack], [{ ...pack, name: "other" }], [{ ...pack, version: "0.1.0" }], [{ ...pack, filename: "../escape.tgz" }],
    {}, { a: pack, b: pack }, { [PACKAGE_NAME]: { ...pack, version: "0.1.0" } }, null, undefined, "pack"]) {
    assert.throws(() => validatePack(invalid, release));
  }
});
test("artifact recheck requires original source and workflow bindings", () => {
  assert.throws(() => checkArtifact({ ...release, tarball: "untrusted.tgz", integrity: digest }, {}));
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
    const [qualification, publication] = source.split(/^  publish:\s*$/m);
    assert.ok(qualification && publication, "Separate qualification and publication jobs are required");
    assert.doesNotMatch(qualification, /id-token:|secrets\./);
    assert.match(publication, /needs: qualify/);
    assert.equal((publication.match(/id-token: write/g) || []).length, 1);
    assert.doesNotMatch(publication, /npm (ci|install|test|run)|--runtime|release-smoke|node --test/);
    assert.equal((source.match(/ref: \$\{\{ github.sha \}\}/g) || []).length, 2, "Both fresh checkouts must use the event commit");
    assert.match(publication, /package-manager-cache: false/);
    assert.ok(qualification.indexOf("release-artifact.mjs snapshot") < qualification.indexOf("npm ci --ignore-scripts"));
    assert.match(qualification, /release-graph\.mjs .*--product-root .*node_modules\/ftp-deploy-mcp.*--install-root .*--output /);
    assert.doesNotMatch(qualification, /continue-on-error:|release-graph[^\n]+\|\|/);
    for (const use of source.matchAll(/uses: ([^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  }
  const npm = readFileSync(new URL("release.yml", root), "utf8");
  assert.equal((npm.match(/npm pack /g) || []).length, 1);
  assert.match(npm, /npm publish "\$RELEASE_TARBALL" --ignore-scripts --provenance/);
  assert.equal((npm.match(/secrets\./g) || []).length, 1);
  assert.ok(npm.indexOf("release-artifact.mjs snapshot") < npm.indexOf("npm ci --ignore-scripts"));
  assert.match(npm, /artifact-ids: \$\{\{ needs.qualify.outputs.artifact-id \}\}/);
  assert.match(npm, /path: \$\{\{ runner.temp \}\}\/release-input/);
  assert.match(npm, /npm audit --prefix "\$RUNNER_TEMP\/release-smoke" --omit=dev/);
  assert.match(npm, /inspect .*--expected-integrity "\$BUILD_INTEGRITY"/);
  assert.match(npm, /check .*--inventory-sha256 "\$SOURCE_INVENTORY_SHA256" --expected-integrity "\$RELEASE_INTEGRITY" --expected-tarball "\$RELEASE_TARBALL"/);
  assert.match(npm, /verify-npm .*--expected-integrity "\$RELEASE_INTEGRITY" --expected-tarball "\$RELEASE_TARBALL"/);
  const uploaded = npm.match(/          path: \|\r?\n((?:            .+\r?\n?)+)/)?.[1].trim().split(/\r?\n/).map((line) => line.trim());
  assert.deepEqual(uploaded, ["${{ steps.artifact.outputs.tarball }}", "${{ runner.temp }}/release-pack.json", "${{ runner.temp }}/source-inventory.json"]);
  const mcp = readFileSync(new URL("publish-mcp.yml", root), "utf8");
  assert.doesNotMatch(mcp, /releases\/latest|secrets\./);
  assert.match(mcp, /PUBLISHER_SHA256: [a-f0-9]{64}/);
  assert.match(mcp, /sha256sum --check --strict/);
  assert.match(mcp, /release-artifact\.mjs fetch-npm .*--inventory-sha256 .*--distribution npm/);
  assert.match(mcp, /integrity: \$\{\{ steps.artifact.outputs.integrity \}\}/);
  assert.ok(mcp.indexOf("release-artifact.mjs verify-npm") < mcp.indexOf("login github-oidc"));
  const mcpPublication = mcp.split(/^  publish:\s*$/m)[1];
  assert.match(mcpPublication, /QUALIFIED_INTEGRITY: \$\{\{ needs.qualify.outputs.integrity \}\}/);
  assert.match(mcpPublication, /verify-npm .*--expected-integrity "\$QUALIFIED_INTEGRITY" --distribution npm/);
  assert.ok(mcpPublication.indexOf("release-artifact.mjs verify-npm") < mcpPublication.indexOf("login github-oidc"));
});

test("CI shares pack normalization and installs only the authoritative source lock without scripts", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal((ci.match(/cache-dependency-path: package-lock.json/g) || []).length, 3);
  assert.match(ci, /import\{validatePack\}from'.\/scripts\/release-artifact.mjs'/);
  assert.doesNotMatch(ci, /const\[\{files\}\]|npm ci\s*\r?\n/);
  assert.match(ci, /npm run test:release/);
});

test("release toolchain accepts only the exact qualified Node version", () => {
  assert.equal(RELEASE_NODE_VERSION, "24.20.0");
  assert.doesNotThrow(() => assertReleaseToolchain(RELEASE_NODE_VERSION));
  for (const version of ["22.23.2", "24.19.0", "24.20.1", "25.0.0", "v24.20.0", "24.20.0-rc.1", "24.20.0+custom", " 24.20.0", null]) {
    assert.throws(() => assertReleaseToolchain(version), { code: "ERR_RELEASE_TOOLCHAIN" });
  }
});

test("all release I/O APIs refuse Node 22 before filesystem, process or network operations", () => {
  const code = `
    import assert from 'node:assert/strict';
    Object.defineProperty(process.versions, 'node', { value: '22.23.2' });
    const gate = await import(${JSON.stringify(new URL("../scripts/release-gate.mjs", import.meta.url).href)});
    const artifact = await import(${JSON.stringify(new URL("../scripts/release-artifact.mjs", import.meta.url).href)});
    const graph = await import(${JSON.stringify(new URL("../scripts/release-graph.mjs", import.meta.url).href)});
    const toolchain = await import(${JSON.stringify(new URL("../scripts/release-toolchain.mjs", import.meta.url).href)});
    assert.equal(gate.PACKAGE_NAME, 'ftp-deploy-mcp');
    assert.equal(artifact.PACKAGE_FILES.length, 83);
    assert.equal(artifact.integrity(Buffer.from('pure metadata')).startsWith('sha512-'), true);
    let contacted = false;
    const fetchImpl = async () => { contacted = true; throw new Error('network must not run'); };
    const operations = [
      () => gate.checkoutCommit('/absent'), () => gate.validateCheckout('/absent', {}, ''),
      () => gate.readRelease('/absent'), () => artifact.readBoundedFile('/absent', 1),
      () => artifact.captureSourceInventory('/absent', {}), () => artifact.approvedSource({}),
      () => artifact.inspectArtifact('/absent', {}), () => artifact.checkArtifact({}, {}),
      () => artifact.buildSourceArtifact('/absent', {}),
      () => artifact.downloadRegistryArchive('invalid', { fetchImpl }),
      () => artifact.fetchNpmArtifact('/absent', {}, { fetchImpl }),
      () => artifact.verifyPublished({}, undefined, { fetchImpl }),
      () => graph.compareInstalledGraph({}), () => graph.verifyInstalledGraph({}),
      () => toolchain.releaseToolchainVersions(),
    ];
    for (const operation of operations) await assert.rejects(async () => operation(), { code: 'ERR_RELEASE_TOOLCHAIN' });
    assert.equal(contacted, false);
    console.log('15 guarded APIs rejected; pure imports work under Node 22');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /15 guarded APIs rejected/);
});

test("release CLIs and all four complete test modules reject unqualified Node before fixtures", () => {
  const preload = "data:text/javascript," + encodeURIComponent("Object.defineProperty(process.versions, 'node', { value: '22.23.2' });");
  for (const file of ["scripts/release-toolchain.mjs", "scripts/release-gate.mjs", "scripts/release-artifact.mjs", "scripts/release-graph.mjs", "test/release-gates.js", "test/release-artifact.js", "test/release-npm-pack.js", "test/release-graph.js"]) {
    const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../" + file, import.meta.url))], { encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.error, undefined, file);
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /ERR_RELEASE_TOOLCHAIN/, file);
    assert.doesNotMatch(result.stderr, /ENOENT|EACCES|ETIMEDOUT/, file);
  }
});

test("release toolchain records the actual Node, libuv, bundled npm and tar versions", () => {
  const versions = releaseToolchainVersions();
  assert.equal(versions.node, RELEASE_NODE_VERSION);
  assert.equal(versions.libuv, process.versions.uv);
  assert.equal(versions.platform, process.platform);
  assert.equal(versions.arch, process.arch);
  assert.match(versions.npm, /^\d+\.\d+\.\d+$/);
  assert.match(versions.tar, /tar/i);
});

test("CI separates six runtime jobs from exact-toolchain release jobs with three fixed macOS passes", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const runtime = ci.split(/^  test:\s*$/m)[1].split(/^  release:\s*$/m)[0];
  const qualification = ci.split(/^  release:\s*$/m)[1].split(/^  supply-chain:\s*$/m)[0];
  assert.match(runtime, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(runtime, /node: \[22, 24\]/);
  assert.doesNotMatch(runtime, /test:release|release-toolchain/);
  assert.match(qualification, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(qualification, /node-version: '24\.20\.0'/);
  assert.match(qualification, /timeout-minutes: 10/);
  assert.equal((qualification.match(/npm run test:release/g) ?? []).length, 3);
  assert.equal((qualification.match(/if: \$\{\{ !cancelled\(\) && runner.os == 'macOS' \}\}/g) ?? []).length, 2);
  assert.doesNotMatch(qualification, /continue-on-error|--test-name-pattern|--test-skip-pattern|\|\|\s*true|retry/);
  assert.equal((qualification.match(/shell: bash/g) ?? []).length, 4, "Explicit bash preserves pipefail for every tee pipeline");
  assert.match(qualification, /release-toolchain\.json/);
  assert.match(qualification, /release-tests-\*\.tap/);
  const supply = ci.split(/^  supply-chain:\s*$/m)[1];
  assert.match(supply, /node-version: '24\.20\.0'/);
  assert.match(supply, /node scripts\/release-toolchain\.mjs/);
  for (const file of ["release.yml", "publish-mcp.yml"]) {
    const workflow = readFileSync(new URL("../.github/workflows/" + file, import.meta.url), "utf8");
    assert.equal((workflow.match(/node-version: '24\.20\.0'/g) ?? []).length, 2);
    assert.equal((workflow.match(/node scripts\/release-toolchain\.mjs/g) ?? []).length, 1);
    const [qualified, privileged] = workflow.split(/^  publish:\s*$/m);
    assert.ok(qualified.indexOf("release-artifact.mjs snapshot") < qualified.indexOf("node scripts/release-toolchain.mjs"));
    assert.ok(qualified.indexOf("node scripts/release-toolchain.mjs") < qualified.indexOf("npm ci --ignore-scripts"));
    assert.doesNotMatch(privileged, /release-toolchain\.mjs/);
  }
});

const registryURL = "https://registry.npmjs.org/ftp-deploy-mcp/-/ftp-deploy-mcp-0.2.1.tgz";
function downloadFixture(chunks = [Buffer.from("archive")], { status = 200, url = registryURL, length } = {}) {
  let canceled = 0, released = 0;
  const response = { status, url, headers: { get: () => length ?? null }, body: {
    cancel: async () => { canceled += 1; },
    getReader: () => ({ read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true },
      cancel: async () => { canceled += 1; }, releaseLock: () => { released += 1; } }),
  } };
  return { fetchImpl: async (_url, options) => { assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal); return response; },
    counts: () => ({ canceled, released }) };
}
test("registry downloads retain the original bytes and release their reader", async () => {
  const f = downloadFixture([Buffer.from("one"), Buffer.from("two")]);
  assert.equal((await downloadRegistryArchive(registryURL, f)).toString(), "onetwo");
  assert.deepEqual(f.counts(), { canceled: 1, released: 1 });
});
test("registry downloads reject redirects, unsafe URLs and oversized declarations before reading", async () => {
  for (const url of [registryURL.replace("https:", "http:"), registryURL + "?x=1", registryURL.replace("registry.npmjs.org", "example.com"), registryURL.replace(".tgz", "-source.tar.gz")]) {
    await assert.rejects(downloadRegistryArchive(url, { fetchImpl: async () => assert.fail("No unsafe fetch") }), /fixed official/);
  }
  for (const settings of [{ status: 302 }, { url: "https://example.com/archive" }, { length: String(MAX_ARCHIVE_BYTES + 1) }, { length: "-1" }]) {
    const f = downloadFixture([], settings); await assert.rejects(downloadRegistryArchive(registryURL, f));
    assert.deepEqual(f.counts(), { canceled: 1, released: 0 });
  }
});
test("registry streaming byte cap and total deadline reject with reader cleanup", async () => {
  const f = downloadFixture([Buffer.alloc(MAX_ARCHIVE_BYTES), Buffer.from("x")]);
  await assert.rejects(downloadRegistryArchive(registryURL, f), /compressed byte bound/);
  assert.deepEqual(f.counts(), { canceled: 1, released: 1 });
  const timed = downloadFixture(); let calls = 0;
  await assert.rejects(downloadRegistryArchive(registryURL, { ...timed, checkpoint: () => { if (++calls > 3) throw new Error("deadline"); return 1000; } }), /deadline/);
  assert.deepEqual(timed.counts(), { canceled: 1, released: 1 });
});
