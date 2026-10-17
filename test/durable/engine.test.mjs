import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { normalizeServer } from "../../src/config.js";
import { endpointLockHash, openDurableState, projectDurableError } from "../../src/durable/state.js";
import { applyDurableDeployment, planDurableDeployment, rollbackDurableDeployment } from "../../src/durable/engine.js";
import { readDeploymentStatus } from "../../src/durable/status.js";
import { registerTools, ALL_TOOL_NAMES } from "../../src/tools.js";
import { fixture, sha256, write } from "./helpers.mjs";

function operation(extra = {}) {
  const controller = new AbortController();
  let dispatched = false, confirmedEffect = false, shortenedTo = null, partial;
  return {
    id: randomUUID(), signal: controller.signal, requestState: extra.requestState,
    mintRequestState: extra.mintRequestState, acceptedInputResponse: extra.acceptedInputResponse,
    check() { if (controller.signal.aborted) throw controller.signal.reason; },
    step(run) { this.check(); return Promise.resolve().then(run).then((value) => { this.check(); return value; }); },
    lock(_keys, run) { return run(); }, progress() {},
    trackFiles(total) { partial = { completed_files: 0, completed_bytes: 0, failed_files: 0, total_files: total }; },
    confirmFile(bytes) { this.confirm(); if (partial) { partial.completed_files++; partial.completed_bytes += bytes; } },
    dispatch() { dispatched = true; }, confirm() { dispatched = true; confirmedEffect = true; }, observeMutation() {},
    shortenTimeout(value) { shortenedTo = value; },
    async promote(bytes, run) { this.dispatch(); const result = await run(); this.confirmFile(bytes); return result; },
    snapshot() { return { effects: confirmedEffect ? "confirmed" : dispatched ? "possible" : "none",
      ...(partial ? { partial: { ...partial } } : {}) }; },
    get shortenedTo() { return shortenedTo; },
  };
}

function memoryRemote(server, initial = {}) {
  const files = new Map(Object.entries(initial).map(([name, value]) => [path.posix.join(server.root, name), {
    data: Buffer.from(value.data), mode: value.mode ?? 0o644,
  }]));
  const calls = [];
  const canonicalRoot = server.protocol === "sftp" ? "/canonical" : server.root;
  const identify = (remote, entry) => ({ canonicalRoot, path: server.protocol === "sftp"
    ? path.posix.join(canonicalRoot, path.posix.relative(server.root, remote)) : remote,
  parent: server.protocol === "sftp"
    ? path.posix.dirname(path.posix.join(canonicalRoot, path.posix.relative(server.root, remote))) : path.posix.dirname(remote),
  bytes: entry.data.length, sha256: sha256(entry.data), ...(server.protocol === "sftp" ? { mode: entry.mode } : {}) });
  return {
    files, calls,
    async inspectFile(remote, { maxBytes }) {
      calls.push(["inspectFile", remote]);
      const entry = files.get(remote);
      const identity = entry ? identify(remote, entry) : identify(remote, { data: Buffer.alloc(0), mode: 0o644 });
      if (!entry) return { type: "absent", path: identity.path, parent: identity.parent, canonicalRoot };
      if (entry.data.length > maxBytes) throw new Error("limit");
      return { type: "file", ...identity, identity };
    },
    async uploadStream(readable, remote, expected, options) {
      calls.push(["uploadStream", remote]);
      if (files.has(remote)) throw new Error("exists");
      options.onCreating?.();
      const chunks = [];
      for await (const chunk of readable) chunks.push(Buffer.from(chunk));
      const entry = { data: Buffer.concat(chunks), mode: server.protocol === "sftp" ? 0o600 : null };
      files.set(remote, entry);
      options.onOwned?.(identify(remote, entry));
      assert.equal(entry.data.length, expected.bytes);
      return { mode: server.protocol === "sftp" ? 0o600 : undefined };
    },
    async downloadStream(remote, writable, _maxBytes) {
      calls.push(["downloadStream", remote]);
      const entry = files.get(remote);
      writable.end(entry.data);
      return { bytes: entry.data.length, sha256: sha256(entry.data) };
    },
    async rename(from, to, options) {
      calls.push(["rename", from, to]);
      const entry = files.get(from);
      if (!entry) throw new Error("missing");
      files.set(to, { data: Buffer.from(entry.data), mode: options.mode ?? entry.mode });
      files.delete(from);
    },
    async deleteFile(remote) { calls.push(["deleteFile", remote]); files.delete(remote); },
    async close() { calls.push(["close"]); },
  };
}

function confirmed(state, response) {
  return operation({ requestState: state, acceptedInputResponse: () => response });
}

