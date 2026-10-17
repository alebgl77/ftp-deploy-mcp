import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { resolveServer } from "../config.js";
import { connectOperation, remoteLockKey } from "../operations.js";
import { relativeRemote, resolveRemote } from "../remote-path.js";
import { resolveLocalSource } from "../local-path.js";
import { encode, sha256 } from "../state/codec.mjs";
import { frameEnvelope, reservationFor } from "../workflow/budget.mjs";
import { createWorkflowPolicy, temporaryWarnings } from "../workflow/events.mjs";
import { decodePlan, idempotencyKeyHash, unchanged } from "../workflow/model.mjs";
import { cleanupVerifiedStage, hashLocalFile, promoteVerifiedStage, stageVerifiedSource } from "../transfers.js";
import { publishDeploymentPlan } from "./plan.js";
import { statusFromStore } from "./status.js";
import { ApplyOutputSchema, Guarantees, RollbackOutputSchema } from "./schemas.js";
import {
  DurableFailure,
  asDurableFailure,
  canonicalTargetIdentity,
  endpointLockHash,
  enrichDurableFailure,
  localRootHash,
  openDurableState,
  pinSeparatedLocalRoot,
  revalidateCanonicalLocalRoot,
  sameLocalRootHash,
  workflowIdentity,
} from "./state.js";
import { ConfirmationStateSchema, requireConfirmation } from "./confirmation.js";

const READ_LIMITS = Object.freeze({ maxTransferBytes: 1099511627776, maxDeployBytes: 1099511627776, maxDeployFiles: 100000 });
const CONFIRMATION_LIFETIME_MS = 120000;

