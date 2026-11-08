import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEVELOPMENT_OVERRIDES, validateDependencies } from "../scripts/release-gate.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const fixture = () => ({
  pkg: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
  lock: JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")),
});
const entry = (lock, name) => Object.values(lock.packages).find((record) => record.resolved?.includes(`/${name}/-/`));

test("development override policy accepts the reviewed patched optional toolchain", () => {
  const { pkg, lock } = fixture();
  assert.deepEqual(pkg.overrides, DEVELOPMENT_OVERRIDES);
  validateDependencies(pkg, lock);
});

for (const [label, mutate] of [
  ["missing override", ({ pkg }) => { delete pkg.overrides; }],
  ["global override", ({ pkg }) => { pkg.overrides = { glob: "14.0.2" }; }],
  ["unreviewed parent", ({ pkg }) => { pkg.overrides = { "cacache@20": { glob: "14.0.2" } }; }],
  ["unreviewed version", ({ pkg }) => { pkg.overrides["cacache@19.0.1"].glob = "*"; }],
  ["additional override", ({ pkg }) => { pkg.overrides.zod = "*"; }],
  ["lock root override", ({ lock }) => { lock.packages[""].overrides = DEVELOPMENT_OVERRIDES; }],
  ["vulnerable minimatch", ({ lock }) => { entry(lock, "minimatch").version = "9.0.9"; }],
  ["vulnerable glob", ({ lock }) => { entry(lock, "glob").version = "14.0.1"; }],
  ["production dependency flag", ({ lock }) => { delete entry(lock, "glob").dev; }],
  ["nonoptional tooling", ({ lock }) => { delete entry(lock, "cacache").optional; }],
  ["hidden production reference", ({ lock }) => { lock.packages["node_modules/basic-ftp"].dependencies = { glob: "14.0.2" }; }],
  ["stale override", ({ lock }) => { entry(lock, "cacache").version = "20.0.0"; }],
]) {
  test(`development override policy rejects ${label}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => validateDependencies(data.pkg, data.lock));
  });
}

test("patched glob preserves cacache verification and cleanup used by the XML build toolchain", async () => {
  const cacheRequire = createRequire(require.resolve("cacache/package.json"));
  assert.equal(cacheRequire("glob/package.json").version, "14.0.2");
  const cacache = require("cacache");
  const directory = await mkdtemp(path.join(tmpdir(), "ftp-mcp-sbom-cache-"));
  try {
    await cacache.put(directory, "artifact", "verified build artifact");
    assert.equal((await cacache.get(directory, "artifact")).data.toString(), "verified build artifact");
    const result = await cacache.verify(directory);
    assert.equal(result.verifiedContent, 1);
    assert.equal(result.badContentCount, 0);
    await cacache.rm.all(directory);
    assert.deepEqual(await cacache.ls(directory), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