async function persistedText(root) {
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

test("endpointLockHash has a canonical golden vector and is alias-only", async (t) => {
  const f = await fixture(t);
  assert.equal(endpointLockHash("prod", f.stateLimits), "044a9aea9b4e0c32cdcd3c79da37b09c602d18cd3cda60faa81ce7ee551281a2");
  assert.equal(endpointLockHash("prod", f.stateLimits), endpointLockHash("prod", { ...f.stateLimits, maxPlans: f.stateLimits.maxPlans + 1 }));
  assert.notEqual(endpointLockHash("prod", f.stateLimits), endpointLockHash("Prod", f.stateLimits));
  assert.doesNotMatch(JSON.stringify(endpointLockHash("prod", f.stateLimits)), /credential-secret|example\.test|\/root/);
});

test("four durable tools are discoverable only with durable state and retain the legacy ten", async (t) => {
  const f = await fixture(t);
  const enabled = registerTools(null, f.loaded).list().tools;
  assert.deepEqual(enabled.map((tool) => tool.name), ALL_TOOL_NAMES);
  assert.equal(enabled.length, 14);
  const disabled = structuredClone(f.loaded); disabled.config.stateDir = undefined;
  delete disabled.config.requirePlan; delete disabled.config.stateLimits;
  assert.equal(registerTools(null, disabled).list().tools.length, 10);
  const annotations = Object.fromEntries(enabled.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual(annotations.ftp_plan_deploy, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(annotations.ftp_apply_deploy, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(annotations.ftp_deploy_status, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(annotations.ftp_rollback_deploy, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
});

test("requirePlan blocks every legacy remote mutator before adapter construction but permits deploy dry-run", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "content");
  let opened = 0;
  const tools = registerTools(null, f.loaded, { openAdapter: async () => { opened++; throw new Error("must not connect"); } });
  const calls = [
    ["ftp_upload", { local_path: "file.txt", remote_path: "file.txt" }],
    ["ftp_deploy", { local_dir: ".", remote_dir: ".", dry_run: false }],
    ["ftp_mkdir", { path: "dir" }],
    ["ftp_rename", { from_path: "old", to_path: "new" }],
    ["ftp_delete", { path: "file.txt", recursive: false }],
  ];
  for (const [name, args] of calls) {
    const result = await tools.call(name, args, {});
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, "READ_ONLY", name);
  }
  const dryRun = await tools.call("ftp_deploy", { local_dir: ".", remote_dir: ".", dry_run: true }, {});
  assert.notEqual(dryRun.isError, true);
  assert.equal(opened, 0);
});

test("durable-enabled legacy local tools reject live state overlap before local or state access", async (t) => {
  const f = await fixture(t, { configOverrides: { requirePlan: false } });
  await write(f.localRoot, "file.txt", "content");
  const initialized = await openDurableState({ loaded: f.loaded, create: true });
  await initialized.close();
  const before = await persistedText(f.stateDir);
  await fs.rm(f.localRoot, { recursive: true });
  await fs.symlink(f.stateDir, f.localRoot, process.platform === "win32" ? "junction" : "dir");
  let opened = 0;
  const tools = registerTools(null, f.loaded, { openAdapter: async () => { opened++; throw new Error("must not connect"); } });
  const calls = [
    ["ftp_deploy", { local_dir: ".", remote_dir: ".", dry_run: true }],
    ["ftp_upload", { local_path: "domain.json", remote_path: "domain.json" }],
    ["ftp_download", { remote_path: "remote.txt", local_path: "download.txt" }],
  ];
  for (const [name, args] of calls) {
    const result = await tools.call(name, args, {});
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.effects, "none", name);
    const projected = JSON.stringify(result.structuredContent);
    for (const forbidden of [f.stateDir, "credential-secret", "passphrase-secret", "private-key-secret"]) {
      assert.equal(projected.includes(forbidden), false, `${name}:${forbidden}`);
    }
  }
  assert.equal(opened, 0);
  assert.equal(await persistedText(f.stateDir), before);
  for (const directory of ["plans", "claims", "operations", "locks"]) {
    assert.deepEqual(await fs.readdir(path.join(f.stateDir, directory)), [], directory);
  }
});

test("state-enabled legacy mutations serialize before constructing a second same-alias adapter", async (t) => {
  const f = await fixture(t, { configOverrides: { requirePlan: false } });
  let opened = 0, releaseFirst;
  const firstEntered = new Promise((resolve) => { releaseFirst = { resolve }; });
  let announceFirst;
  const announced = new Promise((resolve) => { announceFirst = resolve; });
  const tools = registerTools(null, f.loaded, { openAdapter: async () => {
    const ordinal = ++opened;
    return {
      async mkdirp() {
        if (ordinal === 1) { announceFirst(); await firstEntered; }
      },
      async close() {},
    };
  } });
  const first = tools.call("ftp_mkdir", { path: "one" }, {});
  const early = await Promise.race([
    announced.then(() => null),
    first.then((result) => result),
  ]);
  assert.equal(early, null, `first mutation settled before adapter work: ${JSON.stringify(early)}`);
  const second = tools.call("ftp_mkdir", { path: "two" }, {});
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
  releaseFirst.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.isError !== true));
  assert.equal(opened, 2);
});

