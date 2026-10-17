import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  Counts,
  CountsSchema,
  DurableErrorResultSchema,
  DurableToolAnnotations,
  Guarantees,
  GuaranteesSchema,
  PlanInputSchema,
  PlanOutputSchema,
  ApplyOutputSchema,
  RollbackOutputSchema,
  StatusInputSchema,
  StatusOutputSchema,
} from "../../src/durable/schemas.js";
import { DurableFailure, enrichDurableFailure, projectDurableError } from "../../src/durable/state.js";
import { createToolRegistry } from "../../src/tool-registry.js";
import { createRedactor } from "../../src/redact.js";

const PLAN = "pln_12345678-1234-4234-8234-123456789abc";
const OPERATION = "op_12345678-1234-4234-8234-123456789abc";

test("durable schemas are strict, bounded and apply only documented defaults", () => {
  assert.equal(PlanInputSchema.parse({ local_dir: "." }).ttl_seconds, 600);
  for (const value of [
    { local_dir: ".", extra: true },
    { local_dir: "" },
    { local_dir: ".", include: Array(65).fill("x") },
    { local_dir: ".", include: ["x".repeat(257)] },
    { local_dir: ".", ttl_seconds: 59 },
    { local_dir: ".", ttl_seconds: 901 },
  ]) assert.equal(PlanInputSchema.safeParse(value).success, false);

  assert.deepEqual(StatusInputSchema.parse({ plan_id: PLAN }), { plan_id: PLAN, offset: 0, limit: 50 });
  for (const value of [{}, { plan_id: PLAN, operation_id: OPERATION }, { plan_id: PLAN, limit: 101 },
    { operation_id: OPERATION, offset: 10001 }, { plan_id: PLAN, extra: true }]) {
    assert.equal(StatusInputSchema.safeParse(value).success, false);
  }
  assert.ok(GuaranteesSchema.safeParse(Guarantees).success);
  assert.ok(CountsSchema.safeParse(Counts).success);
  assert.equal(GuaranteesSchema.safeParse({ ...Guarantees, exactly_once: true }).success, false);
  assert.equal(CountsSchema.safeParse({ ...Counts, total: -1 }).success, false);
  assert.ok(Object.isFrozen(Guarantees) && Object.isFrozen(Counts));
  assert.deepEqual(DurableToolAnnotations.status, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("durable errors use a private typed channel and a strict credential-free projection", () => {
  const failure = new DurableFailure("DURABLE_STATE_IO", "Durable state I/O failed.", { retryable: true, nextAction: "retry" });
  const projected = projectDurableError(failure, { requestId: "12345678-1234-4234-8234-123456789abc", planId: PLAN, operationId: OPERATION });
  assert.ok(DurableErrorResultSchema.safeParse(projected).success);
  assert.equal(projected.error.effects, "none");
  assert.equal(projected.error.retryable, true);
  assert.doesNotMatch(JSON.stringify(projected), /password|passphrase|privateKey|credential-secret/i);
  assert.equal(DurableErrorResultSchema.safeParse({ ...projected, extra: true }).success, false);
  assert.equal(DurableErrorResultSchema.safeParse({ error: { ...projected.error, native: "secret" } }).success, false);
});

test("durable error projection fuses journal and live operation observations monotonically", () => {
  const failure = enrichDurableFailure(new DurableFailure("ROLLBACK_CONFLICT", "conflict", { effects: "possible", nextAction: "inspect_target" }), {
    planId: PLAN,
    operationId: OPERATION,
    phase: "rolling_back",
    effects: "possible",
    partial: { completed_files: 2, completed_bytes: 9, rolled_back_files: 1, remaining_applied_files: 1, conflict_index: 0 },
  });
  const projected = projectDurableError(failure, { requestId: "12345678-1234-4234-8234-123456789abc",
    operationSnapshot: { effects: "confirmed", partial: { completed_files: 3, completed_bytes: 12 } } });
  assert.equal(projected.error.effects, "confirmed");
  assert.equal(projected.error.phase, "rolling_back");
  assert.equal(projected.error.plan_id, PLAN);
  assert.equal(projected.error.operation_id, OPERATION);
  assert.deepEqual(projected.error.partial, { completed_files: 3, completed_bytes: 12, rolled_back_files: 1,
    remaining_applied_files: 1, conflict_index: 0 });
});

const baseCommon = {
  schema_version: 1, plan_id: PLAN, operation_id: OPERATION, server: "prod", phase: "completed", complete: true,
  needs_reconciliation: false, counts: { ...Counts, total: 1, applied: 1 }, apply_bytes_charged: 1,
  recovery_bytes_charged: 0, temporary_warnings: 0, guarantees: Guarantees, security_warning: null,
};

async function rendered(tool, secret, outputSchema, structuredContent, { errorSchema, isError = false } = {}) {
  const registry = createToolRegistry({ redactor: createRedactor({ password: secret }) });
  registry.registerTool(tool, { inputSchema: z.object({}).strict(), outputSchema, errorSchema, annotations: {} }, async () => ({
    ...(isError ? { isError: true } : {}), content: [{ type: "text", text: `free:${secret}` }], structuredContent,
  }));
  return registry.call(tool, {});
}

test("durable schema constants survive exact-position redaction collisions while free text remains masked", async () => {
  const plan = { schema_version: 1, phase: "planned", plan_id: PLAN, plan_digest: "a".repeat(64), server: "prod",
    protocol: "sftp", created_at_ms: 1, expires_at_ms: 2, total_files: 1, total_bytes: 1, unchanged_files: 0,
    new_files: 1, replaced_files: 0, backup_bytes: 0, requires_confirmation: true, guarantees: Guarantees, security_warning: null };
  const planned = await rendered("ftp_plan_deploy", "sftp", PlanOutputSchema, plan);
  assert.equal(planned.structuredContent.protocol, "sftp");
  assert.doesNotMatch(planned.content[0].text, /sftp/);

  const applied = await rendered("ftp_apply_deploy", "completed", ApplyOutputSchema, { ...baseCommon, outcome: "completed" });
  assert.equal(applied.structuredContent.phase, "completed");
  assert.equal(applied.structuredContent.outcome, "completed");

  const status = await rendered("ftp_deploy_status", "applied", StatusOutputSchema, {
    schema_version: 1, lookup: "operation", plan_id: PLAN, operation_id: OPERATION, server: "prod", phase: "completed",
    expired: false, journal_seq: 2, complete: true, needs_reconciliation: false,
    counts: { ...Counts, total: 1, applied: 1 }, apply_bytes_charged: 1, recovery_bytes_charged: 0,
    temporary_warnings: 0, page: { offset: 0, requested_limit: 50, count: 1, total: 1, has_more: false, next_offset: null },
    files: [{ index: 0, local_path: "a", remote_path: "a", bytes: 1, before_kind: "file", state: "applied",
      backup: "ready", apply_attempts: 1, recovery_attempts: 0, uncertain: false }], guarantees: Guarantees,
  });
  assert.equal(status.structuredContent.files[0].state, "applied");

  const error = projectDurableError(new DurableFailure("PLAN_STALE", "free PLAN_STALE", { nextAction: "inspect_target" }), {
    requestId: "12345678-1234-4234-8234-123456789abc", planId: PLAN, operationId: OPERATION });
  const rolled = await rendered("ftp_rollback_deploy", "PLAN_STALE", RollbackOutputSchema, error,
    { errorSchema: DurableErrorResultSchema, isError: true });
  assert.equal(rolled.structuredContent.error.code, "PLAN_STALE");
  assert.doesNotMatch(rolled.structuredContent.error.message, /PLAN_STALE/);

  for (const value of Object.values(Guarantees).filter((item) => typeof item === "string")) {
    const collision = await rendered("ftp_plan_deploy", value, PlanOutputSchema, plan);
    assert.notEqual(collision.isError, true, value);
  }
});
