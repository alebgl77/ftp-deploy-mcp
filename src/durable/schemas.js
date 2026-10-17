import { z } from "zod";

import { ERROR_CODES } from "../errors.js";

const UUID_V4 = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
export const PLAN_ID_RE = new RegExp(`^pln_${UUID_V4}$`);
export const OPERATION_ID_RE = new RegExp(`^op_${UUID_V4}$`);
export const LOWER_SHA256_RE = /^[a-f0-9]{64}$/;
const safeInteger = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedText = (minimum = 1, maximum = 1024) => z.string().min(minimum).max(maximum);

export const Guarantees = Object.freeze({
  level: "observable_state_reconciled",
  per_file_atomicity: "server_dependent",
  multi_file_atomic: false,
  exactly_once: false,
  rollback_scope: "durably_acknowledged_files_only",
  process_crash_recovery: "journaled_offline_lock_recovery_may_be_required",
  power_loss_durability: "not_guaranteed",
});

export const Counts = Object.freeze({
  total: 0,
  pending: 0,
  skipped: 0,
  applied: 0,
  satisfied_unowned: 0,
  rolled_back: 0,
  backup_ready: 0,
});

export const GuaranteesSchema = z.object({
  level: z.literal(Guarantees.level),
  per_file_atomicity: z.literal(Guarantees.per_file_atomicity),
  multi_file_atomic: z.literal(false),
  exactly_once: z.literal(false),
  rollback_scope: z.literal(Guarantees.rollback_scope),
  process_crash_recovery: z.literal(Guarantees.process_crash_recovery),
  power_loss_durability: z.literal(Guarantees.power_loss_durability),
}).strict();

export const CountsSchema = z.object({
  total: safeInteger(),
  pending: safeInteger(),
  skipped: safeInteger(),
  applied: safeInteger(),
  satisfied_unowned: safeInteger(),
  rolled_back: safeInteger(),
  backup_ready: safeInteger(),
}).strict();

const globList = z.array(boundedText(1, 256)).max(64);
export const PlanInputSchema = z.object({
  server: boundedText().optional(),
  local_dir: boundedText(),
  remote_dir: boundedText().optional(),
  include: globList.optional(),
  exclude: globList.optional(),
  ttl_seconds: z.number().int().min(60).max(900).default(600),
}).strict();

export const PlanOutputSchema = z.object({
  schema_version: z.literal(1),
  phase: z.literal("planned"),
  plan_id: z.string().regex(PLAN_ID_RE),
  plan_digest: z.string().regex(LOWER_SHA256_RE),
  server: boundedText(),
  protocol: z.enum(["ftp", "ftps", "sftp"]),
  created_at_ms: safeInteger(),
  expires_at_ms: safeInteger(),
  total_files: safeInteger(),
  total_bytes: safeInteger(),
  unchanged_files: safeInteger(),
  new_files: safeInteger(),
  replaced_files: safeInteger(),
  backup_bytes: safeInteger(),
  requires_confirmation: z.literal(true),
  guarantees: GuaranteesSchema,
  security_warning: z.string().max(4096).nullable(),
}).strict();

export const StatusInputSchema = z.object({
  plan_id: z.string().regex(PLAN_ID_RE).optional(),
  operation_id: z.string().regex(OPERATION_ID_RE).optional(),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
  if_journal_seq: safeInteger().optional(),
}).strict().refine((value) => Number(value.plan_id !== undefined) + Number(value.operation_id !== undefined) === 1,
  { message: "exactly one status selector is required" });

const StatusFileSchema = z.object({
  index: safeInteger(),
  local_path: boundedText(),
  remote_path: boundedText(),
  bytes: safeInteger(),
  before_kind: z.enum(["absent", "file"]),
  state: z.enum(["pending", "skipped", "applied", "satisfied_unowned", "rolled_back"]),
  backup: z.enum(["none", "intent", "ready"]),
  apply_attempts: safeInteger(),
  recovery_attempts: safeInteger(),
  uncertain: z.boolean(),
}).strict();