test("plan, confirmed association, explicit resume, and rollback preserve journal ownership", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "source/file.txt", "new-content");
  const remote = memoryRemote(f.server, { "deploy/file.txt": { data: "old-content", mode: 0o640 } });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded,
    input: { local_dir: "source", remote_dir: "deploy", ttl_seconds: 600 }, operation: operation(), openAdapter });
  const key = "idempotency-key-0001";
  let minted;
  const challenge = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: operation({ mintRequestState: async (value) => { minted = value; return JSON.stringify(value); } }), openAdapter });
  assert.equal(challenge.resultType, "input_required");
  assert.equal(remote.calls.filter(([name]) => name !== "close").length, 1, "first apply challenge performs no additional network work");

  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const associated = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false }, operation: confirmed(minted, response), openAdapter });
  assert.equal(associated.outcome, "status_only");
  assert.equal(associated.phase, "applying");
  const persisted = await persistedText(f.stateDir);
  for (const forbidden of [key, f.localRoot, path.dirname(f.localRoot), "credential-secret", "passphrase-secret", "private-key-secret"]) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
    assert.equal(persisted.includes(forbidden.replaceAll("\\", "/")), false, forbidden);
  }

  let resumeState;
  const resumeChallenge = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { resumeState = value; return JSON.stringify(value); } }), openAdapter });
  assert.equal(resumeChallenge.resultType, "input_required");
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(resumeState, response), openAdapter });
  assert.equal(applied.outcome, "completed");
  assert.equal(remote.files.get("/root/deploy/file.txt").data.toString(), "new-content");

  let rollbackState;
  const rollbackChallenge = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return JSON.stringify(value); } }), openAdapter });
  assert.equal(rollbackChallenge.resultType, "input_required");
  const rollbackResponse = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const rolledBack = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, rollbackResponse), openAdapter });
  assert.equal(rolledBack.outcome, "rolled_back");
  assert.equal(remote.files.get("/root/deploy/file.txt").data.toString(), "old-content");
});

test("a stale resumed claim reports only current-call effects and preserves historical evidence", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "a.txt", "new-a");
  await write(f.localRoot, "b.txt", "new-b");
  const remote = memoryRemote(f.server, {
    "a.txt": { data: "old-a", mode: 0o640 },
    "b.txt": { data: "old-b", mode: 0o640 },
  });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-stale-existing-claim";
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  let associateState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: operation({ mintRequestState: async (value) => { associateState = value; return "signed"; } }), openAdapter });
  const associated = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: confirmed(associateState, response), openAdapter });

  let uploads = 0;
  const upload = remote.uploadStream.bind(remote);
  remote.uploadStream = async (...args) => {
    if (++uploads === 2) throw new Error("stop after one applied file");
    return upload(...args);
  };
  let partialState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { partialState = value; return "signed"; } }), openAdapter });
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(partialState, response), openAdapter }));
  const historical = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: planned.output.plan_id } });
  assert.equal(historical.operation_id, associated.operation_id);
  assert.equal(historical.counts.applied, 1);

  await write(f.localRoot, "b.txt", "bad-b");
  let resumeState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { resumeState = value; return "signed"; } }), openAdapter });
  const operationDir = path.join(f.stateDir, "operations", associated.operation_id);
  const evidence = [
    path.join(f.stateDir, "claims", `${planned.output.plan_id}.json`),
    path.join(operationDir, "head.json"),
    path.join(operationDir, "journal.jsonl"),
  ];
  const before = await Promise.all(evidence.map((file) => fs.readFile(file)));
  const claimsBefore = await fs.readdir(path.join(f.stateDir, "claims"));
  const operationsBefore = await fs.readdir(path.join(f.stateDir, "operations"));
  const networkBefore = remote.calls.length;
  const run = confirmed(resumeState, response);
  let caught;
  try {
    await applyDurableDeployment({ loaded: f.loaded,
      input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: run, openAdapter });
  } catch (error) { caught = error; }
  const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
  assert.equal(projected.code, "PLAN_STALE");
  assert.equal(projected.effects, "none");
  assert.equal(projected.operation_id, associated.operation_id);
  assert.equal(projected.phase, "applying");
  assert.deepEqual(projected.partial, { completed_files: 1, completed_bytes: 5, rolled_back_files: 0,
    remaining_applied_files: 1, conflict_index: 1 });
  assert.equal(remote.calls.length, networkBefore);
  assert.deepEqual(await fs.readdir(path.join(f.stateDir, "claims")), claimsBefore);
  assert.deepEqual(await fs.readdir(path.join(f.stateDir, "operations")), operationsBefore);
  const after = await Promise.all(evidence.map((file) => fs.readFile(file)));
  assert.deepEqual(after, before);
});

test("historical PROMOTING ambiguity reports no effect for a read-only resume", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const input = { plan_id: planned.output.plan_id, idempotency_key: "historical-promoting-ambiguity", resume: true };
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  let confirmationState;
  await applyDurableDeployment({ loaded: f.loaded, input,
    operation: operation({ mintRequestState: async (value) => { confirmationState = value; return "signed"; } }), openAdapter });

  const upload = remote.uploadStream.bind(remote);
  let uploaded = false, headsAfterUpload = 0, interrupted = false;
  remote.uploadStream = async (...args) => {
    const result = await upload(...args);
    uploaded = true;
    return result;
  };
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded, input,
    operation: confirmed(confirmationState, response), openAdapter,
    fault(name) {
      if (uploaded && name === "head_publish_after" && ++headsAfterUpload === 2) {
        interrupted = true;
        throw new Error("after PROMOTING publication");
      }
    },
  }));
  assert.equal(interrupted, true);
  const staged = [...remote.files.keys()].find((name) => path.posix.basename(name).startsWith(".ftp-mcp-"));
  assert.ok(staged);
  remote.files.delete(staged);

  let resumeState;
  await applyDurableDeployment({ loaded: f.loaded, input,
    operation: operation({ mintRequestState: async (value) => { resumeState = value; return "signed"; } }), openAdapter });
  const status = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: planned.output.plan_id } });
  const operationDir = path.join(f.stateDir, "operations", status.operation_id);
  const evidence = [path.join(operationDir, "head.json"), path.join(operationDir, "journal.jsonl")];
  const before = await Promise.all(evidence.map((file) => fs.readFile(file)));
  const mutatingCallsBefore = remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length;
  const run = confirmed(resumeState, response);
  let caught;
  try {
    await applyDurableDeployment({ loaded: f.loaded, input, operation: run, openAdapter });
  } catch (error) { caught = error; }
  const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
  assert.equal(projected.code, "RECONCILIATION_REQUIRED");
  assert.equal(projected.effects, "none");
  assert.equal(projected.operation_id, status.operation_id);
  assert.equal(projected.phase, "applying");
  assert.equal(remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length, mutatingCallsBefore);
  assert.deepEqual(await Promise.all(evidence.map((file) => fs.readFile(file))), before);
});

