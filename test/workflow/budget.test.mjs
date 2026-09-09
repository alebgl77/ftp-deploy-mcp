import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, encode, decode, sha256, validateStateLimits } from '../../src/state/codec.mjs';
import { eventRecord, readClaimRecord, readPlanRecord, FIXED_BYTES } from '../../src/state/records.mjs';
import { reservationFor, journalEnvelope, claimEnvelope, frameEnvelope } from '../../src/workflow/budget.mjs';
import { encodePlan, workflowLimits } from '../../src/workflow/model.mjs';
import { createWorkflowPolicy } from '../../src/workflow/events.mjs';
import { plan, limits, runner, event, token, UUID } from './helpers.mjs';

function wideLimits() {
  return limits({}, { maxPlanFiles: 10000, maxPlanBytes: 33554432, maxJournalBytes: 268435456,
    maxJournalEvents: 500000, maxStateBytes: 17179869184, maxBackupBytes: 8589934592, maxBackupFiles: 100000 });
}
function verifyReplay(r, p, l) {
  const allocation = reservationFor(p, l), policy = createWorkflowPolicy(p, l);
  let previous = { seq: 0, hash: '0'.repeat(64) }, state;
  const used = { apply: { bytes: 0, events: 0 }, recovery: { bytes: 0, events: 0 } };
  for (const e of r.events) {
    const bytes = seal({ v: 1, seq: previous.seq + 1, prev: previous.hash, budget: e.scope, event: e }, l.stateLimits);
    const record = unseal(bytes, ['v', 'seq', 'prev', 'budget', 'event'], l.stateLimits);
    assert.ok(eventRecord(record, l.stateLimits, previous, used, allocation).equals(bytes));
    assert.equal(policy.validateEvent(record.event), true); state = policy.reduce(state, record.event);
    used[e.scope].bytes += bytes.length; used[e.scope].events++; previous = record;
  }
  assert.deepEqual(state, r.state); return { used, allocation };
}
test('finite reservation uses actual frame shapes and exact disjoint event formulas', () => {
  const p = plan(['U', 'C', 'A']), l = limits(), r = reservationFor(p, l);
  assert.equal(r.applyJournalEvents, 2 + 1 + 2 + 18 * 2); assert.equal(r.recoveryJournalEvents, 2 + 18 + 6);
  assert.equal(r.backupFiles, 1); assert.equal(r.backupBytes, 3);
  assert.deepEqual(r.backups, [{ fileIndex: 1, expectedBytes: 3, expectedSha256: p.files[1].before.sha256, mode: 420 }]);
  assert.ok(r.applyJournalBytes < r.applyJournalEvents * 512); assert.ok(r.recoveryJournalBytes < r.recoveryJournalEvents * 512);
  assert.deepEqual(Object.keys(r).sort(), ['applyJournalBytes', 'applyJournalEvents', 'recoveryJournalBytes', 'recoveryJournalEvents', 'backupBytes', 'backupFiles', 'metadataBytes', 'backups'].sort());
  assert.ok(Object.isFrozen(r.backups[0]));
});
test('INIT payload digest is distinct from the real sealed storage plan association', () => {
  const p = plan(), l = limits(), bytes = encodePlan(p, l), planId = `pln_${UUID}`;
  const sealed = seal({ v: 1, domainId: UUID, planId, payload: p }, l.stateLimits, l.stateLimits.maxPlanBytes);
  const record = readPlanRecord(sealed, planId, UUID, l.stateLimits), policy = createWorkflowPolicy(p, l);
  assert.notEqual(record.hash, sha256(bytes));
  assert.throws(() => policy.reduce(undefined, event('apply', 'INIT', { planDigest: record.hash, fileCount: 1 })));
  assert.doesNotThrow(() => policy.reduce(undefined, event('apply', 'INIT', { planDigest: sha256(bytes), fileCount: 1 })));
});
test('all unchanged and zero-length changed backups retain correct reservation semantics', () => {
  const u = reservationFor(plan(['U']), limits({}, { maxPlanFiles: 1 })); assert.equal(u.applyJournalEvents, 3); assert.equal(u.recoveryJournalEvents, 2);
  assert.equal(u.backupBytes, 0); assert.equal(u.backupFiles, 0); assert.deepEqual(u.backups, []);
  const p = plan(); p.files[0].before.bytes = 0;
  const c = reservationFor(p, limits()); assert.equal(c.backupFiles, 1); assert.equal(c.backupBytes, 0); assert.equal(c.backups.length, 1);
});
for (const n of [1, 2, 3, 5, 6, 9, 10, 11, 26, 27, 95, 96, 99, 100, 101, 263, 264, 999, 1000, 1001, 10000]) {
  test(`real frame category bounds hold at index/sequence digit boundary N=${n}`, () => {
    const l = wideLimits(), p = plan(Array.from({ length: n }, (_, i) => ['C', 'A', 'U'][i % 3]));
    const envelope = journalEnvelope(p, workflowLimits(l)), allocation = reservationFor(p, l);
    for (const scope of ['apply', 'recovery']) {
      let sumBytes = 0, sumEvents = 0;
      for (const category of Object.values(envelope[scope])) {
        sumBytes += category.count * category.bytes; sumEvents += category.count;
        let maximum = 0;
        for (const shape of category.events) for (const seq of [1, 9, 10, 99, 100, envelope.seq].filter(value => value <= envelope.seq)) {
          for (const mode of Object.hasOwn(shape, 'mode') ? [0, 7, 77, 420, 511] : [undefined]) {
            const e = mode === undefined ? shape : { ...shape, mode };
            const bytes = frameEnvelope(e, seq, l.stateLimits); assert.ok(bytes.length <= category.bytes);
            maximum = Math.max(maximum, bytes.length);
            const record = decode(bytes, l.stateLimits); assert.equal(record.budget, e.scope); assert.equal(record.event.scope, e.scope);
          }
        }
        assert.equal(maximum, category.bytes);
      }
      assert.equal(sumBytes, allocation[`${scope}JournalBytes`]); assert.equal(sumEvents, allocation[`${scope}JournalEvents`]);
    }
    const claim = claimEnvelope(allocation, l.stateLimits);
    assert.equal(allocation.metadataBytes, 2 * claim.length + 8192);
  });
}
test('FTP null modes and longest observed restoration proof are covered by actual canonical frames', () => {
  const p = plan(['C'], 'ftps'), l = limits(), envelope = journalEnvelope(p, workflowLimits(l));
  const staged = event('apply', 'STAGED', { i: 0, a: 3, mode: null });
  assert.equal(envelope.apply.staged.bytes, frameEnvelope(staged, envelope.seq, l.stateLimits).length);
  const observed = event('recovery', 'RESTORED', { i: 0, a: 3, proof: 'observed' });
  const ack = { ...observed, proof: 'ack' };
  assert.equal(frameEnvelope(observed, envelope.seq, l.stateLimits).length - frameEnvelope(ack, envelope.seq, l.stateLimits).length, 5);
  assert.ok(envelope.recovery.terminal.bytes >= frameEnvelope(observed, envelope.seq, l.stateLimits).length);
});
test('real replay fits reservation with three staged attempts in both namespaces and all backup/cleanup/global events', () => {
  const p = plan(['U', 'C', 'A']), l = limits({}, { maxPlanFiles: 3 }), r = runner(p, l);
  r.append('apply', 'SKIP', { i: 0 }); r.backup(1);
  for (const i of [1, 2]) for (let a = 1; a <= 3; a++) {
    r.stage(i, a, i * 10 + a); r.append('apply', 'PROMOTING', { i, a });
    if (a < 3) { r.append('apply', 'ATTEMPT_ABANDONED', { i, a }); r.append('apply', 'CLEANING', { i, a }); r.append('apply', 'CLEANED', { i, a }); }
    else r.append('apply', 'APPLIED', { i, a });
  }
  r.append('apply', 'APPLY_COMPLETE'); r.append('recovery', 'ROLLBACK_START');
  for (let a = 1; a <= 3; a++) { r.append('recovery', 'REMOVE_INTENT', { i: 2, a }); r.append('recovery', a === 3 ? 'REMOVED' : 'RECOVERY_ATTEMPT_ABANDONED', { i: 2, a }); }
  for (let a = 1; a <= 3; a++) {
    r.restore(1, a, 100 + a);
    r.append('recovery', a === 3 ? 'RESTORED' : 'RECOVERY_ATTEMPT_ABANDONED', { i: 1, a, ...(a === 3 ? { proof: 'observed' } : {}) });
    r.append('recovery', 'CLEANING', { i: 1, a }); r.append('recovery', 'CLEANED', { i: 1, a });
  }
  r.append('recovery', 'ROLLBACK_COMPLETE'); const { used, allocation } = verifyReplay(r, p, l);
  assert.equal(used.recovery.events, allocation.recoveryJournalEvents);
  assert.equal(used.apply.events, allocation.applyJournalEvents - 4); // acknowledged final promotions have no cleanup
});
test('alternate unowned/ack outcomes replay canonically inside the same bounded categories', () => {
  for (const outcome of ['SATISFIED_UNOWNED', 'APPLIED']) {
    const p = plan(), l = limits({}, { maxPlanFiles: 1 }), r = runner(p, l); r.backup(); r.stage(); r.append('apply', 'PROMOTING', { i: 0, a: 1 }); r.append('apply', outcome, { i: 0, a: 1 });
    r.append('apply', 'APPLY_COMPLETE'); r.append('recovery', 'ROLLBACK_START');
    if (outcome === 'APPLIED') { r.restore(); r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'ack' }); }
    r.append('recovery', 'ROLLBACK_COMPLETE'); verifyReplay(r, p, l);
  }
});
test('claim metadata fixes its own digit width using real storage grammar and maximum-width IDs/digests', () => {
  const l = wideLimits();
  for (const beforeBytes of [0, 9, 10, 99, 100, 999, 1000, 9999, 10000, 99999, 100000, 999999, 1000000]) {
    const p = plan(); p.files[0].before.bytes = beforeBytes; const allocation = reservationFor(p, l);
    const bytes = seal({ v: 1, domainId: UUID, planId: `pln_${UUID}`, planHash: 'e'.repeat(64), operationId: `op_${UUID}`,
      keyHash: 'f'.repeat(64), targetHash: '1'.repeat(64), reservation: allocation }, l.stateLimits, l.stateLimits.maxPlanBytes);
    assert.equal(bytes.length, claimEnvelope(allocation, l.stateLimits).length);
    assert.equal(allocation.metadataBytes, 2 * bytes.length + 8192);
    assert.deepEqual(readClaimRecord(bytes, `pln_${UUID}`, UUID, l.stateLimits).reservation, allocation);
    const { hash: digest, ...body } = unseal(bytes, ['v', 'domainId', 'planId', 'planHash', 'operationId', 'keyHash', 'targetHash', 'reservation'], l.stateLimits, l.stateLimits.maxPlanBytes);
    const bad = seal({ ...body,
      reservation: { ...allocation, metadataBytes: allocation.metadataBytes - 1 } }, l.stateLimits, l.stateLimits.maxPlanBytes);
    assert.throws(() => readClaimRecord(bad, `pln_${UUID}`, UUID, l.stateLimits));
  }
});
test('journal ceilings accept exact sums and reject one extra byte/event before claim', () => {
  const p = plan(), base = limits(), allocation = reservationFor(p, base);
  const bytes = allocation.applyJournalBytes + allocation.recoveryJournalBytes, events = allocation.applyJournalEvents + allocation.recoveryJournalEvents;
  assert.doesNotThrow(() => reservationFor(p, limits({}, { maxJournalBytes: bytes, maxJournalEvents: events })));
  assert.throws(() => reservationFor(p, limits({}, { maxJournalBytes: bytes - 1, maxJournalEvents: events })), error => error.code === 'STATE_LIMIT');
  assert.throws(() => reservationFor(p, limits({}, { maxJournalBytes: bytes, maxJournalEvents: events - 1 })), error => error.code === 'STATE_LIMIT');
});
test('state and backup ceilings accept equality and reject +1; no global occupied capacity is invented', () => {
  const p = plan(), l = limits({}, { maxPlanBytes: 4096, maxBackupBytes: 3, maxBackupFiles: 1 }), allocation = reservationFor(p, l);
  const required = FIXED_BYTES + 2 * l.stateLimits.maxPlanBytes + allocation.applyJournalBytes + allocation.recoveryJournalBytes + allocation.backupBytes + allocation.metadataBytes;
  assert.doesNotThrow(() => reservationFor(p, limits({}, { maxPlanBytes: 4096, maxStateBytes: required, maxBackupBytes: 3, maxBackupFiles: 1 })));
  assert.throws(() => reservationFor(p, limits({}, { maxPlanBytes: 4096, maxStateBytes: required - 1, maxBackupBytes: 3, maxBackupFiles: 1 })));
  assert.throws(() => reservationFor(p, limits({}, { maxBackupBytes: 2 })), error => error.code === 'STATE_LIMIT');
  assert.throws(() => reservationFor(plan(['C', 'C']), limits({}, { maxBackupFiles: 1 })), error => error.code === 'STATE_LIMIT');
});
test('real eventRecord charges only matching storage namespace and rejects +1 byte/event at saturation', () => {
  const p = plan(), l = limits(), allocation = reservationFor(p, l);
  for (const scope of ['apply', 'recovery']) {
    const e = event(scope, scope === 'apply' ? 'APPLY_COMPLETE' : 'ROLLBACK_COMPLETE');
    const record = decode(frameEnvelope(e, 1, l.stateLimits), l.stateLimits), size = encode(record, l.stateLimits).length;
    const previous = { seq: 0, hash: '0'.repeat(64) };
    const used = { apply: { bytes: allocation.applyJournalBytes, events: allocation.applyJournalEvents }, recovery: { bytes: allocation.recoveryJournalBytes, events: allocation.recoveryJournalEvents } };
    used[scope] = { bytes: allocation[`${scope}JournalBytes`] - size, events: allocation[`${scope}JournalEvents`] - 1 };
    assert.equal(eventRecord(record, l.stateLimits, previous, used, allocation).length, size);
    used[scope].bytes++; assert.throws(() => eventRecord(record, l.stateLimits, previous, used, allocation), error => error.code === 'STATE_LIMIT');
    used[scope].bytes--; used[scope].events++; assert.throws(() => eventRecord(record, l.stateLimits, previous, used, allocation), error => error.code === 'STATE_LIMIT');
  }
});
test('plan and claim cannot exceed library bounds and reduced state is admitted before reservation', () => {
  const p = plan(), length = encodePlan(p, limits()).length;
  assert.throws(() => reservationFor(p, limits({}, { maxPlanBytes: length })), error => error.code === 'STATE_LIMIT');
  assert.throws(() => reservationFor(plan(Array(10001).fill('C')), wideLimits()));
  assert.throws(() => reservationFor(p, { ...limits(), stateLimits: { maxStateBytes: 1, maxBackupBytes: 1 } }));
  assert.doesNotThrow(() => validateStateLimits({ maxPlanFiles: 1 }));
});
