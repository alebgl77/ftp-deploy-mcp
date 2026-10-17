import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { resolveDurableConfig } from "../config.js";
import { errorDetails, isAppError, renderError } from "../errors.js";
import { normalizeRoot } from "../remote-path.js";
import { openStateStore, StateError } from "../state/index.mjs";
import { encode } from "../state/codec.mjs";
import { policyFingerprint } from "../workflow/model.mjs";
import { DurableErrorResultSchema } from "./schemas.js";

const activeSignals = new WeakSet();
const durableDetails = new WeakMap();
const WINDOWS_ACL_WARNING = "State directory ACLs were not verified on Windows.";

export class DurableFailure extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "DurableFailure";
    durableDetails.set(this, Object.freeze({ code, message, retryable: options.retryable === true,
      nextAction: options.nextAction ?? "none", effects: options.effects ?? "none",
      phase: options.phase ?? null, partial: options.partial ?? null,
      planId: options.planId ?? null, operationId: options.operationId ?? null }));
  }
  get code() { return durableDetails.get(this).code; }
}

export function isDurableFailure(error) { return durableDetails.has(error); }

function stateFailure(error) {
  if (isDurableFailure(error)) return error;
  if (!(error instanceof StateError)) {
    if (isAppError(error)) {
      const detail = errorDetails(error);
      return new DurableFailure(detail.code, renderError(error), {
        retryable: ["TIMEOUT", "TRANSPORT_ERROR"].includes(detail.code),
        nextAction: detail.code === "CONFIG_INVALID" || detail.code === "CONFIG_REQUIRED" ? "fix_config" :
          detail.code === "TARGET_CHANGED" ? "inspect_target" : "fix_input",
      });
    }
    return new DurableFailure("INTERNAL_ERROR", "The durable workflow failed safely.", { nextAction: "none" });
  }
  if (error.code === "STATE_DISABLED") {
    return new DurableFailure("DURABLE_STATE_DISABLED", "Durable state is disabled.", { nextAction: "fix_config" });
  }
  if (error.code === "STATE_BUSY") {
    return new DurableFailure("DURABLE_STATE_BUSY", "Durable state is busy.", { retryable: true, nextAction: "retry" });
  }
  if (error.code === "STATE_LIMIT") {
    return new DurableFailure("DURABLE_STATE_LIMIT", "A durable state limit was reached.", { nextAction: "fix_config" });
  }
  if (error.code === "STATE_CORRUPT") {
    return new DurableFailure("DURABLE_STATE_CORRUPT", "Durable state validation failed.", { nextAction: "offline_recovery" });
  }
  if (error.code === "STATE_IO") {
    return new DurableFailure("DURABLE_STATE_IO", "Durable state I/O failed.", { retryable: true, nextAction: "retry" });
  }
  if (error.code === "STATE_UNSUPPORTED") {
    return new DurableFailure("DURABLE_STATE_UNSUPPORTED", "Durable state version 1 is unsupported; reinitialize the state directory offline before retrying.", {
      nextAction: "offline_recovery",
    });
  }
  if (error.code === "STATE_CONFLICT") {
    const missing = error.stage === "plan_missing" || error.stage === "operation_missing";
    return new DurableFailure(missing ? "PLAN_NOT_FOUND" : "IDEMPOTENCY_CONFLICT",
      missing ? "The durable plan or operation was not found." : "Durable state already contains a conflicting record.",
      { nextAction: missing ? "fix_input" : "status" });
  }
  if (error.code === "STATE_INVALID" && error.stage === "domain_uninitialized") {
    return new DurableFailure("PLAN_NOT_FOUND", "The durable plan or operation was not found.", { nextAction: "fix_input" });
  }
  return new DurableFailure("DURABLE_STATE_CORRUPT", "Durable state input was invalid.", { nextAction: "fix_config" });
}

export function asDurableFailure(error) { return stateFailure(error); }

const EFFECT_RANK = Object.freeze({ none: 0, possible: 1, confirmed: 2 });

function strongestEffect(...values) {
  return values.reduce((best, value) => EFFECT_RANK[value] > EFFECT_RANK[best] ? value : best, "none");
}

function partialProjection(value) {
  if (!value || typeof value !== "object") return null;
  return {
    completed_files: Number.isSafeInteger(value.completed_files) && value.completed_files >= 0 ? value.completed_files : 0,
    completed_bytes: Number.isSafeInteger(value.completed_bytes) && value.completed_bytes >= 0 ? value.completed_bytes : 0,
    rolled_back_files: Number.isSafeInteger(value.rolled_back_files) && value.rolled_back_files >= 0 ? value.rolled_back_files : 0,
    remaining_applied_files: Number.isSafeInteger(value.remaining_applied_files) && value.remaining_applied_files >= 0 ? value.remaining_applied_files : 0,
    conflict_index: Number.isSafeInteger(value.conflict_index) && value.conflict_index >= 0 ? value.conflict_index : null,
  };
}