test("historical RESTORING ambiguity reports no effect for a read-only rollback resume", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const applyInput = { plan_id: planned.output.plan_id, idempotency_key: "historical-restoring-ambiguity", resume: true };
  let applyState;
  await applyDurableDeployment({ loaded: f.loaded, input: applyInput,
    operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
  const applied = await applyDurableDeployment({ loaded: f.loaded, input: applyInput,
    operation: confirmed(applyState, response), openAdapter });
  const rollbackInput = { operation_id: applied.operation_id, resume: true };
  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: rollbackInput,
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });

  const upload = remote.uploadStream.bind(remote);
  let uploaded = false, headsAfterUpload = 0, interrupted = false;
  remote.uploadStream = async (...args) => {
    const result = await upload(...args);
    uploaded = true;
    return result;
  };
  await assert.rejects(rollbackDurableDeployment({ loaded: f.loaded, input: rollbackInput,
    operation: confirmed(rollbackState, response), openAdapter,
    fault(name) {
      if (uploaded && name === "head_publish_after" && ++headsAfterUpload === 2) {
        interrupted = true;
        throw new Error("after RESTORING publication");
      }
    },
  }));
  assert.equal(interrupted, true);
  const staged = [...remote.files.keys()].find((name) => path.posix.basename(name).startsWith(".ftp-mcp-"));
  assert.ok(staged);
  remote.files.delete(staged);

  let resumeState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: rollbackInput,
    operation: operation({ mintRequestState: async (value) => { resumeState = value; return "signed"; } }), openAdapter });
  const operationDir = path.join(f.stateDir, "operations", applied.operation_id);
  const evidence = [path.join(operationDir, "head.json"), path.join(operationDir, "journal.jsonl")];
  const before = await Promise.all(evidence.map((file) => fs.readFile(file)));
  const mutatingCallsBefore = remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length;
  const run = confirmed(resumeState, response);
  let caught;
  try {
    await rollbackDurableDeployment({ loaded: f.loaded, input: rollbackInput, operation: run, openAdapter });
  } catch (error) { caught = error; }
  const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
  assert.equal(projected.code, "RECONCILIATION_REQUIRED");
  assert.equal(projected.effects, "none");
  assert.equal(projected.operation_id, applied.operation_id);
  assert.equal(projected.phase, "rolling_back");
  assert.equal(remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length, mutatingCallsBefore);
  assert.deepEqual(await Promise.all(evidence.map((file) => fs.readFile(file))), before);
});

test("historically exhausted apply attempts report no effect before a fourth attempt", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  remote.uploadStream = async (_readable, target) => {
    remote.calls.push(["uploadStream", target]);
    throw new Error("staging unavailable");
  };
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const input = { plan_id: planned.output.plan_id, idempotency_key: "historically-exhausted-attempts", resume: true };
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  async function resume(fault) {
    let state;
    await applyDurableDeployment({ loaded: f.loaded, input,
      operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }), openAdapter });
    const run = confirmed(state, response);
    let caught;
    try {
      await applyDurableDeployment({ loaded: f.loaded, input, operation: run, openAdapter, fault });
    } catch (error) { caught = error; }
    return { caught, run };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const failed = await resume();
    assert.match(failed.caught.message, /staging unavailable/);
  }
  let interrupted = false;
  const abandoned = await resume((name) => {
    if (!interrupted && name === "head_publish_after") {
      interrupted = true;
      throw new Error("after third ATTEMPT_ABANDONED publication");
    }
  });
  assert.equal(interrupted, true);
  assert.equal(abandoned.caught.code, "DURABLE_STATE_IO");

  const status = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: planned.output.plan_id } });
  const operationDir = path.join(f.stateDir, "operations", status.operation_id);
  const evidence = [path.join(operationDir, "head.json"), path.join(operationDir, "journal.jsonl")];
  const before = await Promise.all(evidence.map((file) => fs.readFile(file)));
  const mutatingCallsBefore = remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length;
  const exhausted = await resume();
  const projected = projectDurableError(exhausted.caught,
    { requestId: randomUUID(), operationSnapshot: exhausted.run.snapshot() }).error;
  assert.equal(projected.code, "RECONCILIATION_REQUIRED");
  assert.equal(projected.effects, "none");
  assert.equal(projected.operation_id, status.operation_id);
  assert.equal(projected.phase, "applying");
  assert.equal(remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length, mutatingCallsBefore);
  assert.deepEqual(await Promise.all(evidence.map((file) => fs.readFile(file))), before);
});

