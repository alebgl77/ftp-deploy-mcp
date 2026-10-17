import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { appError } from "../../src/errors.js";
import { buildDeploymentPlan } from "../../src/durable/plan.js";
import { PlanOutputSchema } from "../../src/durable/schemas.js";
import { fakeAdapter, fixture, operation, sha256, write } from "./helpers.mjs";

test("SFTP planning is ordered, bounded, immutable and supports existing canonical parents", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "source/b.txt", "new-b");
  await write(f.localRoot, "source/a.txt", "same-a");
  await write(f.localRoot, "source/empty.txt", "");
  await write(f.localRoot, "source/skip.log", "excluded");
  const adapter = fakeAdapter(f.server, {
    "deploy/a.txt": { data: Buffer.from("same-a") },
    "deploy/b.txt": { data: Buffer.from("old-b") },
    "deploy/empty.txt": { kind: "absent" },
  });
  const built = await buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId,
    input: { local_dir: "source", remote_dir: "deploy", include: ["*.txt"], ttl_seconds: 60 },
    adapter, operation: operation(), now: 1000,
    planId: "pln_12345678-1234-4234-8234-123456789abc" });
  assert.deepEqual(built.plan.files.map((file) => file.remotePath), ["deploy/a.txt", "deploy/b.txt", "deploy/empty.txt"]);
  assert.deepEqual(built.plan.files.map((file) => file.localPath), ["source/a.txt", "source/b.txt", "source/empty.txt"]);
  assert.equal(built.output.created_at_ms, 1000);
  assert.equal(built.output.expires_at_ms, 61000);
  assert.equal(built.output.total_files, 3);
  assert.equal(built.output.unchanged_files, 1);
  assert.equal(built.output.new_files, 1);
  assert.equal(built.output.replaced_files, 1);
  assert.equal(built.output.backup_bytes, Buffer.byteLength("old-b"));
  assert.equal(built.plan.files[2].bytes, 0);
  assert.equal(built.plan.files[2].desiredMode, 0o644);
  assert.equal(built.output.plan_digest, sha256(built.bytes));
  assert.ok(PlanOutputSchema.safeParse(built.output).success);
  assert.ok(Object.isFrozen(built.plan));
  assert.ok(Object.isFrozen(built.plan.files));
  assert.ok(Object.isFrozen(built.plan.files[0]));
  assert.ok(Object.isFrozen(built.output));
  assert.ok(Object.isFrozen(built.output.guarantees));
  assert.ok(Object.isFrozen(built.policy));

  const serialized = JSON.stringify({ plan: built.plan, output: built.output, reservation: built.reservation });
  for (const secret of ["credential-secret", "passphrase-secret", "private-key-secret"]) assert.doesNotMatch(serialized, new RegExp(secret));
});

for (const protocol of ["ftp", "ftps"]) {
  test(`${protocol.toUpperCase()} planning replaces regular files and refuses absence`, async (t) => {
    const f = await fixture(t, { protocol });
    await write(f.localRoot, "file.txt", "new");
    const present = fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } });
    const built = await buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId, input: { local_dir: "." }, adapter: present, operation: operation(), now: 1 });
    assert.equal(built.plan.files[0].before.kind, "file");
    assert.equal(built.plan.target.canonicalRoot, null);
    assert.equal(built.plan.files[0].desiredMode, null);

    const absent = fakeAdapter(f.server, { "file.txt": { kind: "absent" } });
    await assert.rejects(buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId, input: { local_dir: "." }, adapter: absent, operation: operation(), now: 1 }),
      { code: "WORKFLOW_UNSUPPORTED" });
  });
}

test("directory/link observations fail closed as WORKFLOW_UNSUPPORTED", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new");
  for (const code of ["directory", "link"]) {
    const rejected = appError("PATH_REJECTED", "runtime.remote.escape", { path: "private", root: "/root" });
    const adapter = fakeAdapter(f.server, { "file.txt": rejected });
    await assert.rejects(buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId, input: { local_dir: "." }, adapter, operation: operation(), now: 1 }),
      (error) => error.code === "WORKFLOW_UNSUPPORTED" && !error.message.includes(code));
  }
});

