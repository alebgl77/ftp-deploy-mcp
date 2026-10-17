import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildDeploymentPlan, publishDeploymentPlan } from "../../src/durable/plan.js";
import { STATUS_STRUCTURED_BUDGET, readDeploymentStatus, statusFromStore } from "../../src/durable/status.js";
import { asDurableFailure, openDurableState } from "../../src/durable/state.js";
import { StateError } from "../../src/state/index.mjs";
import { encode } from "../../src/state/codec.mjs";
import { encodePlan } from "../../src/workflow/model.mjs";
import { fakeAdapter, fixture, operation, sha256, write } from "./helpers.mjs";

const PLAN_ID = "pln_12345678-1234-4234-8234-123456789abc";
const token = "1".repeat(32);
const event = (type, fields = {}) => ({ v: 1, scope: "apply", type, ...fields });

async function chmodTree(root, directoryMode, fileMode) {
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await chmodTree(target, directoryMode, fileMode);
    else await fs.chmod(target, fileMode);
  }
  await fs.chmod(root, directoryMode);
}

async function plannedFixture(t) {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new");
  const state = await openDurableState({ loaded: f.loaded, signal: operation().signal, create: true });
  t.after(() => state.close());
  const options = { loaded: f.loaded, input: { local_dir: "." },
    adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1000, planId: PLAN_ID };
  const built = await publishDeploymentPlan({ ...options, store: state.store });
  return { f, state, built, options };
}

test("immutable publication round-trips and duplicate plan IDs fail without clobbering", async (t) => {
  const { state, built, options } = await plannedFixture(t);
  assert.deepEqual(await state.store.readPlan(PLAN_ID), built.bytes);
  await assert.rejects(publishDeploymentPlan({ ...options, store: state.store }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(await state.store.readPlan(PLAN_ID), built.bytes);
});

test("status projects planned and replayed operation state with stable counts and stale-sequence refusal", async (t) => {
  const { state, built } = await plannedFixture(t);
  const planned = await statusFromStore({ store: state.store, durable: state.durable,
    input: { plan_id: PLAN_ID }, now: 1000 });
  assert.equal(planned.phase, "planned");
  assert.equal(planned.operation_id, null);
  assert.equal(planned.journal_seq, 0);
  assert.deepEqual(planned.counts, { total: 1, pending: 1, skipped: 0, applied: 0, satisfied_unowned: 0, rolled_back: 0, backup_ready: 0 });

  const claim = await state.store.claim({ planId: PLAN_ID, keyHash: sha256("idempotency-key-0001"), targetHash: built.targetHash,
    reservation: built.reservation, initialEvent: event("INIT", { planDigest: built.output.plan_digest, fileCount: 1 }), ...built.policy });
  const applying = await statusFromStore({ store: state.store, durable: state.durable,
    input: { operation_id: claim.operationId }, now: 1000 });
  assert.equal(applying.phase, "applying");
  assert.equal(applying.journal_seq, 1);
  await assert.rejects(statusFromStore({ store: state.store, durable: state.durable,
    input: { operation_id: claim.operationId, if_journal_seq: 0 }, now: 1000 }), { code: "STATUS_CHANGED" });

  const writer = await state.store.openJournal(claim.operationId, built.policy);
  await writer.append(event("BACKUP_INTENT", { i: 0 }), { budget: "apply" });
  await writer.append(event("BACKUP_READY", { i: 0 }), { budget: "apply" });
  await writer.append(event("STAGE_INTENT", { i: 0, a: 1, token }), { budget: "apply" });
  await writer.append(event("STAGED", { i: 0, a: 1, mode: 0o644 }), { budget: "apply" });
  await writer.append(event("PROMOTING", { i: 0, a: 1 }), { budget: "apply" });
  const uncertain = await statusFromStore({ store: state.store, durable: state.durable,
    input: { operation_id: claim.operationId }, now: 1000 });
  assert.equal(uncertain.needs_reconciliation, true);
  assert.equal(uncertain.files[0].uncertain, true);
  await writer.append(event("APPLIED", { i: 0, a: 1 }), { budget: "apply" });
  await writer.append(event("APPLY_COMPLETE"), { budget: "apply" });

  const completed = await statusFromStore({ store: state.store, durable: state.durable,
    input: { operation_id: claim.operationId, if_journal_seq: 8 }, now: built.plan.expiresAt });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.complete, true);
  assert.equal(completed.expired, true);
  assert.equal(completed.needs_reconciliation, false);
  assert.deepEqual(completed.counts, { total: 1, pending: 0, skipped: 0, applied: 1, satisfied_unowned: 0, rolled_back: 0, backup_ready: 1 });
  assert.equal(completed.apply_bytes_charged, 3);
  assert.equal(completed.files[0].apply_attempts, 1);
});

test("status pagination is index-stable and byte-fitted to 18 KiB", async (t) => {
  const f = await fixture(t);
  const state = await openDurableState({ loaded: f.loaded, create: true });
  t.after(() => state.close());
  const long = "x".repeat(700);
  const plan = { v: 2, createdAt: 1, expiresAt: 600001, serverAlias: "prod",
    source: { localRootHash: "b".repeat(64) }, policyHash: "a".repeat(64), securityWarning: null,
    target: { protocol: "sftp", host: "example.test", port: 22, user: "Deploy", root: "/root",
      canonicalRoot: "/canonical" },
    files: Array.from({ length: 30 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return { index, localPath: `${long}-${suffix}`, remotePath: `${long}-${suffix}`, bytes: 0,
        sha256: sha256(""), before: { kind: "absent" }, parent: "/canonical", desiredMode: 0o644 };
    }) };
  const limits = { stateLimits: state.durable.stateLimits, maxTransferBytes: 1099511627776, maxDeployBytes: 1099511627776, maxDeployFiles: 100000 };
  await state.store.publishPlan(PLAN_ID, encodePlan(plan, limits));
  const first = await statusFromStore({ store: state.store, durable: state.durable, input: { plan_id: PLAN_ID, limit: 100 }, now: 1 });
  assert.ok(first.page.count > 0 && first.page.count < 30);
  assert.equal(first.page.next_offset, first.page.count);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= STATUS_STRUCTURED_BUDGET);
  assert.deepEqual(first.files.map((row) => row.index), Array.from({ length: first.page.count }, (_, index) => index));
  const second = await statusFromStore({ store: state.store, durable: state.durable,
    input: { plan_id: PLAN_ID, offset: first.page.next_offset, limit: 100 }, now: 1 });
  assert.equal(second.files[0].index, first.page.count);
  assert.equal(second.page.next_offset, second.page.offset + second.page.count < 30 ? second.page.offset + second.page.count : null);
});