test("declined confirmation creates no claim and performs no apply network operation", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old" } });
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter: async () => remote });
  let state;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0002", resume: true },
    operation: operation({ mintRequestState: async (value) => { state = value; return JSON.stringify(value); } }), openAdapter: async () => remote });
  const before = remote.calls.length;
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0002", resume: true },
    operation: confirmed(state, { confirm: false, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest }),
    openAdapter: async () => remote }), { code: "CONFIRMATION_DECLINED" });
  assert.equal(remote.calls.length, before);
});

test("same-size local substitution fails before adapter construction or remote mutation", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "good");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!" } });
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." },
    operation: operation(), openAdapter: async () => remote });
  let state;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0003", resume: true },
    operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }),
    openAdapter: async () => { throw new Error("must not connect"); } });
  await write(f.localRoot, "file.txt", "evil");
  let opened = 0;
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0003", resume: true },
    operation: confirmed(state, { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest }),
    openAdapter: async () => { opened++; return remote; } }), { code: "PLAN_STALE" });
  assert.equal(opened, 0);
  assert.equal(remote.files.get("/root/file.txt").data.toString(), "old!");
});

test("lost promotion acknowledgement becomes SATISFIED_UNOWNED and explicit rollback never touches it", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const originalRename = remote.rename.bind(remote);
  let loseAck = false;
  remote.rename = async (...args) => {
    await originalRename(...args);
    if (loseAck) { loseAck = false; throw new Error("lost acknowledgement"); }
  };
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-key-lost-ack";
  let applyState;
  await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
  loseAck = true;
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(applyState, response), openAdapter });
  assert.equal(applied.outcome, "completed_with_warnings");
  assert.equal(applied.counts.satisfied_unowned, 1);
  assert.equal(applied.counts.applied, 0);
  assert.equal(remote.files.get("/root/file.txt").data.toString(), "new!");

  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });
  const mutationsBeforeRollback = remote.calls.filter(([name]) => ["rename", "deleteFile", "uploadStream"].includes(name)).length;
  const rolledBack = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, response), openAdapter });
  assert.equal(rolledBack.counts.satisfied_unowned, 1);
  assert.equal(remote.files.get("/root/file.txt").data.toString(), "new!");
  assert.equal(remote.calls.filter(([name]) => ["rename", "deleteFile", "uploadStream"].includes(name)).length, mutationsBeforeRollback);
});

test("rollback reconciles lost delete and restore acknowledgements from exact postconditions", async (t) => {
  for (const before of ["absent", "file"]) {
    await t.test(before, async (t) => {
      const f = await fixture(t);
      await write(f.localRoot, "file.txt", "new!");
      const remote = memoryRemote(f.server, before === "file" ? { "file.txt": { data: "old!", mode: 0o640 } } : {});
      const openAdapter = async () => remote;
      const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
      const key = `idempotency-key-${before}-ack`;
      let applyState;
      await applyDurableDeployment({ loaded: f.loaded,
        input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
        operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
      const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
      const applied = await applyDurableDeployment({ loaded: f.loaded,
        input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(applyState, response), openAdapter });
      let rollbackState;
      await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
        operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });
      if (before === "absent") {
        const originalDelete = remote.deleteFile.bind(remote);
        remote.deleteFile = async (...args) => { await originalDelete(...args); throw new Error("lost delete acknowledgement"); };
      } else {
        const originalRename = remote.rename.bind(remote);
        remote.rename = async (...args) => { await originalRename(...args); throw new Error("lost restore acknowledgement"); };
      }
      const rolledBack = await rollbackDurableDeployment({ loaded: f.loaded,
        input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, response), openAdapter });
      assert.equal(rolledBack.counts.rolled_back, 1);
      if (before === "absent") assert.equal(remote.files.has("/root/file.txt"), false);
      else assert.equal(remote.files.get("/root/file.txt").data.toString(), "old!");
    });
  }
});

test("configured local-root retarget fails before adapter construction", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "good");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!" } });
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." },
    operation: operation(), openAdapter: async () => remote });
  let state;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0005", resume: true },
    operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }),
    openAdapter: async () => remote });
  const replacementRoot = path.join(f.root, "retargeted-local");
  await fs.mkdir(replacementRoot);
  await write(replacementRoot, "file.txt", "good");
  f.loaded.config.servers.prod.localRoot = replacementRoot;
  let opened = 0;
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-key-0005", resume: true },
    operation: confirmed(state, { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest }),
    openAdapter: async () => { opened++; return remote; } }), { code: "PLAN_STALE" });
  assert.equal(opened, 0);
  assert.equal(remote.files.get("/root/file.txt").data.toString(), "old!");
});

