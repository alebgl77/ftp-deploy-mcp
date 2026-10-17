import { decode } from "../state/codec.mjs";
import { createWorkflowPolicy, temporaryWarnings } from "../workflow/events.mjs";
import { decodePlan, unchanged } from "../workflow/model.mjs";
import { Counts, Guarantees, StatusInputSchema, StatusOutputSchema } from "./schemas.js";
import { DurableFailure, asDurableFailure, openDurableState } from "./state.js";

export const STATUS_STRUCTURED_BUDGET = 18 * 1024;
const READ_LIMITS = Object.freeze({ maxTransferBytes: 1099511627776, maxDeployBytes: 1099511627776, maxDeployFiles: 100000 });

function checkedInput(input, maxPlanFiles) {
  const parsed = StatusInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.offset > maxPlanFiles) {
    throw new DurableFailure("INVALID_ARGUMENT", "The durable status input is invalid.", { nextAction: "fix_input" });
  }
  return parsed.data;
}

function attempts(values) { return Object.values(values ?? {}).filter((value) => value !== null).length; }

function uncertain(file) {
  if (file.state === "SATISFIED_UNOWNED") return true;
  for (const scope of [file.apply, file.recovery]) {
    for (const attempt of Object.values(scope ?? {})) {
      if (attempt && (["PROMOTING", "RESTORING", "REMOVING"].includes(attempt.phase) || attempt.cleanup === "CLEANING")) return true;
    }
  }
  return false;
}

function operationRows(plan, state) {
  return plan.files.map((file, index) => {
    const row = state.files[index];
    return {
      index,
      local_path: file.localPath,
      remote_path: file.remotePath,
      bytes: file.bytes,
      before_kind: file.before.kind,
      state: row.state.toLowerCase(),
      backup: row.backup.toLowerCase(),
      apply_attempts: attempts(row.apply),
      recovery_attempts: attempts(row.recovery),
      uncertain: uncertain(row),
    };
  });
}

function plannedRows(plan) {
  return plan.files.map((file, index) => ({
    index,
    local_path: file.localPath,
    remote_path: file.remotePath,
    bytes: file.bytes,
    before_kind: file.before.kind,
    state: unchanged(file) ? "skipped" : "pending",
    backup: "none",
    apply_attempts: 0,
    recovery_attempts: 0,
    uncertain: false,
  }));
}

function counts(rows) {
  const result = { ...Counts, total: rows.length };
  for (const row of rows) {
    result[row.state]++;
    if (row.backup === "ready") result.backup_ready++;
  }
  return result;
}

function fittedOutput(base, rows, offset, limit) {
  const pageRows = [];
  const total = rows.length;
  const available = rows.slice(offset, Math.min(total, offset + limit));
  const candidate = () => {
    const count = pageRows.length;
    const nextOffset = offset + count < total ? offset + count : null;
    return { ...base, page: { offset, requested_limit: limit, count, total,
      has_more: nextOffset !== null, next_offset: nextOffset }, files: [...pageRows] };
  };
  for (const row of available) {
    pageRows.push(row);
    if (Buffer.byteLength(JSON.stringify(candidate())) > STATUS_STRUCTURED_BUDGET) {
      pageRows.pop();
      break;
    }
  }
  const output = candidate();
  if (Buffer.byteLength(JSON.stringify(output)) > STATUS_STRUCTURED_BUDGET) {
    throw new DurableFailure("DURABLE_STATE_LIMIT", "The status projection cannot fit its structured output budget.", { nextAction: "fix_config" });
  }
  return StatusOutputSchema.parse(output);
}

function completePhase(phase) {
  return ["COMPLETED", "COMPLETED_WITH_WARNINGS", "ROLLED_BACK", "ROLLBACK_WITH_WARNINGS"].includes(phase);
}

export async function statusFromStore({ store, durable, input, now = Date.now() } = {}) {
  const args = checkedInput(input, durable.stateLimits.maxPlanFiles);
  if (!Number.isSafeInteger(now) || now < 0) throw new DurableFailure("INVALID_ARGUMENT", "The status clock is invalid.", { nextAction: "fix_input" });
  try {
    const selector = args.plan_id ? { planId: args.plan_id } : { operationId: args.operation_id };
    const limits = { ...READ_LIMITS, stateLimits: durable.stateLimits };
    const snapshot = await store.readStatusSnapshot(selector,
      (raw) => createWorkflowPolicy(decodePlan(raw, limits), limits));
    const { claim, planId, planBytes: raw, journalMetadata } = snapshot;
    const captured = decode(raw, durable.stateLimits, durable.stateLimits.maxPlanBytes);
    const plan = decodePlan(raw, limits);

    let rows;
    let phase;
    let journalSeq;
    let operationId = null;
    let applyBytes = 0;
    let recoveryBytes = 0;
    let warnings = 0;
    let needsReconciliation = false;
    let complete = false;
    if (!claim) {
      rows = plannedRows(plan);
      phase = "planned";
      journalSeq = 0;
    } else {
      operationId = claim.operationId;
      const metadata = journalMetadata;
      rows = operationRows(plan, metadata.state);
      phase = metadata.state.phase.toLowerCase();
      journalSeq = metadata.tip.seq;
      applyBytes = metadata.state.applyCharged;
      recoveryBytes = metadata.state.recoveryCharged;
      warnings = temporaryWarnings(metadata.state);
      needsReconciliation = rows.some((row) => row.uncertain) || warnings > 0;
      complete = completePhase(metadata.state.phase);
    }
    if (args.if_journal_seq !== undefined && args.if_journal_seq !== journalSeq) {
      throw new DurableFailure("STATUS_CHANGED", "Durable status changed since the requested journal sequence.", { retryable: true, nextAction: "status" });
    }
    // Touching the decoded record ensures status never projects an unvalidated
    // object even if a future codec implementation changes its clone behavior.
    if (captured.serverAlias !== plan.serverAlias) throw new DurableFailure("DURABLE_STATE_CORRUPT", "Durable plan validation failed.", { nextAction: "offline_recovery" });
    return fittedOutput({
      schema_version: 1,
      lookup: args.plan_id ? "plan" : "operation",
      plan_id: planId,
      operation_id: operationId,
      server: plan.serverAlias,
      phase,
      expired: now >= plan.expiresAt,
      journal_seq: journalSeq,
      complete,
      needs_reconciliation: needsReconciliation,
      counts: counts(rows),
      apply_bytes_charged: applyBytes,
      recovery_bytes_charged: recoveryBytes,
      temporary_warnings: warnings,
      guarantees: Guarantees,
    }, rows, args.offset, args.limit);
  } catch (error) {
    throw asDurableFailure(error);
  }
}

export async function readDeploymentStatus(options = {}) {
  const state = await openDurableState({ loaded: options.loaded, signal: options.signal ?? options.operation?.signal,
    create: false, readOnly: true, fault: options.fault });
  let result;
  let failure;
  try { result = await statusFromStore({ ...options, store: state.store, durable: state.durable }); }
  catch (error) { failure = error; }
  try { await state.close(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
  return result;
}