test("local deploy limits stop before remote observation; equality and zero-byte inputs pass", async (t) => {
  const tooLarge = await fixture(t, { serverOverrides: { maxTransferBytes: 4, maxDeployBytes: 3 } });
  await write(tooLarge.localRoot, "file.txt", "1234");
  const untouched = fakeAdapter(tooLarge.server, { "file.txt": { kind: "absent" } });
  await assert.rejects(buildDeploymentPlan({ loaded: tooLarge.loaded, domainId: tooLarge.domainId, input: { local_dir: "." }, adapter: untouched, operation: operation(), now: 1 }),
    { code: "TRANSFER_LIMIT" });
  assert.equal(untouched.calls.length, 0);

  const exact = await fixture(t, { serverOverrides: { maxTransferBytes: 4, maxDeployBytes: 4 } });
  await write(exact.localRoot, "file.txt", "1234");
  const exactAdapter = fakeAdapter(exact.server, { "file.txt": { kind: "absent" } });
  assert.equal((await buildDeploymentPlan({ loaded: exact.loaded, domainId: exact.domainId, input: { local_dir: "." }, adapter: exactAdapter, operation: operation(), now: 1 })).output.total_bytes, 4);

  const empty = await fixture(t);
  await write(empty.localRoot, "empty.txt", "");
  const emptyAdapter = fakeAdapter(empty.server, { "empty.txt": { kind: "absent" } });
  assert.equal((await buildDeploymentPlan({ loaded: empty.loaded, domainId: empty.domainId, input: { local_dir: "." }, adapter: emptyAdapter, operation: operation(), now: 1 })).output.total_bytes, 0);

  const remote = await fixture(t, { serverOverrides: { maxTransferBytes: 4, maxDeployBytes: 4 } });
  await write(remote.localRoot, "file.txt", "1234");
  const remoteTooLarge = fakeAdapter(remote.server, { "file.txt": { data: Buffer.from("12345") } });
  await assert.rejects(buildDeploymentPlan({ loaded: remote.loaded, domainId: remote.domainId, input: { local_dir: "." }, adapter: remoteTooLarge,
    operation: operation(), now: 1 }), { code: "TRANSFER_LIMIT" });
  assert.equal(remoteTooLarge.calls.length, 1);
});

test("disabled durable state and plan-file limits fail before remote observation", async (t) => {
  const disabled = await fixture(t);
  await write(disabled.localRoot, "file.txt", "new");
  disabled.loaded.config.stateDir = undefined;
  const disabledAdapter = fakeAdapter(disabled.server);
  await assert.rejects(buildDeploymentPlan({ loaded: disabled.loaded, domainId: disabled.domainId, input: { local_dir: "." },
    adapter: disabledAdapter, operation: operation(), now: 1 }), { code: "DURABLE_STATE_DISABLED" });
  assert.equal(disabledAdapter.calls.length, 0);

  const bounded = await fixture(t);
  await Promise.all(Array.from({ length: bounded.stateLimits.maxPlanFiles + 1 }, (_, index) =>
    write(bounded.localRoot, `files/${String(index).padStart(5, "0")}.txt`, "x")));
  const boundedAdapter = fakeAdapter(bounded.server);
  await assert.rejects(buildDeploymentPlan({ loaded: bounded.loaded, domainId: bounded.domainId, input: { local_dir: "files" },
    adapter: boundedAdapter, operation: operation(), now: 1 }), { code: "DURABLE_STATE_LIMIT" });
  assert.equal(boundedAdapter.calls.length, 0);
});

test("remote observations share the deployment byte cap and stop at limit plus one", async (t) => {
  const f = await fixture(t, { serverOverrides: { maxTransferBytes: 4, maxDeployBytes: 4 } });
  await write(f.localRoot, "a.txt", "aa");
  await write(f.localRoot, "b.txt", "bb");
  const limits = [];
  const adapter = {
    async inspectFile(remotePath, { maxBytes }) {
      limits.push(maxBytes);
      const data = Buffer.from("old");
      if (data.length > maxBytes) throw appError("TRANSFER_LIMIT", "runtime.transfer.byteLimit");
      return { type: "file", path: remotePath, parent: "/canonical", canonicalRoot: "/canonical",
        bytes: data.length, sha256: sha256(data), mode: 0o644 };
    },
  };
  await assert.rejects(buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId, input: { local_dir: "." }, adapter,
    operation: operation(), now: 1 }), { code: "TRANSFER_LIMIT" });
  assert.deepEqual(limits, [4, 1]);
});

test("policy fingerprints drift on policy changes but not credential rotation", async (t) => {
  const f = await fixture(t);
  await write(f.localRoot, "file.txt", "new");
  const input = { local_dir: "." };
  const first = await buildDeploymentPlan({ loaded: f.loaded, domainId: f.domainId, input, adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1 });

  const credentialLoaded = structuredClone(f.loaded);
  credentialLoaded.config.servers.prod.password = "rotated-secret";
  const credential = await buildDeploymentPlan({ loaded: credentialLoaded, domainId: f.domainId, input,
    adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1 });
  assert.equal(credential.plan.policyHash, first.plan.policyHash);
  assert.equal(credential.targetHash, first.targetHash);

  const alternateRoot = path.join(f.root, "alternate-local");
  await write(alternateRoot, "file.txt", "new");
  const rootLoaded = structuredClone(f.loaded);
  rootLoaded.config.servers.prod.localRoot = alternateRoot;
  const rootChanged = await buildDeploymentPlan({ loaded: rootLoaded, domainId: f.domainId, input,
    adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1 });
  assert.equal(rootChanged.targetHash, first.targetHash);
  assert.notEqual(rootChanged.plan.source.localRootHash, first.plan.source.localRootHash);

  const policyLoaded = structuredClone(f.loaded);
  policyLoaded.config.servers.prod.readOnly = true;
  const policy = await buildDeploymentPlan({ loaded: policyLoaded, domainId: f.domainId, input,
    adapter: fakeAdapter(f.server, { "file.txt": { data: Buffer.from("old") } }), operation: operation(), now: 1 });
  assert.notEqual(policy.plan.policyHash, first.plan.policyHash);
  assert.notEqual(policy.targetHash, first.targetHash);
});
