import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createDeploymentPlan } from "../../src/durable/plan.js";
import { readDeploymentStatus } from "../../src/durable/status.js";
import { localRootHash, normalizeCanonicalLocalPath, openDurableState, pinCanonicalLocalRoot,
  projectDurableError, revalidateCanonicalLocalRoot, sameLocalRootHash } from "../../src/durable/state.js";
import { seal, validateStateLimits } from "../../src/state/codec.mjs";
import { fakeAdapter, fixture, operation, write } from "./helpers.mjs";

async function stateBytes(root) {
  const chunks = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else chunks.push(await fs.readFile(absolute));
    }
  }
  await visit(root);
  return Buffer.concat(chunks).toString("utf8");
}

test("published state and public projections contain no local absolute path or credential material", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "unique-source/file.txt", "new");
  const hooks = [];
  const built = await createDeploymentPlan({ loaded: f.loaded, input: { local_dir: "unique-source" },
    adapter: fakeAdapter(f.server, { "unique-source/file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1,
    fault(stage, detail) { hooks.push({ stage, detail }); } });
  const status = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: built.output.plan_id }, operation: operation(), now: 1 });
  let privateFailure;
  try { pinCanonicalLocalRoot(path.join(f.root, "missing-private-root"), { serverAlias: "prod" }); }
  catch (error) { privateFailure = projectDurableError(error); }
  const captured = `${await stateBytes(f.stateDir)}\n${JSON.stringify(built.output)}\n${JSON.stringify(status)}\n${JSON.stringify(hooks)}\n${JSON.stringify(privateFailure)}`;
  for (const forbidden of [f.localRoot, path.dirname(f.localRoot), "credential-secret", "passphrase-secret", "private-key-secret"]) {
    assert.equal(captured.includes(forbidden), false, forbidden);
    assert.equal(captured.includes(forbidden.replaceAll("\\", "/")), false, forbidden);
  }
  assert.equal(built.plan.target.localRoot, undefined);
  assert.match(built.plan.source.localRootHash, /^[a-f0-9]{64}$/);
  assert.equal(built.plan.files[0].localPath, "unique-source/file.txt");
});

test("state-directory relocation preserves a sealed v2 plan and read-only status", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new");
  const built = await createDeploymentPlan({ loaded: f.loaded, input: { local_dir: "." },
    adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1 });
  const moved = path.join(f.root, "moved-state");
  await fs.rename(f.stateDir, moved);
  f.loaded.config.stateDir = moved;
  const status = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: built.output.plan_id }, operation: operation(), now: 1 });
  assert.equal(status.plan_id, built.output.plan_id);
  assert.equal(status.phase, "planned");
});

test("local-root hash binds domain, platform and canonical material with constant-time equality", async (t) => {
  const f = await fixture(t);
  const pin = pinCanonicalLocalRoot(f.localRoot, { serverAlias: "prod" });
  const args = { domainId: f.domainId, canonicalPath: pin.canonicalPath, stateLimits: f.stateLimits };
  const baseline = localRootHash(args);
  assert.equal(sameLocalRootHash(baseline, localRootHash(args)), true);
  assert.equal(sameLocalRootHash(baseline, localRootHash({ ...args, domainId: "12345678-1234-4234-8234-123456789abc" })), false);
  assert.equal(sameLocalRootHash(baseline, localRootHash({ ...args, platform: "privacy-test-platform" })), false);
  assert.equal(sameLocalRootHash(baseline, "0".repeat(64)), false);
  assert.equal(sameLocalRootHash(baseline, "malformed"), false);
});

test("Windows canonical path variants collapse only the approved prefix and drive spelling", () => {
  assert.equal(normalizeCanonicalLocalPath("\\\\?\\C:\\Users\\Alice\\Source", "win32"), "C:/Users/Alice/Source");
  assert.equal(normalizeCanonicalLocalPath("c:\\Users\\Alice\\Source", "win32"), "C:/Users/Alice/Source");
  assert.equal(normalizeCanonicalLocalPath("\\\\?\\UNC\\server\\share\\Source", "win32"), "//server/share/Source");
  assert.notEqual(normalizeCanonicalLocalPath("C:\\Users\\Alice\\Source", "win32"),
    normalizeCanonicalLocalPath("C:\\Users\\alice\\Source", "win32"));
});

test("a pinned local directory refuses path replacement and junction retargeting", async (t) => {
  const f = await fixture(t);
  const pin = pinCanonicalLocalRoot(f.localRoot, { serverAlias: "prod" });
  const moved = path.join(f.root, "moved-local");
  await fs.rename(f.localRoot, moved);
  await fs.mkdir(f.localRoot);
  assert.throws(() => revalidateCanonicalLocalRoot(pin, { serverAlias: "prod", relativePath: "file.txt" }),
    { code: "PLAN_STALE" });
  await fs.rm(f.localRoot, { recursive: true });
  try { await fs.symlink(moved, f.localRoot, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  assert.throws(() => revalidateCanonicalLocalRoot(pin, { serverAlias: "prod", relativePath: "file.txt" }),
    { code: "PLAN_STALE" });
});

test("v1 domain marker is rejected before any persisted plan is scanned", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.stateDir);
  for (const name of ["plans", "claims", "operations", "locks"]) await fs.mkdir(path.join(f.stateDir, name));
  const domain = seal({ v: 1, domainId: f.domainId }, validateStateLimits(f.stateLimits));
  await fs.writeFile(path.join(f.stateDir, "domain.json"), domain);
  await fs.writeFile(path.join(f.stateDir, "plans", "must-not-decode"), Buffer.from("absolute-local-root-marker"));
  await assert.rejects(openDurableState({ loaded: f.loaded, create: false }),
    (error) => error.code === "DURABLE_STATE_UNSUPPORTED" && /reinitialize.*offline/i.test(error.message));
});