function mergePartial(...values) {
  const captured = values.map(partialProjection).filter(Boolean);
  if (!captured.length) return null;
  return {
    completed_files: Math.max(...captured.map((value) => value.completed_files)),
    completed_bytes: Math.max(...captured.map((value) => value.completed_bytes)),
    rolled_back_files: Math.max(...captured.map((value) => value.rolled_back_files)),
    remaining_applied_files: Math.max(...captured.map((value) => value.remaining_applied_files)),
    conflict_index: captured.find((value) => value.conflict_index !== null)?.conflict_index ?? null,
  };
}

export function enrichDurableFailure(error, observation = {}) {
  const failure = stateFailure(error);
  const detail = durableDetails.get(failure);
  return new DurableFailure(detail.code, detail.message, {
    ...detail,
    effects: strongestEffect(detail.effects, observation.effects),
    phase: observation.phase ?? detail.phase,
    partial: mergePartial(detail.partial, observation.partial),
    planId: observation.planId ?? detail.planId,
    operationId: observation.operationId ?? detail.operationId,
  });
}

export function projectDurableError(error, { requestId = randomUUID(), planId = null, operationId = null,
  operationSnapshot = null } = {}) {
  const failure = stateFailure(error);
  const detail = durableDetails.get(failure);
  const effects = strongestEffect(detail.effects, operationSnapshot?.effects);
  const partial = mergePartial(detail.partial, operationSnapshot?.partial);
  return DurableErrorResultSchema.parse({ error: {
    schema_version: 1,
    code: detail.code,
    message: detail.message,
    retryable: detail.retryable,
    request_id: requestId,
    plan_id: planId ?? detail.planId,
    operation_id: operationId ?? detail.operationId,
    next_action: detail.nextAction,
    effects,
    phase: detail.phase,
    partial,
  } });
}

function localSourceFailure(serverAlias, relativePath, reason) {
  const safeAlias = typeof serverAlias === "string" && serverAlias.length <= 1024 ? serverAlias : "configured server";
  const safeRelative = typeof relativePath === "string" && relativePath.length <= 1024 &&
    !relativePath.includes("\\") && !path.posix.isAbsolute(relativePath) ? relativePath : ".";
  return new DurableFailure("PLAN_STALE", `Local source validation failed for server ${safeAlias} at ${safeRelative} (${reason}).`, {
    nextAction: "fix_input",
  });
}

export function normalizeCanonicalLocalPath(value, platform = process.platform) {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  if (typeof value !== "string" || !pathModule.isAbsolute(value)) {
    throw localSourceFailure("configured server", ".", "invalid root");
  }
  if (platform !== "win32") return path.posix.normalize(value);
  const namespacePrefix = /^[\\/]{2}[?.][\\/]/;
  const extendedUnc = /^\\\\\?\\UNC\\[^\\/?]+\\[^\\/?]+(?:\\|$)/i.test(value) && !value.includes("/");
  const extendedDrive = /^\\\\\?\\[a-z]:\\/i.test(value) && !value.includes("/");
  let normalized = value;
  if (namespacePrefix.test(value)) {
    if (!extendedUnc && !extendedDrive) throw localSourceFailure("configured server", ".", "invalid root");
    normalized = extendedUnc ? `\\\\${value.slice(8)}` : value.slice(4);
  }
  normalized = normalized.replaceAll("/", "\\");
  if (namespacePrefix.test(normalized)) throw localSourceFailure("configured server", ".", "invalid root");
  if (/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(normalized)) {
    throw localSourceFailure("configured server", ".", "invalid root");
  }
  normalized = path.win32.normalize(normalized);
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(normalized)) {
    throw localSourceFailure("configured server", ".", "invalid root");
  }
  if (/^[a-z]:\\/i.test(normalized)) normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  return normalized.replaceAll("\\", "/");
}

export function pinCanonicalLocalRoot(localRoot, { serverAlias = "configured server" } = {}) {
  try {
    const resolved = path.resolve(localRoot);
    const canonicalPath = normalizeCanonicalLocalPath(fs.realpathSync.native(resolved));
    const stat = fs.statSync(canonicalPath);
    if (!stat.isDirectory()) throw new Error("not-directory");
    return Object.freeze({ inputPath: resolved, canonicalPath, dev: String(stat.dev), ino: String(stat.ino) });
  } catch {
    throw localSourceFailure(serverAlias, ".", "root unavailable");
  }
}

