import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareInstalledGraph } from "../scripts/release-graph.mjs";
import { integrity } from "../scripts/release-artifact.mjs";

const writeJSON = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2)); };
const record = (name, version, fields = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: integrity(Buffer.from(`${name}@${version}`)), ...fields });
function fixture(t, { npm = false, optional = false, development = false } = {}) {
  const installRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ftp-graph-test-")));
  t.after(() => rmSync(installRoot, { recursive: true, force: true }));
  const productRoot = npm ? path.join(installRoot, "node_modules/ftp-deploy-mcp") : installRoot;
  const pkg = { name: "ftp-deploy-mcp", version: "0.2.1", dependencies: { a: "1.0.0" } };
  const lock = { lockfileVersion: 3, packages: { "": { ...pkg },
    "node_modules/a": record("a", "1.0.0", { dependencies: { b: "^2" }, peerDependencies: { peer: "^3" }, optionalDependencies: { optional: "^4" } }),
    "node_modules/a/node_modules/b": record("b", "2.0.0"),
    "node_modules/peer": record("peer", "3.0.0", { dependencies: { a: "^1" } }),
    "node_modules/optional": record("optional", "4.0.0", { optional: true, os: ["linux"] }),
  } };
  if (development) lock.packages["node_modules/dev-only"] = record("dev-only", "5.0.0", { dev: true });
  const installed = { lockfileVersion: 3, packages: { "": npm ? { name: "wrapper" } : { ...pkg } } };
  writeJSON(path.join(productRoot, "package.json"), pkg);
  if (npm) installed.packages["node_modules/ftp-deploy-mcp"] = { ...pkg };
  function add(name, expectedKey) {
    const entry = lock.packages[expectedKey];
    const fields = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"].filter((key) => entry[key]).map((key) => [key, entry[key]]));
    writeJSON(path.join(installRoot, "node_modules", name, "package.json"), { name, version: entry.version, ...fields });
    installed.packages[`node_modules/${name}`] = { ...entry };
  }
  add("a", "node_modules/a"); add("b", "node_modules/a/node_modules/b"); add("peer", "node_modules/peer");
  if (optional) add("optional", "node_modules/optional");
  if (development) add("dev-only", "node_modules/dev-only");
  const saveLock = () => {
    writeJSON(path.join(installRoot, "package-lock.json"), installed);
    writeJSON(path.join(installRoot, "node_modules/.package-lock.json"), installed);
  };
  saveLock();
  const manifestPath = (name) => path.join(installRoot, "node_modules", name, "package.json");
  const mutate = (name, fn) => { const file = manifestPath(name); const value = JSON.parse(readFileSync(file)); fn(value); writeJSON(file, value); };
  return { pkg, lock, productRoot, installRoot, installed, saveLock, mutate, check: () => compareInstalledGraph({ pkg, lock, productRoot, installRoot }) };
}