export const StatusOutputSchema = z.object({
  schema_version: z.literal(1),
  lookup: z.enum(["plan", "operation"]),
  plan_id: z.string().regex(PLAN_ID_RE),
  operation_id: z.string().regex(OPERATION_ID_RE).nullable(),
  server: boundedText(),
  phase: z.enum(["planned", "applying", "completed", "completed_with_warnings", "rolling_back", "rolled_back", "rollback_with_warnings"]),
  expired: z.boolean(),
  journal_seq: safeInteger(),
  complete: z.boolean(),
  needs_reconciliation: z.boolean(),
  counts: CountsSchema,
  apply_bytes_charged: safeInteger(),
  recovery_bytes_charged: safeInteger(),
  temporary_warnings: safeInteger(),
  page: z.object({
    offset: safeInteger(),
    requested_limit: z.number().int().min(1).max(100),
    count: safeInteger(),
    total: safeInteger(),
    has_more: z.boolean(),
    next_offset: safeInteger().nullable(),
  }).strict(),
  files: z.array(StatusFileSchema).max(100),
  guarantees: GuaranteesSchema,
}).strict();

const printableIdempotencyKey = z.string().min(16).max(128).regex(/^[!-~]+$/);
export const ApplyInputSchema = z.object({
  plan_id: z.string().regex(PLAN_ID_RE),
  idempotency_key: printableIdempotencyKey,
  resume: z.boolean().default(false),
}).strict();

export const RollbackInputSchema = z.object({
  operation_id: z.string().regex(OPERATION_ID_RE),
  resume: z.boolean().default(false),
}).strict();

const ResultPhaseSchema = z.enum(["applying", "completed", "completed_with_warnings", "rolling_back", "rolled_back", "rollback_with_warnings"]);
const commonResult = {
  schema_version: z.literal(1),
  plan_id: z.string().regex(PLAN_ID_RE),
  operation_id: z.string().regex(OPERATION_ID_RE),
  server: boundedText(),
  phase: ResultPhaseSchema,
  complete: z.boolean(),
  needs_reconciliation: z.boolean(),
  counts: CountsSchema,
  apply_bytes_charged: safeInteger(),
  recovery_bytes_charged: safeInteger(),
  temporary_warnings: safeInteger(),
  guarantees: GuaranteesSchema,
  security_warning: z.string().max(4096).nullable(),
};

export const ApplyOutputSchema = z.object({
  ...commonResult,
  outcome: z.enum(["completed", "completed_with_warnings", "already_terminal", "status_only"]),
}).strict();

export const RollbackOutputSchema = z.object({
  ...commonResult,
  outcome: z.enum(["rolled_back", "rolled_back_with_warnings", "already_terminal", "status_only"]),
}).strict();

export const DURABLE_ERROR_CODES = Object.freeze([...ERROR_CODES,
  "DURABLE_STATE_DISABLED", "DURABLE_STATE_BUSY", "DURABLE_STATE_LIMIT", "DURABLE_STATE_CORRUPT", "DURABLE_STATE_IO", "DURABLE_STATE_UNSUPPORTED",
  "PLAN_NOT_FOUND", "PLAN_EXPIRED", "PLAN_STALE", "PLAN_CONSUMED", "IDEMPOTENCY_CONFLICT", "CONFIRMATION_DECLINED",
  "CONFIRMATION_INVALID", "CLIENT_INTERACTION_UNSUPPORTED", "STATUS_CHANGED", "RECONCILIATION_REQUIRED", "ROLLBACK_CONFLICT",
  "WORKFLOW_UNSUPPORTED",
]);

const PartialSchema = z.object({
  completed_files: safeInteger(),
  completed_bytes: safeInteger(),
  rolled_back_files: safeInteger(),
  remaining_applied_files: safeInteger(),
  conflict_index: safeInteger().nullable(),
}).strict();

export const DurableErrorResultSchema = z.object({
  error: z.object({
    schema_version: z.literal(1),
    code: z.enum(DURABLE_ERROR_CODES),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
    request_id: z.uuid(),
    plan_id: z.string().regex(PLAN_ID_RE).nullable(),
    operation_id: z.string().regex(OPERATION_ID_RE).nullable(),
    next_action: z.enum(["fix_input", "fix_config", "inspect_target", "retry", "status", "resume_apply", "resume_rollback", "offline_recovery", "upgrade_client", "none"]),
    effects: z.enum(["none", "possible", "confirmed"]),
    phase: z.string().max(64).nullable(),
    partial: PartialSchema.nullable(),
  }).strict(),
}).strict();

export const DurableToolAnnotations = Object.freeze({
  plan: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
  apply: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }),
  status: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  rollback: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }),
});