function durableLockKey(stateDir, alias) { return `durable:${stateDir}\0${alias}`; }
function event(scope, type, fields = {}) { return { v: 1, scope, type, ...fields }; }
function token() { return randomBytes(16).toString("hex"); }
function remotePath(server, file) { return resolveRemote(server.root, file.remotePath); }
function temporaryPath(target, value) { return path.posix.join(path.posix.dirname(target), `.ftp-mcp-${value}.tmp`); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function limitsFor(server, durable) {
  return Object.freeze({ stateLimits: durable.stateLimits, maxTransferBytes: server.maxTransferBytes,
    maxDeployBytes: server.maxDeployBytes, maxDeployFiles: server.maxDeployFiles });
}

async function snapshot(store, durable, selector) {
  const loose = { ...READ_LIMITS, stateLimits: durable.stateLimits };
  const captured = await store.readStatusSnapshot(selector, (raw) => createWorkflowPolicy(decodePlan(raw, loose), loose));
  const plan = decodePlan(captured.planBytes, loose);
  return Object.freeze({ ...captured, plan, planDigest: digest(captured.planBytes), journalSeq: captured.journalMetadata?.tip.seq ?? 0 });
}

function confirmationSeed(operation, defaults) {
  const parsed = ConfirmationStateSchema.safeParse(operation?.requestState);
  return parsed.success ? {
    operationId: parsed.data.operationId,
    expiresAt: parsed.data.expiresAt,
  } : defaults;
}

function confirmationExpiry(plan, claimed, now) {
  const expires = now + CONFIRMATION_LIFETIME_MS;
  return claimed ? expires : Math.min(plan.expiresAt, expires);
}

function sameCanonical(left, right, stateLimits) {
  return encode(left, stateLimits, 16384).equals(encode(right, stateLimits, 16384));
}

function offlineIdentity({ serverAlias, server, plan, durable }) {
  const target = canonicalTargetIdentity({ serverAlias, server,
    canonicalRemoteRoot: server.protocol === "sftp" ? plan.target.canonicalRoot : null });
  const identity = workflowIdentity({ serverAlias, server, target, durable });
  if (!sameCanonical(target, plan.target, durable.stateLimits) || identity.policyHash !== plan.policyHash) {
    throw new DurableFailure("PLAN_STALE", "The configured deployment target or policy changed after planning.", { nextAction: "inspect_target" });
  }
  return identity;
}

async function onlineIdentity({ adapter, serverAlias, server, plan, durable }) {
  const first = plan.files[0];
  const observed = await adapter.inspectFile(remotePath(server, first), { maxBytes: Math.max(first.bytes, first.before.bytes ?? 0) });
  const target = canonicalTargetIdentity({ serverAlias, server,
    canonicalRemoteRoot: server.protocol === "sftp" ? observed.canonicalRoot : null });
  const identity = workflowIdentity({ serverAlias, server, target, durable });
  if (!sameCanonical(target, plan.target, durable.stateLimits) || identity.policyHash !== plan.policyHash) {
    throw new DurableFailure("PLAN_STALE", "The deployment target changed after planning.", { nextAction: "inspect_target" });
  }
  return identity;
}

function expectedIdentity(plan, file, target, expected) {
  return {
    canonicalRoot: plan.target.canonicalRoot ?? plan.target.root,
    path: plan.target.protocol === "sftp" ? path.posix.join(plan.target.canonicalRoot, file.remotePath) : target,
    parent: file.parent,
    bytes: expected.bytes,
    sha256: expected.sha256,
    ...(expected.mode === null || expected.mode === undefined ? {} : { mode: expected.mode }),
  };
}

function matchesFile(observed, expected, plan, file) {
  if (observed?.type !== "file" || observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) return false;
  if (plan.target.protocol === "sftp" && observed.mode !== expected.mode) return false;
  const base = plan.target.canonicalRoot ?? plan.target.root;
  const expectedPath = path.posix.join(base, file.remotePath);
  return observed.canonicalRoot === base && observed.path === expectedPath && observed.parent === file.parent;
}

function matchesStaged(observed, expected, plan, file) {
  return observed?.type === "file" && observed.bytes === expected.bytes && observed.sha256 === expected.sha256 &&
    observed.canonicalRoot === (plan.target.canonicalRoot ?? plan.target.root) && observed.parent === file.parent;
}

function matchesBefore(observed, plan, file) {
  if (file.before.kind === "absent") {
    return observed?.type === "absent" && observed.canonicalRoot === plan.target.canonicalRoot && observed.parent === file.parent;
  }
  return matchesFile(observed, file.before, plan, file);
}

function matchesDesired(observed, plan, file) {
  return matchesFile(observed, { bytes: file.bytes, sha256: file.sha256, mode: file.desiredMode }, plan, file);
}

async function observe(adapter, server, plan, file, bytes = Math.max(file.bytes, file.before.bytes ?? 0)) {
  return adapter.inspectFile(remotePath(server, file), { maxBytes: bytes });
}

function localFailure(serverAlias, file, reason = "changed") {
  return new DurableFailure("PLAN_STALE", `Local source validation failed for server ${serverAlias} at ${file.localPath} (${reason}).`, {
    nextAction: "fix_input",
  });
}

function localContext({ serverAlias, server, plan, domainId, durable }) {
  const pin = pinSeparatedLocalRoot(server.localRoot, { serverAlias, stateDir: durable.stateDir });
  const actual = localRootHash({ domainId, canonicalPath: pin.canonicalPath, stateLimits: durable.stateLimits });
  if (!sameLocalRootHash(actual, plan.source.localRootHash)) throw localFailure(serverAlias, plan.files[0], "root changed");
  return Object.freeze({ pin, serverAlias });
}

async function verifyLocal(server, file, operation, context) {
  try {
    revalidateCanonicalLocalRoot(context.pin, { serverAlias: context.serverAlias, relativePath: file.localPath });
    const source = resolveLocalSource(server, file.localPath, "file");
    const actual = await hashLocalFile(source.path, server.maxTransferBytes, operation);
    revalidateCanonicalLocalRoot(context.pin, { serverAlias: context.serverAlias, relativePath: file.localPath });
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw localFailure(context.serverAlias, file);
    return source.path;
  } catch (error) {
    if (error instanceof DurableFailure) throw error;
    throw localFailure(context.serverAlias, file, "unavailable");
  }
}

async function verifyAllLocal(server, plan, operation, context) {
  for (const file of plan.files) await verifyLocal(server, file, operation, context);
}

async function append(writer, limits, scope, type, fields = {}, operation) {
  const value = event(scope, type, fields);
  const bytes = frameEnvelope(value, writer.metadata.tip.seq + 1, limits.stateLimits).length;
  await writer.requireBudget({ bytes, events: 1, budget: scope });
  operation?.dispatch();
  const result = await writer.append(value, { budget: scope });
  operation?.confirm();
  return result;
}

function nextAttempt(attempts) {
  for (let a = 1; a <= 3; a++) if (attempts[`a${a}`] === null) return a;
  throw new DurableFailure("RECONCILIATION_REQUIRED", "No bounded deployment attempt remains for this file.", {
    nextAction: "offline_recovery",
  });
}

function activeAttempt(attempts) {
  for (let a = 3; a >= 1; a--) if (attempts[`a${a}`] !== null) return { a, value: attempts[`a${a}`] };
  return null;
}

async function backupFile({ writer, adapter, server, plan, file, operation, limits }) {
  let row = writer.metadata.state.files[file.index];
  if (row.backup === "READY" || file.before.kind !== "file" || unchanged(file)) return;
  const target = remotePath(server, file);
  const expected = expectedIdentity(plan, file, target, file.before);
  if (row.backup === "NONE") {
    const observed = await observe(adapter, server, plan, file, file.before.bytes);
    if (!matchesBefore(observed, plan, file)) throw new DurableFailure("PLAN_STALE", "A remote precondition changed before backup.", { nextAction: "inspect_target" });
    await append(writer, limits, "apply", "BACKUP_INTENT", { i: file.index }, operation);
    row = writer.metadata.state.files[file.index];
    await writer.createBackup({ fileIndex: file.index, expectedBytes: file.before.bytes,
      expectedSha256: file.before.sha256, mode: file.before.mode,
      read: (sink) => adapter.downloadStream(target, sink, file.before.bytes, { identity: observed.identity ?? expected }),
    });
    await append(writer, limits, "apply", "BACKUP_READY", { i: file.index }, operation);
    return;
  }
  // A crash can durably sync the backup before BACKUP_READY. Prove the exact
  // reserved blob and only then advance the journal.
  let backup;
  try {
    backup = await writer.openVerifiedBackup(file.index, { expectedBytes: file.before.bytes,
      expectedSha256: file.before.sha256, mode: file.before.mode });
    await backup.revalidate();
  } catch {
    throw new DurableFailure("RECONCILIATION_REQUIRED", "A backup intent has no complete verified backup.", {
      nextAction: "offline_recovery",
    });
  } finally { await backup?.close().catch(() => {}); }
  await append(writer, limits, "apply", "BACKUP_READY", { i: file.index }, operation);
}

async function reconcileApplyAttempt({ writer, adapter, server, plan, file, operation, limits, attempt }) {
  const { a, value } = attempt;
  const target = remotePath(server, file), temporary = temporaryPath(target, value.token);
  const expected = { bytes: file.bytes, sha256: file.sha256 };
  const staged = await adapter.inspectFile(temporary, { maxBytes: file.bytes });
  const final = await observe(adapter, server, plan, file);
  if (value.phase === "INTENT") {
    if (staged.type === "absent") {
      await append(writer, limits, "apply", "ATTEMPT_ABANDONED", { i: file.index, a }, operation);
      return false;
    }
    if (!matchesStaged(staged, expected, plan, file)) {
      throw new DurableFailure("RECONCILIATION_REQUIRED", "A durable staging file no longer matches its journaled content.", {
        nextAction: "offline_recovery",
      });
    }
    await append(writer, limits, "apply", "STAGED", { i: file.index, a, mode: file.desiredMode }, operation);
    return false;
  }
  if (value.phase === "STAGED") {
    if (!matchesStaged(staged, expected, plan, file) || !matchesBefore(final, plan, file)) {
      throw new DurableFailure("PLAN_STALE", "A target changed before durable promotion.", { nextAction: "inspect_target" });
    }
    await append(writer, limits, "apply", "PROMOTING", { i: file.index, a }, operation);
    return false;
  }
  if (value.phase === "PROMOTING") {
    if (matchesDesired(final, plan, file)) {
      await append(writer, limits, "apply", "SATISFIED_UNOWNED", { i: file.index, a }, operation);
      return true;
    }
    if (!matchesStaged(staged, expected, plan, file) || !matchesBefore(final, plan, file)) {
      throw new DurableFailure("RECONCILIATION_REQUIRED", "Promotion ownership cannot be proven after interruption.", {
        nextAction: "offline_recovery",
      });
    }
    const promoted = await promoteVerifiedStage({ adapter, temporary, target, mode: file.desiredMode,
      identity: staged.identity ?? expectedIdentity(plan, file, temporary, { ...expected, mode: file.desiredMode }), operation });
    await append(writer, limits, "apply", promoted.proof === "ack" ? "APPLIED" : "SATISFIED_UNOWNED", { i: file.index, a }, operation);
    return true;
  }
  return ["PROMOTED", "SATISFIED"].includes(value.phase);
}

async function applyFile({ writer, adapter, server, plan, file, operation, limits, local }) {
  let row = writer.metadata.state.files[file.index];
  if (row.state !== "PENDING") return;
  if (unchanged(file)) {
    const current = await observe(adapter, server, plan, file, file.bytes);
    if (!matchesDesired(current, plan, file)) throw new DurableFailure("PLAN_STALE", "An unchanged target drifted after planning.", { nextAction: "inspect_target" });
    await append(writer, limits, "apply", "SKIP", { i: file.index }, operation);
    return;
  }
  while (true) {
    row = writer.metadata.state.files[file.index];
    const current = activeAttempt(row.apply);
    if (!current || ["ABANDONED"].includes(current.value.phase)) break;
    if (await reconcileApplyAttempt({ writer, adapter, server, plan, file, operation, limits, attempt: current })) return;
  }
  row = writer.metadata.state.files[file.index];
  if (row.state !== "PENDING") return;
  const a = nextAttempt(row.apply), value = token();
  const target = remotePath(server, file), temporary = temporaryPath(target, value);
  const source = await verifyLocal(server, file, operation, local);
  const before = await observe(adapter, server, plan, file);
  if (!matchesBefore(before, plan, file)) throw new DurableFailure("PLAN_STALE", "A target changed before staging.", { nextAction: "inspect_target" });
  await append(writer, limits, "apply", "STAGE_INTENT", { i: file.index, a, token: value }, operation);
  revalidateCanonicalLocalRoot(local.pin, { serverAlias: local.serverAlias, relativePath: file.localPath });
  const staged = await stageVerifiedSource({ adapter, source, temporary,
    expected: { bytes: file.bytes, sha256: file.sha256 }, operation });
  await append(writer, limits, "apply", "STAGED", { i: file.index, a, mode: file.desiredMode }, operation);
  await verifyLocal(server, file, operation, local);
  const final = await observe(adapter, server, plan, file);
  if (!matchesBefore(final, plan, file)) {
    throw new DurableFailure("PLAN_STALE", "A target changed before promotion.", { nextAction: "inspect_target", effects: "possible" });
  }
  await append(writer, limits, "apply", "PROMOTING", { i: file.index, a }, operation);
  const promoted = await promoteVerifiedStage({ adapter, temporary, target, mode: file.desiredMode,
    identity: staged.identity, operation });
  await append(writer, limits, "apply", promoted.proof === "ack" ? "APPLIED" : "SATISFIED_UNOWNED", { i: file.index, a }, operation);
}

async function executeApply({ writer, adapter, server, plan, operation, limits, local }) {
  for (const file of plan.files) await backupFile({ writer, adapter, server, plan, file, operation, limits });
  for (const file of plan.files) {
    await applyFile({ writer, adapter, server, plan, file, operation, limits, local });
    operation.progress();
  }
  if (writer.metadata.state.phase === "APPLYING" && writer.metadata.state.files.every((row) => ["APPLIED", "SKIPPED", "SATISFIED_UNOWNED"].includes(row.state))) {
    await append(writer, limits, "apply", "APPLY_COMPLETE", {}, operation);
  }
}

async function backupReadable(backup) {
  async function* chunks() {
    let position = 0;
    while (position < backup.bytes) {
      const buffer = Buffer.alloc(Math.min(65536, backup.bytes - position));
      const { bytesRead } = await backup.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  }
  return Readable.from(chunks());
}

async function stageBackup({ writer, adapter, plan, file, temporary, operation }) {
  const expected = { bytes: file.before.bytes, sha256: file.before.sha256 };
  const backup = await writer.openVerifiedBackup(file.index, { expectedBytes: expected.bytes,
    expectedSha256: expected.sha256, mode: file.before.mode });
  let readable, owned = false, identity;
  try {
    await backup.revalidate();
    readable = await backupReadable(backup);
    const staged = await adapter.uploadStream(readable, temporary, expected, { staged: true, createParents: false,
      onOwned(value) { owned = true; identity = value; },
    });
    const observed = await adapter.inspectFile(temporary, { maxBytes: expected.bytes });
    if (!matchesStaged(observed, expected, plan, file)) {
      throw new DurableFailure("ROLLBACK_CONFLICT", "A recovery staging file could not be verified.", { nextAction: "offline_recovery", effects: "possible" });
    }
    await backup.revalidate();
    return { ...observed, mode: staged?.mode, identity: observed.identity ?? identity };
  } catch (error) {
    if (owned && identity?.sha256) await cleanupVerifiedStage({ adapter, temporary, expected, identity, operation }).catch(() => {});
    throw error;
  } finally {
    readable?.destroy();
    await backup.close().catch(() => {});
  }
}

async function rollbackAbsent({ writer, adapter, server, plan, file, operation, limits }) {
  const row = writer.metadata.state.files[file.index];
  const active = activeAttempt(row.recovery);
  let a = active?.a;
  if (!active) {
    const current = await observe(adapter, server, plan, file, file.bytes);
    if (!matchesDesired(current, plan, file)) throw new DurableFailure("ROLLBACK_CONFLICT", "The applied target changed before removal.", { nextAction: "inspect_target" });
    a = nextAttempt(row.recovery);
    await append(writer, limits, "recovery", "REMOVE_INTENT", { i: file.index, a }, operation);
  } else if (active.value.phase === "REMOVED") return;
  const target = remotePath(server, file);
  const current = await observe(adapter, server, plan, file, file.bytes);
  if (current.type === "absent") {
    await append(writer, limits, "recovery", "REMOVED", { i: file.index, a }, operation);
    return;
  }
  if (!matchesDesired(current, plan, file)) throw new DurableFailure("ROLLBACK_CONFLICT", "The applied target changed before removal.", { nextAction: "inspect_target" });
  try { await adapter.deleteFile(target, { identity: current.identity ?? expectedIdentity(plan, file, target, file) }); }
  catch (error) {
    const after = await observe(adapter, server, plan, file, file.bytes).catch(() => null);
    if (after?.type !== "absent") throw error;
  }
  operation.check();
  await append(writer, limits, "recovery", "REMOVED", { i: file.index, a }, operation);
}

async function reconcileRestore({ writer, adapter, server, plan, file, operation, limits, attempt }) {
  const { a, value } = attempt;
  const target = remotePath(server, file), temporary = temporaryPath(target, value.token);
  const staged = await adapter.inspectFile(temporary, { maxBytes: file.before.bytes });
  const final = await observe(adapter, server, plan, file);
  if (value.phase === "INTENT") {
    if (staged.type === "absent") {
      await append(writer, limits, "recovery", "RECOVERY_ATTEMPT_ABANDONED", { i: file.index, a }, operation);
      return false;
    }
    if (!matchesStaged(staged, file.before, plan, file)) throw new DurableFailure("RECONCILIATION_REQUIRED", "A recovery staging file changed.", { nextAction: "offline_recovery" });
    await append(writer, limits, "recovery", "RESTORE_STAGED", { i: file.index, a, mode: file.before.mode }, operation);
    return false;
  }
  if (value.phase === "STAGED") {
    if (!matchesStaged(staged, file.before, plan, file) || !matchesDesired(final, plan, file)) throw new DurableFailure("ROLLBACK_CONFLICT", "The target changed before recovery promotion.", { nextAction: "inspect_target" });
    await append(writer, limits, "recovery", "RESTORING", { i: file.index, a }, operation);
    return false;
  }
  if (value.phase === "RESTORING") {
    if (matchesBefore(final, plan, file)) {
      await append(writer, limits, "recovery", "RESTORED", { i: file.index, a, proof: "observed" }, operation);
      return true;
    }
    if (!matchesStaged(staged, file.before, plan, file) || !matchesDesired(final, plan, file)) throw new DurableFailure("RECONCILIATION_REQUIRED", "Recovery ownership cannot be proven after interruption.", { nextAction: "offline_recovery" });
    const promoted = await promoteVerifiedStage({ adapter, temporary, target, mode: file.before.mode,
      identity: staged.identity ?? expectedIdentity(plan, file, temporary, file.before), operation });
    await append(writer, limits, "recovery", "RESTORED", { i: file.index, a, proof: promoted.proof }, operation);
    return true;
  }
  return value.phase === "RESTORED";
}

async function rollbackExisting({ writer, adapter, server, plan, file, operation, limits }) {
  let row = writer.metadata.state.files[file.index];
  while (true) {
    const current = activeAttempt(row.recovery);
    if (!current || current.value.phase === "ABANDONED") break;
    if (await reconcileRestore({ writer, adapter, server, plan, file, operation, limits, attempt: current })) return;
    row = writer.metadata.state.files[file.index];
  }
  const final = await observe(adapter, server, plan, file);
  if (!matchesDesired(final, plan, file)) throw new DurableFailure("ROLLBACK_CONFLICT", "The applied target changed before recovery.", { nextAction: "inspect_target" });
  const a = nextAttempt(row.recovery), value = token();
  const target = remotePath(server, file), temporary = temporaryPath(target, value);
  await append(writer, limits, "recovery", "RESTORE_INTENT", { i: file.index, a, token: value }, operation);
  const staged = await stageBackup({ writer, adapter, plan, file, temporary, operation });
  await append(writer, limits, "recovery", "RESTORE_STAGED", { i: file.index, a, mode: file.before.mode }, operation);
  const current = await observe(adapter, server, plan, file);
  if (!matchesDesired(current, plan, file)) throw new DurableFailure("ROLLBACK_CONFLICT", "The target changed before recovery promotion.", { nextAction: "inspect_target", effects: "possible" });
  await append(writer, limits, "recovery", "RESTORING", { i: file.index, a }, operation);
  const promoted = await promoteVerifiedStage({ adapter, temporary, target, mode: file.before.mode, identity: staged.identity, operation });
  await append(writer, limits, "recovery", "RESTORED", { i: file.index, a, proof: promoted.proof }, operation);
}

async function executeRollback({ writer, adapter, server, plan, operation, limits }) {
  if (writer.metadata.state.phase !== "ROLLING_BACK") await append(writer, limits, "recovery", "ROLLBACK_START", {}, operation);
  for (let index = plan.files.length - 1; index >= 0; index--) {
    const row = writer.metadata.state.files[index];
    if (row.state !== "APPLIED") continue;
    const file = plan.files[index];
    if (file.before.kind === "absent") await rollbackAbsent({ writer, adapter, server, plan, file, operation, limits });
    else await rollbackExisting({ writer, adapter, server, plan, file, operation, limits });
    operation.progress();
  }
  if (writer.metadata.state.phase === "ROLLING_BACK" && writer.metadata.state.files.every((row) => row.state !== "APPLIED")) {
    await append(writer, limits, "recovery", "ROLLBACK_COMPLETE", {}, operation);
  }
}

function isTerminal(kind, phase) {
  return kind === "apply"
    ? ["COMPLETED", "COMPLETED_WITH_WARNINGS", "ROLLED_BACK", "ROLLBACK_WITH_WARNINGS"].includes(phase)
    : ["ROLLED_BACK", "ROLLBACK_WITH_WARNINGS"].includes(phase);
}

function requireWritableServer(name, server) {
  if (server.readOnly) {
    throw new DurableFailure("READ_ONLY", `Server ${name} is configured read-only.`, { nextAction: "fix_config" });
  }
}

function journalFailureObservation(plan, writer, operationId, failure) {
  if (!plan || !writer) return { operationId };
  const state = writer.metadata.state;
  let completedFiles = 0, completedBytes = 0, rolledBackFiles = 0, remainingAppliedFiles = 0;
  for (const [index, row] of state.files.entries()) {
    if (["APPLIED", "SATISFIED_UNOWNED"].includes(row.state)) {
      completedFiles++;
      completedBytes += plan.files[index].bytes;
    }
    if (row.state === "ROLLED_BACK") rolledBackFiles++;
    if (row.state === "APPLIED") remainingAppliedFiles++;
  }
  let conflictIndex = null;
  if (["PLAN_STALE", "ROLLBACK_CONFLICT", "RECONCILIATION_REQUIRED", "TARGET_CHANGED"].includes(failure?.code)) {
    conflictIndex = state.phase === "ROLLING_BACK"
      ? state.files.findLastIndex((row) => row.state === "APPLIED")
      : state.files.findIndex((row) => row.state === "PENDING");
    if (conflictIndex < 0) conflictIndex = null;
  }
  return {
    operationId,
    phase: state.phase.toLowerCase(),
    partial: { completed_files: completedFiles, completed_bytes: completedBytes, rolled_back_files: rolledBackFiles,
      remaining_applied_files: remainingAppliedFiles, conflict_index: conflictIndex },
  };
}

async function resultFromStore({ store, durable, operationId, securityWarning, kind, outcome }) {
  const status = await statusFromStore({ store, durable, input: { operation_id: operationId, offset: 0, limit: 1 } });
  const common = {
    schema_version: 1, outcome, plan_id: status.plan_id, operation_id: operationId, server: status.server,
    phase: status.phase, complete: status.complete, needs_reconciliation: status.needs_reconciliation,
    counts: status.counts, apply_bytes_charged: status.apply_bytes_charged,
    recovery_bytes_charged: status.recovery_bytes_charged, temporary_warnings: status.temporary_warnings,
    guarantees: Guarantees, security_warning: securityWarning,
  };
  return (kind === "apply" ? ApplyOutputSchema : RollbackOutputSchema).parse(common);
}

async function closeAdapter(adapter, prior) {
  if (!adapter) return prior;
  try { await adapter.close(); return prior; }
  catch (error) { return prior ?? error; }
}

export async function planDurableDeployment({ loaded, input, operation, openAdapter, fault, now = Date.now() }) {
  const { name, server } = resolveServer(loaded, input.server);
  const state = await openDurableState({ loaded, signal: operation.signal, create: true, fault });
  let failure, built;
  try {
    const endpoint = endpointLockHash(name, state.durable.stateLimits);
    built = await operation.lock([remoteLockKey(server), durableLockKey(state.durable.stateDir, name)], () =>
      state.store.withEndpointLock(endpoint, async () => {
        let adapter;
        try {
          adapter = await connectOperation(openAdapter, server, operation);
          built = await publishDeploymentPlan({ store: state.store, loaded, input, adapter, operation, now });
          return built;
        } catch (error) { failure = error; }
        finally { failure = await closeAdapter(adapter, failure); }
        throw failure;
      }));
  } catch (error) { failure ??= error; }
  try { await state.close(); } catch (error) { failure ??= error; }
  if (failure) throw enrichDurableFailure(asDurableFailure(failure), { planId: built?.output?.plan_id ?? null });
  return built;
}

export async function applyDurableDeployment({ loaded, input, operation, openAdapter, fault, now = Date.now() }) {
  const state = await openDurableState({ loaded, signal: operation.signal, create: true, fault });
  let failure, output, failurePlan, failureWriter, failureOperationId;
  try {
    const initial = await snapshot(state.store, state.durable, { planId: input.plan_id });
    const keyHash = idempotencyKeyHash({ domainId: state.store.metadata.domainId, key: input.idempotency_key });
    if (initial.claim && initial.claim.keyHash !== keyHash) throw new DurableFailure("IDEMPOTENCY_CONFLICT", "The plan is already bound to a different idempotency key.", { nextAction: "status" });
    if (!initial.claim && now >= initial.plan.expiresAt) {
      throw new DurableFailure("PLAN_EXPIRED", "The durable plan expired before it was claimed.", { nextAction: "fix_input" });
    }
    failurePlan = initial.plan;
    failureOperationId = initial.claim?.operationId ?? `op_${randomUUID()}`;
    const terminal = initial.claim && isTerminal("apply", initial.journalMetadata?.state?.phase);
    let name, server;
    if (!terminal) {
      ({ name, server } = resolveServer(loaded, initial.plan.serverAlias));
      if (name !== initial.plan.serverAlias) throw new DurableFailure("PLAN_STALE", "The planned server alias is no longer configured.", { nextAction: "fix_config" });
      operation.shortenTimeout(server.operationTimeoutMs);
      operation.check();
      requireWritableServer(name, server);
    }
    const seeded = confirmationSeed(operation, { operationId: initial.claim?.operationId ?? `op_${randomUUID()}`,
      expiresAt: confirmationExpiry(initial.plan, Boolean(initial.claim), now) });
    const expected = { v: 1, action: "apply", planId: input.plan_id, operationId: initial.claim?.operationId ?? seeded.operationId,
      planDigest: initial.planDigest, keyHash, resume: input.resume, journalSeq: initial.journalSeq, expiresAt: seeded.expiresAt };
    failureOperationId = expected.operationId;
    const confirmation = await requireConfirmation({ operation, expected, currentJournalSeq: initial.journalSeq, now,
      message: `Confirm durable deployment ${input.plan_id}.` });
    if (confirmation) { await state.close(); return confirmation; }
    if (terminal) {
      output = await resultFromStore({ store: state.store, durable: state.durable, operationId: initial.claim.operationId,
        securityWarning: initial.plan.securityWarning, kind: "apply", outcome: "already_terminal" });
    } else {

      const endpoint = endpointLockHash(name, state.durable.stateLimits);
      output = await operation.lock([remoteLockKey(server), durableLockKey(state.durable.stateDir, name)], () =>
        state.store.withEndpointLock(endpoint, async () => {
          const current = await snapshot(state.store, state.durable, { planId: input.plan_id });
          failurePlan = current.plan;
          const refreshed = await requireConfirmation({ operation, expected, currentJournalSeq: current.journalSeq, now: Date.now(),
            message: `Confirm durable deployment ${input.plan_id}.` });
          if (refreshed) return refreshed;
          if (current.planDigest !== expected.planDigest) throw new DurableFailure("PLAN_STALE", "The durable plan changed.", { nextAction: "status" });
          const identity = offlineIdentity({ serverAlias: name, server, plan: current.plan, durable: state.durable });
          if (!current.claim && Date.now() >= current.plan.expiresAt) throw new DurableFailure("PLAN_EXPIRED", "The durable plan expired before it was claimed.", { nextAction: "fix_input" });
          const limits = limitsFor(server, state.durable), policy = createWorkflowPolicy(current.plan, limits);
          const claimInput = { planId: input.plan_id, keyHash, targetHash: identity.targetHash,
            reservation: reservationFor(current.plan, limits), operationId: expected.operationId,
            initialEvent: event("apply", "INIT", { planDigest: current.planDigest, fileCount: current.plan.files.length }),
            validateEvent: policy.validateEvent, reduce: policy.reduce };
          let claim;
          if (current.claim) {
            claim = await state.store.claim(claimInput);
          } else {
            operation.dispatch();
            claim = await state.store.claim(claimInput);
            operation.confirm();
          }
          failureOperationId = claim.operationId;
          if (claim.operationId !== expected.operationId || claim.keyHash !== keyHash || claim.targetHash !== identity.targetHash) {
            throw new DurableFailure("IDEMPOTENCY_CONFLICT", "The operation association conflicts with this request.", { nextAction: "status" });
          }
          let writer = await state.store.openJournal(claim.operationId, policy);
          failureWriter = writer;
          if (isTerminal("apply", writer.metadata.state.phase)) return resultFromStore({ store: state.store, durable: state.durable,
            operationId: claim.operationId, securityWarning: current.plan.securityWarning, kind: "apply", outcome: "already_terminal" });
          if (!input.resume) return resultFromStore({ store: state.store, durable: state.durable, operationId: claim.operationId,
            securityWarning: current.plan.securityWarning, kind: "apply", outcome: "status_only" });
          if (writer.metadata.state.phase !== "APPLYING") throw new DurableFailure("PLAN_CONSUMED", "The operation is already rolling back.", { nextAction: "status" });
          const sources = localContext({ serverAlias: name, server, plan: current.plan,
            domainId: state.store.metadata.domainId, durable: state.durable });
          await verifyAllLocal(server, current.plan, operation, sources);
          let adapter, error;
          try {
            adapter = await connectOperation(openAdapter, server, operation);
            const online = await onlineIdentity({ adapter, serverAlias: name, server, plan: current.plan, durable: state.durable });
            if (online.targetHash !== claim.targetHash) throw new DurableFailure("PLAN_STALE", "The connected deployment target changed.", { nextAction: "inspect_target" });
            operation.trackFiles(current.plan.files.length);
            await executeApply({ writer, adapter, server, plan: current.plan, operation, limits, local: sources });
          } catch (caught) { error = caught; }
          finally { error = await closeAdapter(adapter, error); }
          if (error) throw error;
          writer = await state.store.openJournal(claim.operationId, policy);
          failureWriter = writer;
          const phase = writer.metadata.state.phase;
          return resultFromStore({ store: state.store, durable: state.durable, operationId: claim.operationId,
            securityWarning: current.plan.securityWarning, kind: "apply",
            outcome: phase === "COMPLETED" ? "completed" : "completed_with_warnings" });
        }));
    }
  } catch (error) { failure = error; }
  try { await state.close(); } catch (error) { failure ??= error; }
  if (failure) throw enrichDurableFailure(failure,
    { planId: input.plan_id, ...journalFailureObservation(failurePlan, failureWriter, failureOperationId, failure) });
  return output;
}

export async function rollbackDurableDeployment({ loaded, input, operation, openAdapter, fault, now = Date.now() }) {
  const state = await openDurableState({ loaded, signal: operation.signal, create: false, fault });
  let failure, output, failurePlan, failurePlanId, failureWriter;
  try {
    const initial = await snapshot(state.store, state.durable, { operationId: input.operation_id });
    if (!initial.claim) throw new DurableFailure("PLAN_NOT_FOUND", "The durable operation was not found.", { nextAction: "fix_input" });
    failurePlan = initial.plan;
    failurePlanId = initial.planId;
    const terminal = isTerminal("rollback", initial.journalMetadata?.state?.phase);
    let name, server;
    if (!terminal) {
      ({ name, server } = resolveServer(loaded, initial.plan.serverAlias));
      if (name !== initial.plan.serverAlias) throw new DurableFailure("PLAN_NOT_FOUND", "The durable operation was not found.", { nextAction: "fix_input" });
      operation.shortenTimeout(server.operationTimeoutMs);
      operation.check();
      requireWritableServer(name, server);
    }
    const seeded = confirmationSeed(operation, { operationId: input.operation_id, expiresAt: confirmationExpiry(initial.plan, true, now) });
    const expected = { v: 1, action: "rollback", planId: initial.planId, operationId: input.operation_id,
      planDigest: initial.planDigest, keyHash: initial.claim.keyHash, resume: input.resume,
      journalSeq: initial.journalSeq, expiresAt: seeded.expiresAt };
    const confirmation = await requireConfirmation({ operation, expected, currentJournalSeq: initial.journalSeq, now,
      message: `Confirm rollback of durable operation ${input.operation_id}.` });
    if (confirmation) { await state.close(); return confirmation; }
    if (terminal) {
      output = await resultFromStore({ store: state.store, durable: state.durable, operationId: input.operation_id,
        securityWarning: initial.plan.securityWarning, kind: "rollback", outcome: "already_terminal" });
    } else {
      const endpoint = endpointLockHash(name, state.durable.stateLimits);
      output = await operation.lock([remoteLockKey(server), durableLockKey(state.durable.stateDir, name)], () =>
        state.store.withEndpointLock(endpoint, async () => {
          const current = await snapshot(state.store, state.durable, { operationId: input.operation_id });
          failurePlan = current.plan;
          failurePlanId = current.planId;
          const refreshed = await requireConfirmation({ operation, expected, currentJournalSeq: current.journalSeq, now: Date.now(),
            message: `Confirm rollback of durable operation ${input.operation_id}.` });
          if (refreshed) return refreshed;
          const identity = offlineIdentity({ serverAlias: name, server, plan: current.plan, durable: state.durable });
          if (identity.targetHash !== current.claim.targetHash) throw new DurableFailure("PLAN_STALE", "The configured deployment target changed.", { nextAction: "inspect_target" });
          const limits = limitsFor(server, state.durable), policy = createWorkflowPolicy(current.plan, limits);
          let writer = await state.store.openJournal(input.operation_id, policy);
          failureWriter = writer;
          if (isTerminal("rollback", writer.metadata.state.phase)) {
            return resultFromStore({ store: state.store, durable: state.durable, operationId: input.operation_id,
              securityWarning: current.plan.securityWarning, kind: "rollback", outcome: "already_terminal" });
          }
          if (!input.resume) return resultFromStore({ store: state.store, durable: state.durable, operationId: input.operation_id,
            securityWarning: current.plan.securityWarning, kind: "rollback", outcome: "status_only" });
          let adapter, error;
          try {
            adapter = await connectOperation(openAdapter, server, operation);
            const online = await onlineIdentity({ adapter, serverAlias: name, server, plan: current.plan, durable: state.durable });
            if (online.targetHash !== current.claim.targetHash) throw new DurableFailure("PLAN_STALE", "The connected deployment target changed.", { nextAction: "inspect_target" });
            await executeRollback({ writer, adapter, server, plan: current.plan, operation, limits });
          } catch (caught) { error = caught; }
          finally { error = await closeAdapter(adapter, error); }
          if (error) throw error;
          writer = await state.store.openJournal(input.operation_id, policy);
          failureWriter = writer;
          const phase = writer.metadata.state.phase;
          return resultFromStore({ store: state.store, durable: state.durable, operationId: input.operation_id,
            securityWarning: current.plan.securityWarning, kind: "rollback",
            outcome: phase === "ROLLED_BACK" ? "rolled_back" : "rolled_back_with_warnings" });
        }));
    }
  } catch (error) { failure = error; }
  try { await state.close(); } catch (error) { failure ??= error; }
  if (failure) throw enrichDurableFailure(failure,
    { planId: failurePlanId,
      ...journalFailureObservation(failurePlan, failureWriter, input.operation_id, failure) });
  return output;
}

export { durableLockKey };