for (const npm of [false, true]) test(`exact production graph supports ${npm ? "npm wrapper with hoisting" : "extracted source without Git"}`, (t) => {
  const f = fixture(t, { npm }); const report = f.check();
  assert.equal(report.status, "PASS"); assert.equal(report.productionPackages, 3);
  assert.deepEqual(report.differences, []);
  assert.equal(report.declaredOmissions[0].name, "optional");
  assert.equal(report.declaredOmissions[0].kind, "optionalDependency");
});
test("transitive installed versions and integrity cannot replace the original source lock", (t) => {
  const f = fixture(t); const original = JSON.stringify(f.lock);
  f.mutate("b", (pkg) => { pkg.version = "2.1.0"; });
  Object.assign(f.installed.packages["node_modules/b"], { version: "2.1.0", integrity: integrity(Buffer.from("drift")) }); f.saveLock();
  const report = f.check(); assert.equal(report.status, "FAIL");
  assert.ok(report.differences.some((row) => row.code === "INSTALLED_MANIFEST_DRIFT" && row.name === "b"));
  assert.ok(report.differences.some((row) => row.code === "INSTALLED_LOCK_DRIFT" && row.field === "integrity"));
  assert.equal(JSON.stringify(f.lock), original);
});
test("unchanged manifests do not excuse installed lock resolution or integrity drift", (t) => {
  const f = fixture(t); f.installed.packages["node_modules/b"].resolved = "https://registry.npmjs.org/b/-/b-other.tgz"; f.saveLock();
  const report = f.check(); assert.equal(report.status, "FAIL");
  assert.ok(report.differences.some((row) => row.field === "resolved" && row.name === "b"));
});
test("the hidden installation lock is checked when present", (t) => {
  const f = fixture(t); const hidden = structuredClone(f.installed); hidden.packages["node_modules/b"].integrity = integrity(Buffer.from("hidden drift"));
  writeJSON(path.join(f.installRoot, "node_modules/.package-lock.json"), hidden);
  assert.ok(f.check().differences.some((row) => row.lock === "hidden-lock" && row.field === "integrity"));
});
for (const name of ["b", "peer"]) test(`a missing required ${name === "peer" ? "peer" : "transitive dependency"} fails`, (t) => {
  const f = fixture(t); rmSync(path.join(f.installRoot, "node_modules", name), { recursive: true, force: true });
  assert.ok(f.check().differences.some((row) => row.code === "REQUIRED_DEPENDENCY_MISSING" && row.name === name));
});
test("present optional dependencies with drift are rejected, never treated as omitted", (t) => {
  const f = fixture(t, { optional: true }); f.mutate("optional", (pkg) => { pkg.version = "4.1.0"; });
  const report = f.check(); assert.equal(report.status, "FAIL");
  assert.ok(report.differences.some((row) => row.name === "optional"));
  assert.ok(!report.declaredOmissions.some((row) => row.name === "optional"));
});
test("declared optional peers may be absent but required peers may not", (t) => {
  const f = fixture(t); f.lock.packages["node_modules/a"].peerDependenciesMeta = { peer: { optional: true } };
  f.mutate("a", (pkg) => { pkg.peerDependenciesMeta = { peer: { optional: true } }; });
  rmSync(path.join(f.installRoot, "node_modules/peer"), { recursive: true, force: true });
  const report = f.check(); assert.equal(report.status, "PASS");
  assert.ok(report.declaredOmissions.some((row) => row.name === "peer" && row.kind === "peer"));
});
test("only development packages proven by the source lock are excluded", (t) => {
  const f = fixture(t, { development: true }); assert.equal(f.check().ignoredDevelopment.length, 1);
  writeJSON(path.join(f.installRoot, "node_modules/extra/package.json"), { name: "extra", version: "1.0.0" });
  f.installed.packages["node_modules/extra"] = record("extra", "1.0.0", { dev: true }); f.saveLock();
  assert.ok(f.check().differences.some((row) => row.code === "EXTRA_INSTALLED_PACKAGE" && row.name === "extra"));
});
test("the npm wrapper cannot masquerade as the product root", (t) => {
  const f = fixture(t, { npm: true }); writeJSON(path.join(f.installRoot, "package.json"), { name: "wrapper", version: "1.0.0" });
  const report = compareInstalledGraph({ ...f, productRoot: f.installRoot });
  assert.equal(report.status, "FAIL"); assert.ok(report.differences.some((row) => row.code === "PRODUCT_MANIFEST_DRIFT"));
});
test("changed dependency declarations and missing installation records fail closed", (t) => {
  const f = fixture(t); f.mutate("a", (pkg) => { pkg.dependencies = { b: "^9" }; });
  delete f.installed.packages["node_modules/b"]; f.saveLock();
  const report = f.check(); assert.equal(report.status, "FAIL");
  assert.ok(report.differences.some((row) => row.code === "INSTALLED_DEPENDENCY_DECLARATION_DRIFT"));
  assert.ok(report.differences.some((row) => row.code === "INSTALLED_LOCK_RECORD_MISSING"));
});
for (const field of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) test(`root ${field} cannot be added outside the source authority`, (t) => {
  const f = fixture(t); const product = { ...f.pkg, [field]: { rogue: field === "peerDependenciesMeta" ? { optional: true } : "1.0.0" } };
  writeJSON(path.join(f.productRoot, "package.json"), product);
  assert.ok(f.check().differences.some((row) => row.code === "PRODUCT_MANIFEST_DRIFT" && row.field === field));
});
test("a source-development identity installed as production is still an extra package", (t) => {
  const f = fixture(t, { development: true }); delete f.installed.packages["node_modules/dev-only"].dev; f.saveLock();
  const report = f.check(); assert.equal(report.status, "FAIL"); assert.equal(report.ignoredDevelopment.length, 0);
  assert.ok(report.differences.some((row) => row.code === "EXTRA_INSTALLED_PACKAGE" && row.name === "dev-only"));
});
for (const field of ["dev", "version", "resolved", "integrity"]) test(`development exemption requires the hidden lock's original ${field}`, (t) => {
  const f = fixture(t, { development: true }); const hidden = structuredClone(f.installed);
  hidden.packages["node_modules/dev-only"][field] = field === "dev" ? false : "changed";
  writeJSON(path.join(f.installRoot, "node_modules/.package-lock.json"), hidden);
  const report = f.check(); assert.equal(report.status, "FAIL"); assert.equal(report.ignoredDevelopment.length, 0);
});