test("live localRoot overlap blocks apply before journal or network activity", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  let opened = 0;
  const openAdapter = async () => { opened++; return remote; };
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-live-root-overlap";
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  let associateState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: operation({ mintRequestState: async (value) => { associateState = value; return "signed"; } }), openAdapter });
  const associated = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: confirmed(associateState, response), openAdapter });
  const operationDir = path.join(f.stateDir, "operations", associated.operation_id);
  const evidence = [
    path.join(f.stateDir, "claims", `${planned.output.plan_id}.json`),
    path.join(operationDir, "head.json"),
    path.join(operationDir, "journal.jsonl"),
  ];
  const before = await Promise.all(evidence.map((file) => fs.readFile(file)));
  const plansBefore = await fs.readdir(path.join(f.stateDir, "plans"));
  const callsBefore = remote.calls.length;
  const openedBefore = opened;

  await fs.rm(f.localRoot, { recursive: true });
  await fs.symlink(f.stateDir, f.localRoot, process.platform === "win32" ? "junction" : "dir");
  const run = operation();
  let caught;
  try {
    await applyDurableDeployment({ loaded: f.loaded,
      input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: run, openAdapter });
  } catch (error) { caught = error; }
  const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
  assert.equal(projected.code, "CONFIG_INVALID");
  assert.equal(projected.effects, "none");
  assert.equal(opened, openedBefore);
  assert.equal(remote.calls.length, callsBefore);
  assert.deepEqual(await fs.readdir(path.join(f.stateDir, "plans")), plansBefore);
  assert.deepEqual(await Promise.all(evidence.map((file) => fs.readFile(file))), before);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [f.stateDir, "credential-secret", "passphrase-secret", "private-key-secret"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("rollback remains authorized after configured local-root drift", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." },
    operation: operation(), openAdapter: async () => remote });
  const key = "idempotency-key-0004";
  let state;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }), openAdapter: async () => remote });
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(state, response),
    openAdapter: async () => remote });
  await fs.rm(f.localRoot, { recursive: true });
  f.loaded.config.servers.prod.localRoot = path.join(f.root, "missing-planned-root");
  f.loaded.config.servers.unrelated = { ...f.raw, host: "unrelated.test", localRoot: path.join(f.root, "missing-unrelated-root") };
  f.loaded.serverNames.push("unrelated");
  const status = await readDeploymentStatus({ loaded: f.loaded, input: { operation_id: applied.operation_id } });
  assert.equal(status.phase, "completed");
  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter: async () => remote });
  const rolledBack = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, response),
    openAdapter: async () => remote });
  assert.equal(rolledBack.outcome, "rolled_back");
  assert.equal(remote.files.get("/root/file.txt").data.toString(), "old!");

  const overlappingRoot = path.join(f.root, "overlapping-unrelated-root");
  await fs.symlink(f.stateDir, overlappingRoot, process.platform === "win32" ? "junction" : "dir");
  f.loaded.config.servers.overlap = { ...f.raw, host: "overlap.test", localRoot: overlappingRoot };
  f.loaded.serverNames.push("overlap");
  const networkBefore = remote.calls.length;
  await assert.rejects(readDeploymentStatus({ loaded: f.loaded, input: { operation_id: applied.operation_id } }),
    { code: "CONFIG_INVALID" });
  await assert.rejects(rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: operation(),
    openAdapter: async () => remote }), { code: "CONFIG_INVALID" });
  assert.equal(remote.calls.length, networkBefore);
});

test("read-only changes refuse confirmed apply and rollback before claim or network mutation", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-key-readonly";
  let applyState;
  await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  const networkBefore = remote.calls.length;
  f.loaded.config.servers.prod.readOnly = true;
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(applyState, response), openAdapter }), { code: "READ_ONLY" });
  assert.equal(remote.calls.length, networkBefore);
  const unclaimed = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: planned.output.plan_id } });
  assert.equal(unclaimed.operation_id, null);

  f.loaded.config.servers.prod.readOnly = false;
  let freshApplyState;
  await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { freshApplyState = value; return "signed"; } }), openAdapter });
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(freshApplyState, response), openAdapter });
  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });
  const mutationsBefore = remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length;
  f.loaded.config.servers.prod.readOnly = true;
  await assert.rejects(rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, response), openAdapter }), { code: "READ_ONLY" });
  assert.equal(remote.calls.filter(([name]) => ["uploadStream", "rename", "deleteFile"].includes(name)).length, mutationsBefore);
});

test("claimed resume and terminal replay use fresh confirmation windows after plan TTL", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const openAdapter = async () => remote;
  const plannedAt = Date.now();
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: ".", ttl_seconds: 60 },
    operation: operation(), openAdapter, now: plannedAt });
  const key = "idempotency-key-post-ttl";
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  let associateState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: operation({ mintRequestState: async (value) => { associateState = value; return "signed"; } }), openAdapter, now: plannedAt });
  const associated = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
    operation: confirmed(associateState, response), openAdapter, now: plannedAt });
  assert.equal(associated.outcome, "status_only");
  const afterTtl = planned.output.expires_at_ms + 1;
  let resumeState;
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { resumeState = value; return "signed"; } }), openAdapter, now: afterTtl });
  assert.ok(resumeState.expiresAt > planned.output.expires_at_ms);
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(resumeState, response), openAdapter, now: afterTtl });
  assert.equal(applied.outcome, "completed");

  let replayState;
  const warning = applied.security_warning;
  delete f.loaded.config.servers.prod;
  f.loaded.serverNames = [];
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { replayState = value; return "signed"; } }), openAdapter, now: afterTtl + 1 });
  const replayed = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(replayState, response), openAdapter, now: afterTtl + 1 });
  assert.equal(replayed.outcome, "already_terminal");
  assert.equal(replayed.security_warning, warning);

  f.loaded.config.servers.prod = f.raw;
  f.loaded.serverNames = ["prod"];
  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter, now: afterTtl + 2 });
  const rolledBack = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackState, response), openAdapter, now: afterTtl + 2 });
  assert.equal(rolledBack.outcome, "rolled_back");
  delete f.loaded.config.servers.prod;
  f.loaded.serverNames = [];
  let rollbackReplayState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackReplayState = value; return "signed"; } }), openAdapter, now: afterTtl + 3 });
  const rollbackReplay = await rollbackDurableDeployment({ loaded: f.loaded,
    input: { operation_id: applied.operation_id, resume: true }, operation: confirmed(rollbackReplayState, response), openAdapter, now: afterTtl + 3 });
  assert.equal(rollbackReplay.outcome, "already_terminal");
  assert.equal(rollbackReplay.security_warning, warning);
});