function containsPath(root, child) {
  const relative = path.relative(root, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function pinSeparatedLocalRoot(localRoot, { stateDir, serverAlias = "configured server", allowUnavailable = false } = {}) {
  let pin;
  try { pin = pinCanonicalLocalRoot(localRoot, { serverAlias }); }
  catch (error) {
    if (allowUnavailable) return null;
    throw error;
  }
  let canonicalState;
  try { canonicalState = normalizeCanonicalLocalPath(fs.realpathSync.native(path.resolve(stateDir))); }
  catch { canonicalState = normalizeCanonicalLocalPath(path.resolve(stateDir)); }
  if (containsPath(pin.canonicalPath, canonicalState) || containsPath(canonicalState, pin.canonicalPath)) {
    throw new DurableFailure("CONFIG_INVALID", `Durable state isolation failed for server ${serverAlias}.`, { nextAction: "fix_config" });
  }
  return pin;
}

function verifyConfiguredRootSeparation(loaded, stateDir) {
  for (const [serverAlias, server] of Object.entries(loaded?.config?.servers ?? {})) {
    pinSeparatedLocalRoot(server.localRoot, { stateDir, serverAlias, allowUnavailable: true });
  }
}

export function revalidateCanonicalLocalRoot(pin, { serverAlias = "configured server", relativePath = "." } = {}) {
  let current;
  try { current = pinCanonicalLocalRoot(pin.inputPath, { serverAlias }); }
  catch { throw localSourceFailure(serverAlias, relativePath, "root changed"); }
  if (current.canonicalPath !== pin.canonicalPath || current.dev !== pin.dev || current.ino !== pin.ino) {
    throw localSourceFailure(serverAlias, relativePath, "root changed");
  }
  return current;
}

export function localRootHash({ domainId, canonicalPath, platform = process.platform, stateLimits }) {
  try {
    const bytes = encode({ v: 1, kind: "local_root", domainId, platform, canonicalPath }, stateLimits, 16384);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    throw localSourceFailure("configured server", ".", "root identity unavailable");
  }
}

export function sameLocalRootHash(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left ?? "") || !/^[a-f0-9]{64}$/.test(right ?? "")) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function canonicalTargetIdentity({ serverAlias, server, canonicalRemoteRoot = null }) {
  if (typeof serverAlias !== "string" || !serverAlias.trim()) throw new DurableFailure("CONFIG_INVALID", "Server alias is invalid.", { nextAction: "fix_config" });
  const protocol = server.protocol.trim().toLowerCase();
  const target = {
    protocol,
    host: server.host.trim().toLowerCase().replace(/\.$/, ""),
    port: server.port,
    user: server.user,
    root: normalizeRoot(server.root),
    canonicalRoot: protocol === "sftp" ? normalizeRoot(canonicalRemoteRoot) : null,
  };
  if (protocol === "sftp" && (canonicalRemoteRoot === null || canonicalRemoteRoot === undefined)) {
    throw new DurableFailure("WORKFLOW_UNSUPPORTED", "The SFTP canonical root could not be established.", { nextAction: "inspect_target" });
  }
  return Object.freeze(target);
}

export function workflowIdentity({ serverAlias, server, target, durable }) {
  const policyHash = policyFingerprint({ server, target, requirePlan: durable.requirePlan, stateLimits: durable.stateLimits });
  const bytes = encode({ v: 2, kind: "remote_target", serverAlias, target, policyHash }, durable.stateLimits, 16384);
  const targetHash = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({ policyHash, targetHash, limits: Object.freeze({
    stateLimits: durable.stateLimits,
    maxTransferBytes: server.maxTransferBytes,
    maxDeployBytes: server.maxDeployBytes,
    maxDeployFiles: server.maxDeployFiles,
  }) });
}

// Coordination is intentionally weaker than deployment identity. It prevents
// cooperating processes using one canonical state directory from constructing
// adapters concurrently for the same exact configured alias. It grants no
// authority and is never persisted in plans or claims.
export function endpointLockHash(serverAlias, stateLimits) {
  if (typeof serverAlias !== "string" || !serverAlias || serverAlias.length > 1024) {
    throw new DurableFailure("CONFIG_INVALID", "Server alias is invalid.", { nextAction: "fix_config" });
  }
  try {
    const bytes = encode({ v: 1, kind: "endpoint_lock", serverAlias }, stateLimits, 4096);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    throw stateFailure(error);
  }
}

export async function openDurableState({ loaded, signal, create, readOnly = false, fault } = {}) {
  const durable = resolveDurableConfig(loaded);
  if (!durable.enabled) throw new DurableFailure("DURABLE_STATE_DISABLED", "Durable state is disabled.", { nextAction: "fix_config" });
  if (signal && activeSignals.has(signal)) {
    throw new DurableFailure("DURABLE_STATE_BUSY", "This operation already owns a durable state store.", { retryable: true, nextAction: "retry" });
  }
  if (signal) activeSignals.add(signal);
  let store;
  try {
    store = await openStateStore({ stateDir: durable.stateDir, localRoots: [],
      limits: durable.stateLimits, signal, create, readOnly, fault });
    // Status and rollback tolerate offline roots, but every root that is live
    // must still be disjoint from state storage at the instant of the call.
    verifyConfiguredRootSeparation(loaded, durable.stateDir);
  } catch (error) {
    try { await store?.close(); } catch { /* preserve the isolation failure */ }
    if (signal) activeSignals.delete(signal);
    throw stateFailure(error);
  }
  let closed = false;
  return Object.freeze({
    store,
    durable,
    warning: process.platform === "win32" ? WINDOWS_ACL_WARNING : null,
    async close() {
      if (closed) return;
      closed = true;
      try { await store.close(); }
      catch (error) { throw stateFailure(error); }
      finally { if (signal) activeSignals.delete(signal); }
    },
  });
}