test("status is create:false, performs no network work and maps missing/corrupt/limit failures", async (t) => {
  const f = await fixture(t);
  let network = 0;
  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { plan_id: PLAN_ID },
    openAdapter: () => { network++; } }), { code: "PLAN_NOT_FOUND" });
  assert.equal(network, 0);
  await assert.rejects(fs.stat(f.stateDir), { code: "ENOENT" });

  const state = await openDurableState({ loaded: f.loaded, create: true });
  t.after(() => state.close());
  await assert.rejects(statusFromStore({ store: state.store, durable: state.durable, input: { plan_id: PLAN_ID } }), { code: "PLAN_NOT_FOUND" });
  assert.equal(asDurableFailure(new StateError("STATE_LIMIT", "test")).code, "DURABLE_STATE_LIMIT");
  assert.equal(asDurableFailure(new StateError("STATE_CORRUPT", "test")).code, "DURABLE_STATE_CORRUPT");
});

test("status maps corrupt and oversized persisted plan records without projecting partial data", async (t) => {
  const corrupt = await plannedFixture(t);
  const corruptFile = path.join(corrupt.f.stateDir, "plans", `${PLAN_ID}.json`);
  await fs.writeFile(corruptFile, "{}\n");
  await assert.rejects(statusFromStore({ store: corrupt.state.store, durable: corrupt.state.durable,
    input: { plan_id: PLAN_ID } }), { code: "DURABLE_STATE_CORRUPT" });

  const oversized = await plannedFixture(t);
  const oversizedFile = path.join(oversized.f.stateDir, "plans", `${PLAN_ID}.json`);
  await fs.writeFile(oversizedFile, Buffer.alloc(oversized.state.durable.stateLimits.maxPlanBytes + 1, 0x78));
  await assert.rejects(statusFromStore({ store: oversized.state.store, durable: oversized.state.durable,
    input: { plan_id: PLAN_ID } }), { code: "DURABLE_STATE_LIMIT" });
});

test("high-level status uses a lock-free read-only snapshot and leaves no admission lock", async (t) => {
  const { f } = await plannedFixture(t);
  const hooks = [];
  const forbidden = /(?:^lock_(?:open|write|sync|close|remove)_|_(?:write|sync|publish|unlink_temp)_(?:before|after)$|^directory_create_)/;
  const result = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: PLAN_ID }, fault(stage) {
    hooks.push(stage);
    if (forbidden.test(stage)) throw new Error(`write hook reached: ${stage}`);
  } });
  assert.equal(result.phase, "planned");
  assert.ok(hooks.some((stage) => stage.startsWith("snapshot_plan_")));
  assert.equal(hooks.some((stage) => forbidden.test(stage)), false);
  await assert.rejects(fs.stat(path.join(f.stateDir, "locks", "admission.lock")), { code: "ENOENT" });
});