test("lost SFTP promotion acknowledgement with wrong destination mode fails closed", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const originalRename = remote.rename.bind(remote);
  let corruptMode = false;
  remote.rename = async (from, to, options) => {
    if (!corruptMode) return originalRename(from, to, options);
    await originalRename(from, to, { ...options, mode: 0o600 });
    throw new Error("lost acknowledgement after wrong mode");
  };
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-key-wrong-mode";
  let state;
  await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }), openAdapter });
  corruptMode = true;
  await assert.rejects(applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: confirmed(state, { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest }), openAdapter }));
  const status = await readDeploymentStatus({ loaded: f.loaded, input: { plan_id: planned.output.plan_id } });
  assert.equal(status.counts.satisfied_unowned, 0);
  assert.equal(status.phase, "applying");
  assert.equal(remote.files.get("/root/file.txt").mode, 0o600);
});

test("persisted alias selects the durable timeout instead of the inverse default", async (t) => {
  const f = await fixture(t, { serverOverrides: { operationTimeoutMs: 900000 } });
  f.loaded.config.servers.other = { ...f.raw, host: "other.test", operationTimeoutMs: 100 };
  f.loaded.serverNames.push("other");
  f.loaded.defaultServer = "other";
  f.loaded.config.defaultServer = "other";
  await write(f.localRoot, "file.txt", "new!");
  const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { server: "prod", local_dir: "." },
    operation: operation(), openAdapter: async () => remote });
  const call = operation({ mintRequestState: async () => "signed" });
  await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: "idempotency-timeout", resume: true },
    operation: call, openAdapter: async () => remote });
  assert.equal(call.shortenedTo, 900000);
});

test("plan publication faults project the final-link effect boundary and known plan identity", async (t) => {
  const stages = ["plan_publish_before", "plan_publish_after", "plan_unlink_temp_before", "plan_unlink_temp_after",
    "directory_sync_before", ...(process.platform === "win32" ? [] : ["directory_sync_after"]),
    "directory_close_before", "directory_close_after"];
  for (const stage of stages) {
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      await write(f.localRoot, "file.txt", "new!");
      const initialized = await openDurableState({ loaded: f.loaded, create: true });
      await initialized.close();
      const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
      const run = operation();
      let caught, finalLinked = false;
      try {
        await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: run,
          openAdapter: async () => remote,
          fault(name) {
            if (name === "plan_publish_after") finalLinked = true;
            if (name === stage && (!name.startsWith("directory_") || finalLinked)) throw new Error(stage);
          } });
      } catch (error) { caught = error; }
      const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
      assert.equal(projected.effects, stage === "plan_publish_before" ? "possible" : "confirmed", stage);
      assert.match(projected.plan_id, /^pln_[0-9a-f-]{36}$/);
      const final = path.join(f.stateDir, "plans", `${projected.plan_id}.json`);
      if (stage === "plan_publish_before") await assert.rejects(fs.stat(final), { code: "ENOENT" });
      else assert.equal((await fs.stat(final)).isFile(), true);
    });
  }

  await t.test("adapter close after publication", async (t) => {
    const f = await fixture(t);
    await write(f.localRoot, "file.txt", "new!");
    const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
    remote.close = async () => { remote.calls.push(["close"]); throw new Error("close after publication"); };
    const run = operation();
    let caught;
    try {
      await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: run, openAdapter: async () => remote });
    } catch (error) { caught = error; }
    const published = (await fs.readdir(path.join(f.stateDir, "plans"))).filter((name) => /^pln_[0-9a-f-]{36}\.json$/.test(name));
    assert.equal(published.length, 1);
    const planId = published[0].slice(0, -5);
    const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
    assert.equal(projected.effects, "confirmed");
    assert.equal(projected.plan_id, planId);
  });
});

test("durable journal write, fsync, close and head failures retain operation snapshots", async (t) => {
  for (const stage of ["journal_write_after", "journal_sync_after", "journal_close_after", "head_publish_after"]) {
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      await write(f.localRoot, "file.txt", "new!");
      const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
      const openAdapter = async () => remote;
      const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
      const key = `idempotency-${stage}`;
      const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
      let associateState;
      await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
        operation: operation({ mintRequestState: async (value) => { associateState = value; return "signed"; } }), openAdapter });
      await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: false },
        operation: confirmed(associateState, response), openAdapter });
      let resumeState;
      await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
        operation: operation({ mintRequestState: async (value) => { resumeState = value; return "signed"; } }), openAdapter });
      let fired = false;
      const run = confirmed(resumeState, response);
      let caught;
      try {
        await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
          operation: run, openAdapter, fault(name) { if (!fired && name === stage) { fired = true; throw new Error(stage); } } });
      } catch (error) { caught = error; }
      assert.ok(fired && caught, stage);
      const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
      assert.equal(projected.operation_id.startsWith("op_"), true);
      assert.equal(projected.phase, "applying");
      assert.notEqual(projected.effects, "none");
      assert.ok(projected.partial);
    });
  }
});

