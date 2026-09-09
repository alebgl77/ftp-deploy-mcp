import { seal, integer, fail } from '../state/codec.mjs';
import { FIXED_BYTES, reservation, readClaimRecord } from '../state/records.mjs';
import { encodePlan, decodePlan, workflowLimits, unchanged, immutable } from './model.mjs';
import { assertStateCapacity } from './events.mjs';

const UUID = '00000000-0000-4000-8000-000000000000';
const HEX = '0'.repeat(64);
// This is the actual state-library claim grammar, sealed by its own codec.
export function claimEnvelope(allocation, stateLimits) {
  return seal({ v: 1, domainId: UUID, planId: `pln_${UUID}`, planHash: HEX, operationId: `op_${UUID}`,
    keyHash: HEX, targetHash: HEX, reservation: allocation }, stateLimits, stateLimits.maxPlanBytes);
}
export function frameEnvelope(event, seq, stateLimits) {
  return seal({ v: 1, seq, prev: HEX, budget: event.scope, event }, stateLimits);
}
// Finite, disjoint categories are also the bounds for later effect preflights.
// No 4096-byte blanket charge, and no frame budget supplied by model input.
export function journalEnvelope(plan, limits) {
  const N = plan.files.length;
  let U = 0, C = 0, A = 0;
  for (const file of plan.files) { if (unchanged(file)) U++; else if (file.before.kind === 'file') C++; else A++; }
  const applyEvents = 2 + U + 2 * C + 18 * (C + A), recoveryEvents = 2 + 18 * C + 6 * A;
  const seq = applyEvents + recoveryEvents, i = N - 1, a = 3, token = '0'.repeat(32);
  const mode = plan.target.protocol === 'sftp' ? 511 : null;
  const apply = {}, recovery = {};
  function category(scope, name, count, variants) {
    const events = variants.map(([type, fields = {}]) => ({ v: 1, scope, type, ...fields }));
    const bytes = Math.max(...events.map(event => frameEnvelope(event, seq, limits.stateLimits).length));
    (scope === 'apply' ? apply : recovery)[name] = { count, bytes, events };
  }
  category('apply', 'init', 1, [['INIT', { planDigest: HEX, fileCount: N }]]);
  category('apply', 'complete', 1, [['APPLY_COMPLETE']]);
  category('apply', 'skip', U, [['SKIP', { i }]]);
  category('apply', 'backupIntent', C, [['BACKUP_INTENT', { i }]]);
  category('apply', 'backupReady', C, [['BACKUP_READY', { i }]]);
  category('apply', 'intent', 3 * (C + A), [['STAGE_INTENT', { i, a, token }]]);
  category('apply', 'staged', 3 * (C + A), [['STAGED', { i, a, mode }]]);
  category('apply', 'promoting', 3 * (C + A), [['PROMOTING', { i, a }]]);
  category('apply', 'terminal', 3 * (C + A), [['APPLIED', { i, a }], ['ATTEMPT_ABANDONED', { i, a }], ['SATISFIED_UNOWNED', { i, a }]]);
  category('apply', 'cleaning', 3 * (C + A), [['CLEANING', { i, a }]]);
  category('apply', 'cleaned', 3 * (C + A), [['CLEANED', { i, a }]]);
  category('recovery', 'start', 1, [['ROLLBACK_START']]);
  category('recovery', 'complete', 1, [['ROLLBACK_COMPLETE']]);
  category('recovery', 'intent', 3 * C, [['RESTORE_INTENT', { i, a, token }]]);
  category('recovery', 'staged', 3 * C, [['RESTORE_STAGED', { i, a, mode }]]);
  category('recovery', 'restoring', 3 * C, [['RESTORING', { i, a }]]);
  category('recovery', 'terminal', 3 * C, [['RESTORED', { i, a, proof: 'ack' }], ['RESTORED', { i, a, proof: 'observed' }], ['RECOVERY_ATTEMPT_ABANDONED', { i, a }]]);
  category('recovery', 'cleaning', 3 * C, [['CLEANING', { i, a }]]);
  category('recovery', 'cleaned', 3 * C, [['CLEANED', { i, a }]]);
  category('recovery', 'removeIntent', 3 * A, [['REMOVE_INTENT', { i, a }]]);
  category('recovery', 'removeTerminal', 3 * A, [['REMOVED', { i, a }], ['RECOVERY_ATTEMPT_ABANDONED', { i, a }]]);
  return immutable({ seq, applyEvents, recoveryEvents, apply, recovery });
}
export function reservationFor(plan, suppliedLimits) {
  const limits = workflowLimits(suppliedLimits), state = limits.stateLimits;
  const captured = decodePlan(encodePlan(plan, limits), limits);
  assertStateCapacity(captured, limits);
  const envelope = journalEnvelope(captured, limits);
  const total = scope => Object.values(envelope[scope]).reduce((sum, category) => sum + category.count * category.bytes, 0);
  const backups = captured.files.filter(file => file.before.kind === 'file' && !unchanged(file)).map(file => ({
    fileIndex: file.index, expectedBytes: file.before.bytes, expectedSha256: file.before.sha256, mode: file.before.mode,
  }));
  const allocation = {
    applyJournalBytes: total('apply'), applyJournalEvents: envelope.applyEvents,
    recoveryJournalBytes: total('recovery'), recoveryJournalEvents: envelope.recoveryEvents,
    backupBytes: backups.reduce((sum, backup) => sum + backup.expectedBytes, 0), backupFiles: backups.length, metadataBytes: 1, backups,
  };
  for (const field of ['applyJournalBytes', 'recoveryJournalBytes']) integer(allocation[field], state.maxJournalBytes, 'STATE_LIMIT', 1);
  for (const field of ['applyJournalEvents', 'recoveryJournalEvents']) integer(allocation[field], state.maxJournalEvents, 'STATE_LIMIT', 1);
  reservation(allocation, state, 'STATE_LIMIT');
  for (let iteration = 0; iteration < 16; iteration++) {
    const bytes = claimEnvelope(allocation, state);
    const required = 2 * bytes.length + 8192;
    if (required <= allocation.metadataBytes) {
      const totalState = FIXED_BYTES + 2 * state.maxPlanBytes + allocation.applyJournalBytes + allocation.recoveryJournalBytes + allocation.backupBytes + allocation.metadataBytes;
      if (totalState > state.maxStateBytes) fail('STATE_LIMIT', 'workflow_state_reservation');
      readClaimRecord(bytes, `pln_${UUID}`, UUID, state);
      return immutable(reservation(allocation, state, 'STATE_LIMIT'));
    }
    allocation.metadataBytes = integer(required, state.maxStateBytes, 'STATE_LIMIT', 1);
  }
  fail('STATE_LIMIT', 'workflow_metadata_convergence');
}