test("read-only status works on a readable non-writable state tree where supported", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission semantics required");
  const { f, state } = await plannedFixture(t);
  await state.close();
  await chmodTree(f.stateDir, 0o500, 0o400);
  t.after(() => chmodTree(f.stateDir, 0o700, 0o600));
  const result = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: PLAN_ID } });
  assert.equal(result.phase, "planned");
});

test("plan replacement during a read-only snapshot fails busy without a mixed projection", async (t) => {
  const { f } = await plannedFixture(t);
  const planFile = path.join(f.stateDir, "plans", `${PLAN_ID}.json`);
  const original = await fs.readFile(planFile);
  let changed = false;
  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { plan_id: PLAN_ID }, fault: async (stage) => {
    if (stage !== "snapshot_plan_after" || changed) return;
    changed = true;
    await fs.writeFile(planFile, original);
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(planFile, future, future);
  } }), { code: "DURABLE_STATE_BUSY" });
  assert.equal(changed, true);
});

test("concurrent journal/head append fails busy and never returns mixed counts", async (t) => {
  const { f, state, built } = await plannedFixture(t);
  const claim = await state.store.claim({ planId: PLAN_ID, keyHash: sha256("idempotency-key-concurrent"), targetHash: built.targetHash,
    reservation: built.reservation, initialEvent: event("INIT", { planDigest: built.output.plan_digest, fileCount: 1 }), ...built.policy });
  const writer = await state.store.openJournal(claim.operationId, built.policy);
  let appended = false;
  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { operation_id: claim.operationId }, fault: async (stage) => {
    if (stage !== "journal_replay_after" || appended) return;
    appended = true;
    await writer.append(event("BACKUP_INTENT", { i: 0 }), { budget: "apply" });
  } }), { code: "DURABLE_STATE_BUSY" });
  assert.equal(appended, true);
  const stable = await readDeploymentStatus({ loaded: f.loaded, input: { operation_id: claim.operationId } });
  assert.equal(stable.journal_seq, 2);
  assert.equal(stable.files[0].backup, "intent");
});

test("post-scan journal append paused before head publication is busy, then projects the stable head", async (t) => {
  const { f, state, built } = await plannedFixture(t);
  const claim = await state.store.claim({ planId: PLAN_ID, keyHash: sha256("idempotency-key-head-window"), targetHash: built.targetHash,
    reservation: built.reservation, initialEvent: event("INIT", { planDigest: built.output.plan_digest, fileCount: 1 }), ...built.policy });
  await state.close();

  let releaseHead;
  const blockedHead = new Promise((resolve) => { releaseHead = resolve; });
  let reachedHead;
  const atHead = new Promise((resolve) => { reachedHead = resolve; });
  const writerState = await openDurableState({ loaded: f.loaded, signal: operation().signal, create: false, fault: async (stage) => {
    if (stage !== "head_write_before") return;
    reachedHead();
    await blockedHead;
  } });
  t.after(async () => { releaseHead(); await writerState.close(); });
  const writer = await writerState.store.openJournal(claim.operationId, built.policy);
  let append;
  let started = false;
  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { operation_id: claim.operationId }, fault: async (stage) => {
    if (stage !== "status_scan_a_after" || started) return;
    started = true;
    append = writer.append(event("BACKUP_INTENT", { i: 0 }), { budget: "apply" });
    await atHead;
  } }), { code: "DURABLE_STATE_BUSY" });
  assert.equal(started, true);
  releaseHead();
  await append;

  const stable = await readDeploymentStatus({ loaded: f.loaded, input: { operation_id: claim.operationId } });
  assert.equal(stable.journal_seq, 2);
  assert.equal(stable.files[0].backup, "intent");
});

test("stable journal/head mismatch remains corrupt after the confirming scan", async (t) => {
  const { f, state, built } = await plannedFixture(t);
  const claim = await state.store.claim({ planId: PLAN_ID, keyHash: sha256("idempotency-key-stable-head"), targetHash: built.targetHash,
    reservation: built.reservation, initialEvent: event("INIT", { planDigest: built.output.plan_digest, fileCount: 1 }), ...built.policy });
  await state.close();
  const headFile = path.join(f.stateDir, "operations", claim.operationId, "head.json");
  const head = JSON.parse(await fs.readFile(headFile, "utf8"));
  head.hash = `${head.hash[0] === "a" ? "b" : "a"}${head.hash.slice(1)}`;
  await fs.writeFile(headFile, encode(head, state.durable.stateLimits));

  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { operation_id: claim.operationId } }),
    { code: "DURABLE_STATE_CORRUPT" });
});