test("upload, promote, delete and restore acknowledgement failures retain durable evidence", async (t) => {
  await t.test("upload", async (t) => {
    const f = await fixture(t);
    await write(f.localRoot, "file.txt", "new!");
    const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
    const openAdapter = async () => remote;
    const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
    const key = "idempotency-upload-ack";
    let state;
    await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
      operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }), openAdapter });
    const original = remote.uploadStream.bind(remote);
    remote.uploadStream = async (...args) => { await original(...args); throw new Error("upload acknowledgement lost"); };
    const run = confirmed(state, { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest });
    let caught;
    try { await applyDurableDeployment({ loaded: f.loaded,
      input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: run, openAdapter }); }
    catch (error) { caught = error; }
    const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
    assert.equal(projected.phase, "applying");
    assert.notEqual(projected.effects, "none");
    assert.ok(projected.operation_id);
  });

  await t.test("promote", async (t) => {
    const f = await fixture(t);
    await write(f.localRoot, "file.txt", "new!");
    const remote = memoryRemote(f.server, { "file.txt": { data: "old!", mode: 0o640 } });
    const openAdapter = async () => remote;
    const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
    const key = "idempotency-promote-ack";
    let state;
    await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
      operation: operation({ mintRequestState: async (value) => { state = value; return "signed"; } }), openAdapter });
    let armed = false, fired = false;
    const original = remote.rename.bind(remote);
    remote.rename = async (...args) => { const value = await original(...args); armed = true; return value; };
    const run = confirmed(state, { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest });
    let caught;
    try { await applyDurableDeployment({ loaded: f.loaded,
      input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: run, openAdapter,
      fault(name) { if (armed && !fired && name === "journal_write_before") { fired = true; throw new Error("after rename ack"); } } }); }
    catch (error) { caught = error; }
    const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
    assert.ok(fired);
    assert.equal(projected.effects, "confirmed");
    assert.equal(projected.partial.completed_files, 1);
  });

  for (const before of ["absent", "file"]) {
    await t.test(before === "absent" ? "delete" : "restore", async (t) => {
      const f = await fixture(t);
      await write(f.localRoot, "file.txt", "new!");
      const remote = memoryRemote(f.server, before === "file" ? { "file.txt": { data: "old!", mode: 0o640 } } : {});
      const openAdapter = async () => remote;
      const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
      const key = `idempotency-${before}-state-ack`;
      const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
      let applyState;
      await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
        operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
      const applied = await applyDurableDeployment({ loaded: f.loaded,
        input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(applyState, response), openAdapter });
      let rollbackState;
      await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
        operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });
      let armed = false, fired = false;
      const method = before === "absent" ? "deleteFile" : "rename";
      const original = remote[method].bind(remote);
      remote[method] = async (...args) => { const value = await original(...args); armed = true; return value; };
      const run = confirmed(rollbackState, response);
      let caught;
      try { await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
        operation: run, openAdapter,
        fault(name) { if (armed && !fired && name === "journal_write_before") { fired = true; throw new Error("after rollback ack"); } } }); }
      catch (error) { caught = error; }
      const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
      assert.ok(fired);
      assert.equal(projected.effects, "confirmed");
      assert.equal(projected.phase, "rolling_back");
      assert.ok(projected.operation_id);
    });
  }
});

test("rollback error projects one restored file, one remaining applied file and the conflict index", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "a.txt", "new-a");
  await write(f.localRoot, "b.txt", "new-b");
  const remote = memoryRemote(f.server, {
    "a.txt": { data: "old-a", mode: 0o640 },
    "b.txt": { data: "old-b", mode: 0o640 },
  });
  const openAdapter = async () => remote;
  const planned = await planDurableDeployment({ loaded: f.loaded, input: { local_dir: "." }, operation: operation(), openAdapter });
  const key = "idempotency-partial-rollback";
  const response = { confirm: true, plan_id: planned.output.plan_id, plan_digest: planned.output.plan_digest };
  let applyState;
  await applyDurableDeployment({ loaded: f.loaded, input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true },
    operation: operation({ mintRequestState: async (value) => { applyState = value; return "signed"; } }), openAdapter });
  const applied = await applyDurableDeployment({ loaded: f.loaded,
    input: { plan_id: planned.output.plan_id, idempotency_key: key, resume: true }, operation: confirmed(applyState, response), openAdapter });
  let rollbackState;
  await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: operation({ mintRequestState: async (value) => { rollbackState = value; return "signed"; } }), openAdapter });
  const originalRename = remote.rename.bind(remote);
  remote.rename = async (from, to, options) => {
    const result = await originalRename(from, to, options);
    if (to.endsWith("/b.txt")) remote.files.set("/root/a.txt", { data: Buffer.from("evil!"), mode: 0o640 });
    return result;
  };
  const run = confirmed(rollbackState, response);
  let caught;
  try { await rollbackDurableDeployment({ loaded: f.loaded, input: { operation_id: applied.operation_id, resume: true },
    operation: run, openAdapter }); }
  catch (error) { caught = error; }
  const projected = projectDurableError(caught, { requestId: randomUUID(), operationSnapshot: run.snapshot() }).error;
  assert.equal(projected.code, "ROLLBACK_CONFLICT");
  assert.equal(projected.phase, "rolling_back");
  assert.deepEqual(projected.partial, { completed_files: 1, completed_bytes: 5, rolled_back_files: 1,
    remaining_applied_files: 1, conflict_index: 0 });
});
