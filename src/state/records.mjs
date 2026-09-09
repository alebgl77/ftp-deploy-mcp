import { exact, integer, hash, id, fail, encode, unseal } from './codec.mjs';

export const ZERO_HASH = '0'.repeat(64);
export const FIXED_BYTES = 67 * 4096;
export function reservation(value, limits, code = 'STATE_INVALID') {
  exact(value, ['applyJournalBytes', 'applyJournalEvents', 'recoveryJournalBytes', 'recoveryJournalEvents', 'backupBytes', 'backupFiles', 'metadataBytes', 'backups'], code);
  for (const field of ['applyJournalBytes', 'recoveryJournalBytes']) integer(value[field], limits.maxJournalBytes, code, 1);
  for (const field of ['applyJournalEvents', 'recoveryJournalEvents']) integer(value[field], limits.maxJournalEvents, code, 1);
  integer(value.backupBytes, limits.maxBackupBytes, code);
  integer(value.backupFiles, limits.maxBackupFiles, code);
  integer(value.metadataBytes, limits.maxStateBytes, code, 1);
  if (value.applyJournalBytes + value.recoveryJournalBytes > limits.maxJournalBytes ||
      value.applyJournalEvents + value.recoveryJournalEvents > limits.maxJournalEvents) fail('STATE_LIMIT', 'journal_reservation');
  if (!Array.isArray(value.backups) || value.backups.length > limits.maxPlanFiles) fail(code, 'backup_reservation');
  const indices = new Set(); let bytes = 0;
  for (const item of value.backups) {
    exact(item, ['fileIndex', 'expectedBytes', 'expectedSha256', 'mode'], code);
    integer(item.fileIndex, limits.maxPlanFiles - 1, code); integer(item.expectedBytes, limits.maxBackupBytes, code); hash(item.expectedSha256, code);
    if (item.mode !== null) integer(item.mode, 0o777, code);
    if (indices.has(item.fileIndex)) fail(code, 'backup_duplicate');
    indices.add(item.fileIndex); bytes += item.expectedBytes;
  }
  if (bytes > value.backupBytes || indices.size > value.backupFiles) fail('STATE_LIMIT', 'backup_reservation');
  return structuredClone(value);
}
export function readDomain(bytes, limits) {
  const record = unseal(bytes, ['v', 'domainId'], limits);
  if (record.v !== 1) fail('STATE_CORRUPT', 'domain_version');
  id(record.domainId, 'domain', 'STATE_CORRUPT'); return record;
}
export function readPlanRecord(bytes, planId, domainId, limits) {
  const record = unseal(bytes, ['v', 'domainId', 'planId', 'payload'], limits, limits.maxPlanBytes);
  if (record.v !== 1 || record.domainId !== domainId || record.planId !== planId) fail('STATE_CORRUPT', 'plan_identity');
  id(record.planId, 'plan', 'STATE_CORRUPT'); return record;
}
export function readClaimRecord(bytes, planId, domainId, limits) {
  const record = unseal(bytes, ['v', 'domainId', 'planId', 'planHash', 'operationId', 'keyHash', 'targetHash', 'reservation'], limits, limits.maxPlanBytes);
  if (record.v !== 1 || record.domainId !== domainId || record.planId !== planId) fail('STATE_CORRUPT', 'claim_identity');
  id(record.planId, 'plan', 'STATE_CORRUPT'); id(record.operationId, 'operation', 'STATE_CORRUPT');
  for (const field of ['planHash', 'keyHash', 'targetHash']) hash(record[field], 'STATE_CORRUPT');
  reservation(record.reservation, limits, 'STATE_CORRUPT');
  if (record.reservation.metadataBytes < 2 * bytes.length + 8192) fail('STATE_CORRUPT', 'metadata_reservation');
  return record;
}
export function headRecord(value) {
  exact(value, ['v', 'seq', 'hash', 'byte_length']);
  if (value.v !== 1) fail('STATE_CORRUPT', 'head_version');
  integer(value.seq, 500000, 'STATE_CORRUPT', 1); hash(value.hash, 'STATE_CORRUPT'); integer(value.byte_length, 268435456, 'STATE_CORRUPT', 1);
  return value;
}
export function eventRecord(record, limits, previous, budgetUsed, allocation) {
  exact(record, ['v', 'seq', 'prev', 'budget', 'event', 'hash']);
  if (record.v !== 1 || record.seq !== previous.seq + 1 || record.prev !== previous.hash || !['apply', 'recovery'].includes(record.budget)) fail('STATE_CORRUPT', 'journal_chain');
  hash(record.hash, 'STATE_CORRUPT');
  const bytes = encode(record, limits);
  const used = budgetUsed[record.budget];
  if (used.bytes + bytes.length > allocation[`${record.budget}JournalBytes`] || used.events + 1 > allocation[`${record.budget}JournalEvents`]) fail('STATE_LIMIT', 'journal_budget');
  return bytes;
}
