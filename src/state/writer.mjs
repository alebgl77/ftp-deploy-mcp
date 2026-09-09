import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StateError, fail, exact, integer, hash, encode, decode, seal, unseal } from './codec.mjs';
import { identity, checkSignal, safeFailure } from './io.mjs';
import { ZERO_HASH, headRecord, eventRecord } from './records.mjs';

function callbacks(value) {
  exact(value, ['validateEvent', 'reduce'], 'STATE_INVALID');
  if (typeof value.validateEvent !== 'function' || typeof value.reduce !== 'function') fail('STATE_INVALID', 'event_callbacks');
  return value;
}
function transition(state, event, functions, limits) {
  const bytes = encode(event, limits);
  const isolated = decode(bytes, limits);
  let accepted, result;
  try {
    accepted = functions.validateEvent(structuredClone(isolated));
    if (accepted && typeof accepted.then === 'function') Promise.resolve(accepted).catch(() => {});
    if (accepted !== true) fail('STATE_CORRUPT', 'event_validation');
    result = functions.reduce(state === undefined ? undefined : structuredClone(state), structuredClone(isolated));
    if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('STATE_INVALID', 'async_reducer'); }
    // Reduced state is private bounded metadata, not a live caller-owned object.
    return { event: isolated, state: decode(encode(result, limits, limits.maxPlanBytes), limits, limits.maxPlanBytes) };
  } catch { fail('STATE_CORRUPT', 'event_transition'); }
}
const blank = () => ({ apply: { bytes: 0, events: 0 }, recovery: { bytes: 0, events: 0 } });
function nextRecord(event, budget, tip, state, used, claim, functions, limits) {
  if (!['apply', 'recovery'].includes(budget)) fail('STATE_INVALID', 'budget_class');
  const next = transition(state, event, functions, limits);
  const bytes = seal({ v: 1, seq: tip.seq + 1, prev: tip.hash, budget, event: next.event }, limits);
  const record = decode(bytes, limits);
  eventRecord(record, limits, tip, used, claim.reservation);
  return { bytes, record, state: next.state, head: { v: 1, seq: record.seq, hash: record.hash, byte_length: tip.byte_length + bytes.length } };
}
export async function initializeJournal(owned, claim, event, supplied) {
  const functions = callbacks(supplied), { io, limits } = owned;
  const first = nextRecord(event, 'apply', { seq: 0, hash: ZERO_HASH, byte_length: 0 }, undefined, blank(), claim, functions, limits);
  const dir = owned.path('operations', claim.operationId);
  await io.mkdir(dir); await io.mkdir(path.join(dir, 'backups'));
  await io.publish(path.join(dir, 'journal.jsonl'), first.bytes, { stage: 'initial_journal' });
  await io.publish(path.join(dir, 'head.json'), encode(first.head, limits), { stage: 'initial_head' });
}
export async function loadWriter(owned, claim, supplied) {
  const functions = callbacks(supplied), { io, limits } = owned;
  const dir = owned.path('operations', claim.operationId), journalPath = path.join(dir, 'journal.jsonl'), headPath = path.join(dir, 'head.json');
  const bytes = await io.read(journalPath, claim.reservation.applyJournalBytes + claim.reservation.recoveryJournalBytes, 'journal_replay');
  let tip = { seq: 0, hash: ZERO_HASH, byte_length: 0 }, state;
  const used = blank(); let start = 0;
  // Each line is bounded before decoding or JSON.parse. There is no suffix repair.
  for (let offset = 0; offset < bytes.length; offset++) {
    if (offset - start + 1 > 4096) fail('STATE_CORRUPT', 'journal_line');
    if (bytes[offset] !== 10) continue;
    const line = bytes.subarray(start, offset + 1);
    const record = unseal(line, ['v', 'seq', 'prev', 'budget', 'event'], limits);
    eventRecord(record, limits, tip, used, claim.reservation);
    const next = transition(state, record.event, functions, limits);
    state = next.state;
    used[record.budget].bytes += line.length; used[record.budget].events++;
    tip = { v: 1, seq: record.seq, hash: record.hash, byte_length: offset + 1 };
    start = offset + 1;
  }
  if (start !== bytes.length || tip.seq === 0) fail('STATE_CORRUPT', 'journal_incomplete');
  const diskHead = headRecord(decode(await io.read(headPath, 4096), limits));
  if (!encode(diskHead, limits).equals(encode(tip, limits))) fail('STATE_CORRUPT', 'head_mismatch');
  const pinnedJournal = identity(await fs.lstat(journalPath));
  let poisoned = false;
  function healthy() { if (poisoned) fail('STATE_CORRUPT', 'writer_poisoned'); }
  async function current() {
    healthy();
    const fresh = headRecord(decode(await io.read(headPath, 4096), limits));
    if (!encode(fresh, limits).equals(encode(tip, limits))) fail('STATE_BUSY', 'stale_writer');
    await io.guard(journalPath);
    const stat = await fs.lstat(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== pinnedJournal || stat.size !== tip.byte_length) fail('STATE_CORRUPT', 'journal_identity');
  }
  function allocationFor(fileIndex, expected) {
    integer(fileIndex, limits.maxPlanFiles - 1);
    const reserved = claim.reservation.backups.find(item => item.fileIndex === fileIndex);
    if (!reserved) fail('STATE_CONFLICT', 'unreserved_backup');
    if (expected && ['expectedBytes', 'expectedSha256', 'mode'].some(key => expected[key] !== reserved[key])) fail('STATE_CONFLICT', 'backup_expectation');
    return reserved;
  }
  const writer = {
    get metadata() { return Object.freeze({ operationId: claim.operationId, tip: { ...tip }, used: structuredClone(used), state: structuredClone(state), poisoned }); },
    async requireBudget(request) {
      exact(request, ['bytes', 'events', 'budget'], 'STATE_INVALID');
      const { bytes: requiredBytes, events, budget } = request;
      if (!['apply', 'recovery'].includes(budget)) fail('STATE_INVALID', 'budget_class');
      integer(requiredBytes, limits.maxJournalBytes); integer(events, limits.maxJournalEvents);
      return owned.admit(async () => {
        await current();
        if (used[budget].bytes + requiredBytes > claim.reservation[`${budget}JournalBytes`] || used[budget].events + events > claim.reservation[`${budget}JournalEvents`]) fail('STATE_LIMIT', 'journal_budget');
        return true;
      });
    },
    async append(event, options) {
      exact(options, ['budget'], 'STATE_INVALID');
      const { budget } = options;
      // Capture at call time; mutations while awaiting admission cannot alter it.
      const captured = decode(encode(event, limits), limits);
      return owned.admit(async () => {
        await current();
        const next = nextRecord(captured, budget, tip, state, used, claim, functions, limits);
        checkSignal(io.signal);
        let handle, error;
        try {
          handle = await io.open(journalPath, 'r+', 'journal_open');
          if (identity(await handle.stat()) !== pinnedJournal) fail('STATE_CORRUPT', 'journal_identity');
          await io.write(handle, next.bytes, tip.byte_length, 'journal_write');
          await io.sync(handle, 'journal_sync');
        } catch (failure) { error = failure; }
        if (handle) { try { await io.close(handle, 'journal_close'); } catch (failure) { error ??= failure; } }
        if (error) { poisoned = true; throw error; }
        try { await io.publish(headPath, encode(next.head, limits), { replace: true, stage: 'head' }); }
        catch (failure) { poisoned = true; throw failure; }
        tip = next.head; state = next.state;
        used[budget].bytes += next.bytes.length; used[budget].events++;
        return writer.metadata;
      });
    },
    async createBackup(input) {
      exact(input, ['fileIndex', 'expectedBytes', 'expectedSha256', 'mode', 'read'], 'STATE_INVALID');
      const reserved = allocationFor(input.fileIndex, input);
      if (typeof input.read !== 'function') fail('STATE_INVALID', 'backup_reader');
      healthy();
      const file = path.join(dir, 'backups', `${reserved.fileIndex}.blob`);
      if (owned.backups.has(file) || owned.handles.has(file)) fail('STATE_BUSY', 'backup_occupied');
      owned.backups.add(file);
      try { return await owned.execute(async () => {
        checkSignal(io.signal);
        let handle;
        try { handle = await io.open(file, 'wx', 'backup_open'); }
        catch (error) { if (error.code === 'EEXIST') fail('STATE_CONFLICT', 'backup_exists'); throw error; }
        let written = 0, accepted = 0, error, sink, aborted, writeError;
        const pendingWrites = new Set();
        try {
          const pin = identity(await handle.stat()), digest = createHash('sha256');
          sink = new Writable({ highWaterMark: 65536, write(chunk, _encoding, callback) {
            const writing = (async () => {
              checkSignal(io.signal);
              // This is the actual dispatch boundary, including end(chunk),
              // which can bypass the public write() queue guard below.
              if (chunk.length > reserved.expectedBytes - written) fail('STATE_LIMIT', 'backup_bytes');
              await io.write(handle, chunk, written, 'backup_write');
              written += chunk.length; digest.update(chunk);
            })();
            pendingWrites.add(writing);
            writing.then(() => { pendingWrites.delete(writing); callback(); }, failure => {
              writeError ??= failure; pendingWrites.delete(writing); callback(failure);
            });
          } });
          const originalWrite = sink.write.bind(sink);
          sink.write = (chunk, encoding, callback) => {
            const length = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
            accepted += length;
            if (accepted > reserved.expectedBytes || sink.writableLength > 65536) {
              sink.destroy(new StateError('STATE_LIMIT', 'backup_bytes')); return false;
            }
            return originalWrite(chunk, encoding, callback);
          };
          aborted = () => sink.destroy(new StateError('STATE_BUSY', 'cancelled'));
          io.signal?.addEventListener('abort', aborted, { once: true });
          sink.on('error', () => {});
          const complete = finished(sink).catch(failure => { throw failure; });
          // finished() can settle at destroy before an asynchronous _write ends.
          // Track the dispatched filesystem work separately from stream lifetime.
          const reading = Promise.resolve().then(() => input.read(sink)).then(() => { sink.end(); }, failure => { sink.destroy(failure); throw failure; });
          const outcomes = await Promise.allSettled([reading, complete]);
          error = outcomes.find(r => r.status === 'rejected')?.reason;
          await Promise.allSettled([...pendingWrites]);
          error ??= writeError;
          if (error) throw error;
          checkSignal(io.signal);
          if (written !== reserved.expectedBytes || digest.digest('hex') !== reserved.expectedSha256) fail('STATE_CORRUPT', 'backup_digest');
          if (identity(await fs.lstat(file)) !== pin) fail('STATE_CORRUPT', 'backup_identity');
          await io.sync(handle, 'backup_sync');
        } catch (failure) { error ??= failure; }
        finally {
          if (aborted) io.signal?.removeEventListener('abort', aborted);
          sink?.destroy();
          await Promise.allSettled([...pendingWrites]);
          error ??= writeError;
          try { await io.close(handle, 'backup_close'); } catch (failure) { error ??= failure; }
        }
        if (error) throw error;
        await io.syncDirectory(path.dirname(file));
        return Object.freeze({ fileIndex: reserved.fileIndex, bytes: written, sha256: reserved.expectedSha256, mode: reserved.mode });
      }); } finally { owned.backups.delete(file); }
    },
    async openVerifiedBackup(index, expectation) {
      exact(expectation, ['expectedBytes', 'expectedSha256', 'mode'], 'STATE_INVALID');
      const reserved = allocationFor(index, expectation), file = path.join(dir, 'backups', `${index}.blob`);
      healthy();
      if (owned.backups.has(file) || owned.handles.has(file)) fail('STATE_BUSY', 'backup_occupied');
      owned.backups.add(file);
      try { return await owned.execute(async () => {
        const handle = await io.open(file, 'r', 'backup_read_open'); let error, pin;
        const digest = createHash('sha256'); let bytes = 0;
        try {
          const stat = await handle.stat(); pin = identity(stat);
          if (stat.size !== reserved.expectedBytes) fail('STATE_CORRUPT', 'backup_size');
          while (true) {
            checkSignal(io.signal);
            const buffer = Buffer.alloc(Math.min(65536, reserved.expectedBytes - bytes + 1));
            const { bytesRead } = await io.act('backup_read', () => handle.read(buffer, 0, buffer.length, bytes));
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > reserved.expectedBytes) fail('STATE_CORRUPT', 'backup_size');
            digest.update(buffer.subarray(0, bytesRead));
          }
          if (bytes !== reserved.expectedBytes || digest.digest('hex') !== reserved.expectedSha256) fail('STATE_CORRUPT', 'backup_digest');
          await io.guard(file);
          if (identity(await fs.lstat(file)) !== pin) fail('STATE_CORRUPT', 'backup_identity');
        } catch (failure) { error = failure; }
        if (error) { try { await io.close(handle, 'backup_read_close'); } catch {} throw error; }
        let closed = false, closing, active;
        const result = Object.freeze({
          fileIndex: index, bytes, sha256: reserved.expectedSha256, mode: reserved.mode,
          async revalidate() {
            try {
              if (closed) fail('STATE_BUSY', 'backup_closed'); await io.guard(file);
              const stat = await fs.lstat(file);
              if (identity(stat) !== pin || stat.size !== bytes) fail('STATE_CORRUPT', 'backup_identity');
            }
            catch (error) { throw safeFailure(error, 'backup_identity'); }
          },
          async read(buffer, offset, length, position) {
            if (closed) fail('STATE_BUSY', 'backup_closed');
            if (active) fail('STATE_BUSY', 'backup_read_occupied');
            integer(position, bytes); integer(length, Number.MAX_SAFE_INTEGER); integer(offset, Number.MAX_SAFE_INTEGER);
            active = owned.execute(async () => { await result.revalidate(); return io.act('backup_handle_read', () => handle.read(buffer, offset, Math.min(length, bytes - position), position)); });
            try { return await active; } finally { active = undefined; }
          },
          async close() {
            if (closing) return closing;
            closed = true;
            closing = (async () => { await active?.catch(() => {}); await io.close(handle, 'backup_read_close'); })()
              .catch(error => { throw safeFailure(error, 'backup_read_close'); }).finally(() => owned.handles.delete(file));
            return closing;
          },
        });
        owned.handles.set(file, result); return result;
      }); } finally { owned.backups.delete(file); }
    },
  };
  return writer;
}
