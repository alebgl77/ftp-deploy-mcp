import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  insecureWarningText,
  resolveServer,
  unsafeRemoteRootWarningText,
  unknownHostKeyWarningText,
} from "../config.js";
import { errorDetails, isAppError } from "../errors.js";
import { resolveLocalSource } from "../local-path.js";
import { relativeRemote, resolveRemote } from "../remote-path.js";
import { selectDeployFiles } from "../scanner.js";
import { checkDeploySelection, hashLocalFile } from "../transfers.js";
import { createWorkflowPolicy } from "../workflow/events.mjs";
import { decodePlan, encodePlan, unchanged } from "../workflow/model.mjs";
import { reservationFor } from "../workflow/budget.mjs";
import { Guarantees, PlanInputSchema, PlanOutputSchema } from "./schemas.js";
import { DurableFailure, asDurableFailure, canonicalTargetIdentity, enrichDurableFailure, localRootHash, openDurableState,
  pinSeparatedLocalRoot, revalidateCanonicalLocalRoot, workflowIdentity } from "./state.js";

const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function immutable(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function checkedInput(input) {
  const parsed = PlanInputSchema.safeParse(input);
  if (!parsed.success) throw new DurableFailure("INVALID_ARGUMENT", "The durable plan input is invalid.", { nextAction: "fix_input" });
  return parsed.data;
}

function planWarning(server) {
  const warnings = [insecureWarningText(server), unsafeRemoteRootWarningText(server), unknownHostKeyWarningText(server)].filter(Boolean);
  if (!warnings.length) return null;
  const value = warnings.join("\n\n");
  return Buffer.byteLength(value) <= 4096 ? value : `${Buffer.from(value).subarray(0, 4000).toString("utf8")}…`;
}

function localPlanningFailure(serverAlias, relativePath, reason) {
  const shown = typeof relativePath === "string" && relativePath.length <= 1024 && !relativePath.includes("\\") &&
    !path.posix.isAbsolute(relativePath) ? relativePath : ".";
  return new DurableFailure("PLAN_STALE", `Local source validation failed for server ${serverAlias} at ${shown} (${reason}).`, {
    nextAction: "fix_input",
  });
}

function resolvePlanningSource(serverAlias, server, relativePath, kind) {
  try { return resolveLocalSource(server, relativePath, kind); }
  catch { throw localPlanningFailure(serverAlias, relativePath, "unavailable"); }
}

async function observeRemote(adapter, remotePath, server, maxBytes, operation) {
  if (!adapter || typeof adapter.inspectFile !== "function") {
    throw new DurableFailure("WORKFLOW_UNSUPPORTED", "The adapter cannot inspect durable targets.", { nextAction: "inspect_target" });
  }
  try {
    operation?.check();
    const observed = await adapter.inspectFile(remotePath, { maxBytes });
    operation?.check();
    if (!observed || !["absent", "file"].includes(observed.type)) throw new Error("unsupported observation");
    if (observed.type === "absent" && server.protocol !== "sftp") {
      throw new DurableFailure("WORKFLOW_UNSUPPORTED", "FTP and FTPS durable plans can only replace regular files.", { nextAction: "inspect_target" });
    }
    return observed;
  } catch (error) {
    if (error instanceof DurableFailure) throw error;
    if (isAppError(error) && ["PATH_REJECTED", "NOT_FOUND"].includes(errorDetails(error).code)) {
      throw new DurableFailure("WORKFLOW_UNSUPPORTED", "The remote target is not a supported regular-file target.", { nextAction: "inspect_target" });
    }
    throw error;
  }
}

export async function buildDeploymentPlan({ loaded, input, adapter, operation, now = Date.now(), planId, domainId } = {}) {
  const args = checkedInput(input);
  if (!Number.isSafeInteger(now) || now < 0) throw new DurableFailure("INVALID_ARGUMENT", "The plan clock is invalid.", { nextAction: "fix_input" });
  try {
    const durable = loaded?.config ? {
      enabled: loaded.config.stateDir !== undefined,
      stateDir: loaded.config.stateDir,
      requirePlan: loaded.config.requirePlan,
      stateLimits: loaded.config.stateLimits,
    } : loaded;
    if (!durable?.enabled) throw new DurableFailure("DURABLE_STATE_DISABLED", "Durable state is disabled.", { nextAction: "fix_config" });
    const { name: serverAlias, server } = resolveServer(loaded, args.server);
    operation?.check();
    const rootPin = pinSeparatedLocalRoot(server.localRoot, { serverAlias, stateDir: durable.stateDir });
    revalidateCanonicalLocalRoot(rootPin, { serverAlias });
    const source = resolvePlanningSource(serverAlias, server, args.local_dir, "directory");
    const remoteBase = resolveRemote(server.root, args.remote_dir ?? "");
    const selected = await selectDeployFiles(source.path, args.include, args.exclude, server, operation);
    revalidateCanonicalLocalRoot(rootPin, { serverAlias, relativePath: args.local_dir });
    checkDeploySelection(selected, server);
    if (selected.length > durable.stateLimits.maxPlanFiles) {
      throw new DurableFailure("DURABLE_STATE_LIMIT", "The durable plan file limit was exceeded.", { nextAction: "fix_config" });
    }
    if (!selected.length) {
      throw new DurableFailure("WORKFLOW_UNSUPPORTED", "A durable plan must contain at least one regular file.", { nextAction: "fix_input" });
    }

    const candidates = selected.map((file) => {
      const remoteAbsolute = resolveRemote(server.root, path.posix.join(relativeRemote(server.root, remoteBase), file.rel));
      return { ...file, remoteAbsolute, remotePath: relativeRemote(server.root, remoteAbsolute) };
    }).sort((left, right) => binaryCompare(left.remotePath, right.remotePath));

    const files = [];
    let totalBytes = 0;
    let observedRemoteBytes = 0;
    let backupBytes = 0;
    let canonicalRemoteRoot = null;
    for (const [index, candidate] of candidates.entries()) {
      operation?.check();
      revalidateCanonicalLocalRoot(rootPin, { serverAlias, relativePath: candidate.rel });
      const relativeLocal = path.relative(rootPin.canonicalPath, candidate.abs).replaceAll("\\", "/");
      if (!relativeLocal || relativeLocal.startsWith("../") || path.posix.isAbsolute(relativeLocal)) {
        throw new DurableFailure("PLAN_STALE", `Local source validation failed for server ${serverAlias} at ${candidate.rel} (outside root).`, { nextAction: "fix_input" });
      }
      const verified = resolvePlanningSource(serverAlias, server, relativeLocal, "file");
      const remaining = server.maxDeployBytes - totalBytes;
      if (remaining < 0) throw new DurableFailure("TRANSFER_LIMIT", "The deployment byte limit was exceeded.", { nextAction: "fix_config" });
      let local;
      try { local = await hashLocalFile(verified.path, Math.min(server.maxTransferBytes, remaining), operation); }
      catch (error) {
        if (isAppError(error) && errorDetails(error).code === "TRANSFER_LIMIT") throw error;
        throw localPlanningFailure(serverAlias, relativeLocal, "changed");
      }
      revalidateCanonicalLocalRoot(rootPin, { serverAlias, relativePath: relativeLocal });
      totalBytes += local.bytes;
      const remoteRemaining = server.maxDeployBytes - observedRemoteBytes;
      if (remoteRemaining < 0) throw new DurableFailure("TRANSFER_LIMIT", "The remote observation byte limit was exceeded.", { nextAction: "fix_config" });
      const observed = await observeRemote(adapter, candidate.remoteAbsolute, server,
        Math.min(server.maxTransferBytes, remoteRemaining), operation);
      if (observed.type === "file") observedRemoteBytes += observed.bytes;
      if (server.protocol === "sftp") {
        if (canonicalRemoteRoot === null) canonicalRemoteRoot = observed.canonicalRoot;
        else if (canonicalRemoteRoot !== observed.canonicalRoot) {
          throw new DurableFailure("PLAN_STALE", "The canonical SFTP root changed while planning.", { nextAction: "inspect_target" });
        }
      }
      const before = observed.type === "absent" ? { kind: "absent" } : {
        kind: "file",
        bytes: observed.bytes,
        sha256: observed.sha256,
        mode: server.protocol === "sftp" ? observed.mode : null,
      };
      const desiredMode = server.protocol === "sftp" ? (observed.type === "file" ? observed.mode : 0o644) : null;
      const entry = {
        index,
        localPath: relativeLocal,
        remotePath: candidate.remotePath,
        bytes: local.bytes,
        sha256: local.sha256,
        before,
        parent: observed.parent,
        desiredMode,
      };
      if (observed.type === "file" && !unchanged(entry)) {
        if (observed.bytes > server.maxDeployBytes - backupBytes) {
          throw new DurableFailure("TRANSFER_LIMIT", "The recovery byte limit was exceeded.", { nextAction: "fix_config" });
        }
        backupBytes += observed.bytes;
      }
      files.push(entry);
    }

    const target = canonicalTargetIdentity({ serverAlias, server,
      canonicalRemoteRoot: server.protocol === "sftp" ? canonicalRemoteRoot : null });
    const identity = workflowIdentity({ serverAlias, server, target, durable });
    const sourceIdentity = { localRootHash: localRootHash({ domainId, canonicalPath: rootPin.canonicalPath,
      stateLimits: durable.stateLimits }) };
    const createdAt = now;
    const expiresAt = createdAt + args.ttl_seconds * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw new DurableFailure("INVALID_ARGUMENT", "The plan expiry is invalid.", { nextAction: "fix_input" });
    const id = planId ?? `pln_${randomUUID()}`;
    const securityWarning = planWarning(server);
    const bytes = encodePlan({ v: 2, createdAt, expiresAt, serverAlias, source: sourceIdentity,
      target, policyHash: identity.policyHash, securityWarning, files }, identity.limits);
    const plan = decodePlan(bytes, identity.limits);
    // These calls are required pre-publication proofs, not deferred apply work.
    const policy = createWorkflowPolicy(plan, identity.limits);
    const reservation = reservationFor(plan, identity.limits);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const unchangedFiles = files.filter(unchanged).length;
    const newFiles = files.filter((file) => file.before.kind === "absent").length;
    const output = immutable(PlanOutputSchema.parse({
      schema_version: 1,
      phase: "planned",
      plan_id: id,
      plan_digest: digest,
      server: serverAlias,
      protocol: server.protocol,
      created_at_ms: createdAt,
      expires_at_ms: expiresAt,
      total_files: files.length,
      total_bytes: totalBytes,
      unchanged_files: unchangedFiles,
      new_files: newFiles,
      replaced_files: files.filter((file) => file.before.kind === "file" && !unchanged(file)).length,
      backup_bytes: backupBytes,
      requires_confirmation: true,
      guarantees: Guarantees,
      security_warning: securityWarning,
    }));
    return Object.freeze({ plan, bytes, output, policy, reservation, targetHash: identity.targetHash, limits: identity.limits });
  } catch (error) {
    throw asDurableFailure(error);
  }
}

export async function publishDeploymentPlan({ store, ...options } = {}) {
  const built = await buildDeploymentPlan({ ...options, domainId: store?.metadata?.domainId });
  try {
    await store.publishPlan(built.output.plan_id, built.bytes, {
      onDispatch: () => options.operation?.dispatch?.(),
      onPublished: () => options.operation?.confirm?.(),
    });
    options.operation?.confirm?.();
  } catch (error) {
    throw enrichDurableFailure(asDurableFailure(error), { planId: built.output.plan_id });
  }
  return built;
}

export async function createDeploymentPlan(options = {}) {
  const state = await openDurableState({ loaded: options.loaded, signal: options.operation?.signal, create: true, fault: options.fault });
  let result;
  let failure;
  try { result = await publishDeploymentPlan({ ...options, store: state.store }); }
  catch (error) { failure = error; }
  try { await state.close(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
  return result;
}
