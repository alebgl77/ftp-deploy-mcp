import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, sha256 } from '../../src/state/codec.mjs';
import { encodePlan } from '../../src/workflow/model.mjs';
import { createWorkflowPolicy, temporaryWarnings } from '../../src/workflow/events.mjs';
import { plan, limits, runner, event, token } from './helpers.mjs';

test('INIT binds payload digest and count, is unique, and captured plan is detached', () => {
  const p = plan(), l = limits(), digest = sha256(encodePlan(p, l)), policy = createWorkflowPolicy(p, l);
  p.files[0].bytes = 999; l.maxDeployBytes = 1;
  const first = event('apply', 'INIT', { planDigest: digest, fileCount: 1 });
  const initial = policy.reduce(undefined, first); assert.equal(initial.phase, 'APPLYING');
  assert.throws(() => policy.reduce(initial, first));
  assert.throws(() => policy.reduce(undefined, { ...first, fileCount: 2 }));
  assert.throws(() => policy.reduce(undefined, { ...first, planDigest: 'f'.repeat(64) }));
  assert.throws(() => policy.reduce(undefined, event('apply', 'SKIP', { i: 0 })));
  assert.ok(Object.isFrozen(initial.files[0].apply));
});
test('validation checks schema separately from transition; reducers are pure and bounded', () => {
  const r = runner(), e = event('apply', 'APPLIED', { i: 0, a: 1 }), before = structuredClone(r.state);
  assert.equal(r.policy.validateEvent(e), true); assert.throws(() => r.policy.reduce(r.state, e)); assert.deepEqual(r.state, before);
  const next = r.policy.reduce(r.state, event('apply', 'BACKUP_INTENT', { i: 0 })); assert.equal(next.files[0].backup, 'INTENT');
  assert.deepEqual(r.state, before); assert.ok(Buffer.isBuffer(encode(next, limits().stateLimits, limits().stateLimits.maxPlanBytes)));
  for (const bad of [{ ...e, v: 2 }, { ...e, extra: true }, { ...e, i: -1 }, { ...e, i: 1 }, { ...e, a: 0 }, { ...e, a: 4 }, { ...e, scope: 'config' }, { ...e, type: 'ERROR' }, { ...e, mode: null }]) assert.throws(() => r.policy.validateEvent(bad));
  for (const bad of [{ ...r.state, v: 2 }, { ...r.state, extra: true }, { ...r.state, phase: 'RUNNING' }, { ...r.state, applyCharged: 1 }]) assert.throws(() => r.policy.reduce(bad, event('apply', 'BACKUP_INTENT', { i: 0 })));
});
test('all changed-existing backups must be ready before any staging', () => {
  const r = runner(plan(['C', 'C', 'A']));
  assert.throws(() => r.append('apply', 'STAGE_INTENT', { i: 2, a: 1, token: token(1) }));
  r.backup(0); assert.throws(() => r.append('apply', 'STAGE_INTENT', { i: 0, a: 1, token: token(1) }));
  r.backup(1); r.stage(0); assert.equal(r.state.applyCharged, 3);
  assert.throws(() => r.append('apply', 'BACKUP_READY', { i: 0 })); assert.throws(() => r.append('apply', 'BACKUP_INTENT', { i: 1 }));
  assert.throws(() => r.append('apply', 'BACKUP_INTENT', { i: 2 }));
});
test('SKIP is only unchanged, once, permanently unowned, and has no attempts or backups', () => {
  const p = plan(['U']), r = runner(p);
  assert.throws(() => r.append('apply', 'BACKUP_INTENT', { i: 0 })); assert.throws(() => r.stage());
  r.append('apply', 'SKIP', { i: 0 }); assert.throws(() => r.append('apply', 'SKIP', { i: 0 }));
  r.append('apply', 'APPLY_COMPLETE'); assert.equal(r.state.phase, 'COMPLETED');
  r.append('recovery', 'ROLLBACK_START'); assert.throws(() => r.restore());
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, 'ROLLED_BACK'); assert.equal(r.state.files[0].state, 'SKIPPED');
  assert.throws(() => runner().append('apply', 'SKIP', { i: 0 }));
});
test('matching desired content after uncertain promotion only yields SATISFIED_UNOWNED', () => {
  const r = runner(); r.backup(); r.stage();
  assert.throws(() => r.append('apply', 'SATISFIED_UNOWNED', { i: 0, a: 1 }));
  r.append('apply', 'PROMOTING', { i: 0, a: 1 }); r.append('apply', 'SATISFIED_UNOWNED', { i: 0, a: 1 });
  assert.equal(r.state.files[0].apply.a1.phase, 'SATISFIED'); assert.equal(temporaryWarnings(r.state), 1);
  for (const type of ['APPLIED', 'ATTEMPT_ABANDONED', 'SATISFIED_UNOWNED']) assert.throws(() => r.append('apply', type, { i: 0, a: 1 }));
  r.append('apply', 'CLEANING', { i: 0, a: 1 }); r.append('apply', 'CLEANED', { i: 0, a: 1 }); assert.equal(temporaryWarnings(r.state), 0);
  r.append('apply', 'APPLY_COMPLETE'); assert.equal(r.state.phase, 'COMPLETED_WITH_WARNINGS');
  r.append('recovery', 'ROLLBACK_START'); assert.throws(() => r.restore()); r.append('recovery', 'ROLLBACK_COMPLETE');
  assert.equal(r.state.phase, 'ROLLBACK_WITH_WARNINGS'); assert.equal(r.state.files[0].state, 'SATISFIED_UNOWNED');
});
test('only acknowledged APPLIED becomes eligible; completed restored-before drift has no replay event', () => {
  const r = runner(); r.backup(); r.stage(); r.promote();
  assert.equal(r.state.files[0].state, 'APPLIED'); assert.equal(temporaryWarnings(r.state), 0);
  assert.throws(() => r.stage(0, 2)); assert.throws(() => r.append('apply', 'APPLIED', { i: 0, a: 1 }));
  r.append('apply', 'APPLY_COMPLETE'); r.append('recovery', 'ROLLBACK_START'); r.restore();
  r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'ack' });
  assert.equal(temporaryWarnings(r.state), 0); assert.throws(() => r.restore(0, 2));
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, 'ROLLED_BACK');
  assert.throws(() => r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'observed' }));
});
for (const proof of ['ack', 'observed']) test(`RESTORED proof ${proof} retains exact evidence and corresponding warning`, () => {
  const r = runner(); r.backup(); r.stage(); r.promote(); r.append('recovery', 'ROLLBACK_START'); r.restore();
  r.append('recovery', 'RESTORED', { i: 0, a: 1, proof }); assert.equal(r.state.files[0].recovery.a1.proof, proof);
  assert.equal(temporaryWarnings(r.state), proof === 'observed' ? 1 : 0);
  if (proof === 'ack') assert.throws(() => r.append('recovery', 'CLEANING', { i: 0, a: 1 }));
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, proof === 'observed' ? 'ROLLBACK_WITH_WARNINGS' : 'ROLLED_BACK');
});
test('observed restoration warning is cleared only by independent CLEANING/CLEANED', () => {
  const r = runner(); r.backup(); r.stage(); r.promote(); r.append('recovery', 'ROLLBACK_START'); r.restore();
  assert.throws(() => r.append('recovery', 'RESTORED', { i: 0, a: 1 }));
  r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'observed' });
  r.append('recovery', 'CLEANING', { i: 0, a: 1 }); assert.equal(temporaryWarnings(r.state), 1);
  r.append('recovery', 'CLEANED', { i: 0, a: 1 }); assert.equal(temporaryWarnings(r.state), 0);
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, 'ROLLED_BACK');
});
test('FTP null mode still requires and preserves durable restoration stage proof', () => {
  const p = plan(['C'], 'ftps'), r = runner(p, limits({}, { maxPlanFiles: 1 }));
  r.backup(); r.stage(); r.promote(); r.append('recovery', 'ROLLBACK_START');
  r.append('recovery', 'RESTORE_INTENT', { i: 0, a: 1, token: token(11) });
  assert.throws(() => r.append('recovery', 'CLEANING', { i: 0, a: 1 }));
  r.append('recovery', 'RESTORE_STAGED', { i: 0, a: 1, mode: null }); r.append('recovery', 'RESTORING', { i: 0, a: 1 });
  r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'observed' });
  assert.equal(r.state.files[0].recovery.a1.staged, true); assert.equal(r.state.files[0].recovery.a1.mode, null); assert.equal(temporaryWarnings(r.state), 1);
});
test('three ordered apply slots preserve tokens, charge failed attempts and reject fourth', () => {
  const p = plan(), l = limits({}, { maxPlanFiles: 1 }), r = runner(p, l); r.backup();
  assert.throws(() => r.stage(0, 2)); r.stage(); assert.throws(() => r.stage(0, 2));
  r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 });
  assert.throws(() => r.stage(0, 2, 1)); assert.throws(() => r.stage(0, 3, 3));
  r.stage(0, 2); r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 2 }); r.stage(0, 3); r.promote(0, 3);
  assert.equal(r.state.applyCharged, 9); assert.deepEqual(Object.keys(r.state.files[0].apply), ['a1', 'a2', 'a3']);
  assert.equal(r.state.files[0].apply.a1.token, token(1)); assert.equal(temporaryWarnings(r.state), 2);
  assert.throws(() => r.stage(0, 4)); r.append('apply', 'APPLY_COMPLETE'); assert.equal(r.state.phase, 'COMPLETED_WITH_WARNINGS');
});
test('all three recovery slots work with maxPlanFiles=1; apply and recovery charges are independent', () => {
  const p = plan(), l = limits({ maxDeployBytes: 9 }, { maxPlanFiles: 1 }), r = runner(p, l); r.backup();
  for (let a = 1; a <= 3; a++) { r.stage(0, a); if (a < 3) r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a }); else r.promote(0, a); }
  r.append('recovery', 'ROLLBACK_START'); assert.throws(() => r.restore(0, 2));
  for (let a = 1; a <= 3; a++) {
    r.restore(0, a); if (a < 3) r.append('recovery', 'RECOVERY_ATTEMPT_ABANDONED', { i: 0, a });
    else r.append('recovery', 'RESTORED', { i: 0, a, proof: 'observed' });
  }
  assert.equal(r.state.applyCharged, 9); assert.equal(r.state.recoveryCharged, 9); assert.equal(temporaryWarnings(r.state), 5);
  assert.equal(Object.keys(r.state.files[0].recovery).length, 3); assert.throws(() => r.restore(0, 4));
});
test('exact transfer budget saturation rejects +1 before changing state for each scope', () => {
  for (const scope of ['apply', 'recovery']) {
    const p = plan(), l = limits({ maxDeployBytes: 5 }), r = runner(p, l); r.backup(); r.stage();
    if (scope === 'apply') r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 });
    else { r.promote(); r.append('recovery', 'ROLLBACK_START'); r.restore(); r.append('recovery', 'RECOVERY_ATTEMPT_ABANDONED', { i: 0, a: 1 }); }
    const before = structuredClone(r.state);
    assert.throws(() => scope === 'apply' ? r.stage(0, 2) : r.restore(0, 2), error => error.code === 'STATE_LIMIT'); assert.deepEqual(r.state, before);
  }
  const p = plan(); p.files[0].bytes = 1; p.files[0].before.bytes = 1;
  const r = runner(p, limits({ maxDeployBytes: 2 })); r.backup(); r.stage(); r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }); r.stage(0, 2);
  r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 2 }); assert.throws(() => r.stage(0, 3), error => error.code === 'STATE_LIMIT'); assert.equal(r.state.applyCharged, 2);
});
test('tokens cannot be reused across file, phase, cleanup or abandoned evidence', () => {
  const r = runner(plan(['C', 'C'])); r.backup(0); r.backup(1); r.stage(0, 1, 1);
  r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }); r.append('apply', 'CLEANING', { i: 0, a: 1 }); r.append('apply', 'CLEANED', { i: 0, a: 1 });
  assert.throws(() => r.stage(1, 1, 1)); r.stage(1, 1, 2); r.promote(1);
  r.append('recovery', 'ROLLBACK_START'); assert.throws(() => r.restore(1, 1, 1)); assert.throws(() => r.restore(1, 1, 2));
});
for (const phase of ['INTENT', 'STAGED', 'PROMOTING']) test(`abandonment at ${phase} is terminal and preserves stage proof`, () => {
  const r = runner(); r.backup(); r.append('apply', 'STAGE_INTENT', { i: 0, a: 1, token: token(1) });
  if (phase !== 'INTENT') r.append('apply', 'STAGED', { i: 0, a: 1, mode: 420 });
  if (phase === 'PROMOTING') r.append('apply', 'PROMOTING', { i: 0, a: 1 });
  r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 });
  assert.equal(r.state.files[0].apply.a1.staged, phase !== 'INTENT'); assert.equal(temporaryWarnings(r.state), 1);
  assert.throws(() => r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }));
  assert.throws(() => r.append('apply', 'APPLIED', { i: 0, a: 1 }));
});
test('cleanup needs durable staged proof, is once-only and prevents subsequent promotion', () => {
  const r = runner(plan(['C'], 'ftps')); r.backup(); r.append('apply', 'STAGE_INTENT', { i: 0, a: 1, token: token(1) });
  assert.throws(() => r.append('apply', 'CLEANING', { i: 0, a: 1 }));
  r.append('apply', 'STAGED', { i: 0, a: 1, mode: null }); assert.equal(r.state.files[0].apply.a1.staged, true);
  assert.throws(() => r.append('apply', 'CLEANED', { i: 0, a: 1 })); r.append('apply', 'CLEANING', { i: 0, a: 1 });
  assert.throws(() => r.append('apply', 'CLEANING', { i: 0, a: 1 })); assert.throws(() => r.append('apply', 'PROMOTING', { i: 0, a: 1 }));
  r.append('apply', 'CLEANED', { i: 0, a: 1 }); assert.throws(() => r.append('apply', 'CLEANED', { i: 0, a: 1 }));
  assert.throws(() => r.append('apply', 'PROMOTING', { i: 0, a: 1 })); assert.equal(temporaryWarnings(r.state), 0);
  r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }); r.stage(0, 2); r.promote(0, 2);
  assert.throws(() => r.append('apply', 'CLEANING', { i: 0, a: 2 }));
});
test('recovery cleaning prevents restoring but permits observed goal reconciliation', () => {
  const r = runner(); r.backup(); r.stage(); r.promote(); r.append('recovery', 'ROLLBACK_START');
  r.append('recovery', 'RESTORE_INTENT', { i: 0, a: 1, token: token(11) }); r.append('recovery', 'RESTORE_STAGED', { i: 0, a: 1, mode: 420 });
  r.append('recovery', 'CLEANING', { i: 0, a: 1 }); assert.throws(() => r.append('recovery', 'RESTORING', { i: 0, a: 1 }));
  r.append('recovery', 'RECOVERY_ATTEMPT_ABANDONED', { i: 0, a: 1 }); r.restore(0, 2);
  r.append('recovery', 'CLEANING', { i: 0, a: 2 }); r.append('recovery', 'CLEANED', { i: 0, a: 2 });
  assert.throws(() => r.append('recovery', 'RESTORED', { i: 0, a: 2, proof: 'ack' }));
  r.append('recovery', 'RESTORED', { i: 0, a: 2, proof: 'observed' }); assert.equal(temporaryWarnings(r.state), 1);
});
test('new absent-file removal has no token, mode, backup, staging or byte charge; retry is bounded', () => {
  const r = runner(plan(['A'])); r.stage(); r.promote(); r.append('recovery', 'ROLLBACK_START');
  assert.throws(() => r.restore());
  for (let a = 1; a <= 3; a++) {
    r.append('recovery', 'REMOVE_INTENT', { i: 0, a }); assert.throws(() => r.append('recovery', 'CLEANING', { i: 0, a }));
    assert.throws(() => r.append('recovery', 'RESTORED', { i: 0, a, proof: 'observed' }));
    r.append('recovery', a < 3 ? 'RECOVERY_ATTEMPT_ABANDONED' : 'REMOVED', { i: 0, a });
  }
  assert.equal(r.state.recoveryCharged, 0); assert.equal(temporaryWarnings(r.state), 0);
  assert.throws(() => r.append('recovery', 'REMOVE_INTENT', { i: 0, a: 4 }));
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, 'ROLLED_BACK');
});
test('rollback begins from interrupted apply, descends eligible indices and never touches pending or skipped', () => {
  const r = runner(plan(['C', 'U', 'A'])); r.backup(0); r.stage(0, 1, 1); r.promote(0); r.append('apply', 'SKIP', { i: 1 }); r.stage(2, 1, 2); r.promote(2);
  r.append('recovery', 'ROLLBACK_START'); assert.throws(() => r.restore(0)); assert.throws(() => r.append('recovery', 'ROLLBACK_COMPLETE'));
  r.append('recovery', 'REMOVE_INTENT', { i: 2, a: 1 }); r.append('recovery', 'REMOVED', { i: 2, a: 1 });
  r.restore(0); r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'ack' }); r.append('recovery', 'ROLLBACK_COMPLETE');
  assert.equal(r.state.phase, 'ROLLED_BACK'); assert.equal(r.state.files[1].state, 'SKIPPED');
  const pending = runner(); pending.append('recovery', 'ROLLBACK_START'); assert.throws(() => pending.restore());
  pending.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(pending.state.files[0].state, 'PENDING');
});
test('every apply event is refused after completion or ROLLBACK_START including old cleanup', () => {
  const p = plan(), r = runner(p); r.backup(); r.stage(); r.promote(); r.append('apply', 'APPLY_COMPLETE');
  const applyEvents = [event('apply', 'INIT', { planDigest: sha256(encodePlan(p, limits())), fileCount: 1 }), ...r.events.slice(1),
    event('apply', 'SKIP', { i: 0 }), event('apply', 'SATISFIED_UNOWNED', { i: 0, a: 1 }), event('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }),
    event('apply', 'CLEANING', { i: 0, a: 1 }), event('apply', 'CLEANED', { i: 0, a: 1 })];
  for (const e of applyEvents) assert.throws(() => r.policy.reduce(r.state, e));
  r.append('recovery', 'ROLLBACK_START'); for (const e of applyEvents) assert.throws(() => r.policy.reduce(r.state, e));
  assert.throws(() => r.append('recovery', 'ROLLBACK_START'));
});
test('every recovery event needs ROLLING_BACK and globals are once-only', () => {
  const r = runner(); r.backup(); r.stage(); r.promote(); const before = r.state;
  r.append('recovery', 'ROLLBACK_START'); r.restore(); r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'observed' });
  r.append('recovery', 'CLEANING', { i: 0, a: 1 }); r.append('recovery', 'CLEANED', { i: 0, a: 1 }); r.append('recovery', 'ROLLBACK_COMPLETE');
  const recovery = [...r.events.filter(e => e.scope === 'recovery' && e.type !== 'ROLLBACK_START'),
    event('recovery', 'REMOVE_INTENT', { i: 0, a: 1 }), event('recovery', 'REMOVED', { i: 0, a: 1 }), event('recovery', 'RECOVERY_ATTEMPT_ABANDONED', { i: 0, a: 1 })];
  for (const e of recovery) { assert.throws(() => r.policy.reduce(before, e)); assert.throws(() => r.policy.reduce(r.state, e)); }
  assert.throws(() => r.append('recovery', 'ROLLBACK_START'));
});
test('temporary evidence remains after irrevocable rollback start and operation completion', () => {
  const r = runner(); r.backup(); r.stage(); r.append('apply', 'ATTEMPT_ABANDONED', { i: 0, a: 1 }); r.stage(0, 2); r.promote(0, 2);
  r.append('apply', 'APPLY_COMPLETE'); assert.equal(r.state.phase, 'COMPLETED_WITH_WARNINGS');
  assert.throws(() => r.append('apply', 'CLEANING', { i: 0, a: 1 })); r.append('recovery', 'ROLLBACK_START');
  assert.throws(() => r.append('apply', 'CLEANING', { i: 0, a: 1 })); r.restore(); r.append('recovery', 'RESTORED', { i: 0, a: 1, proof: 'ack' });
  r.append('recovery', 'ROLLBACK_COMPLETE'); assert.equal(r.state.phase, 'ROLLBACK_WITH_WARNINGS'); assert.equal(temporaryWarnings(r.state), 1);
});
test('mode proof is exact, token grammar is fixed, and future reduced-state size is preflighted', () => {
  const p = plan(), r = runner(p); r.backup();
  for (const value of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) assert.throws(() => r.append('apply', 'STAGE_INTENT', { i: 0, a: 1, token: value }));
  r.append('apply', 'STAGE_INTENT', { i: 0, a: 1, token: token(1) });
  for (const mode of [null, 0, 511, 512, -1]) assert.throws(() => r.append('apply', 'STAGED', { i: 0, a: 1, mode }));
  const bytes = encodePlan(p, limits()); assert.doesNotThrow(() => encodePlan(p, limits({}, { maxPlanBytes: bytes.length })));
  assert.throws(() => createWorkflowPolicy(p, limits({}, { maxPlanBytes: bytes.length })), error => error.code === 'STATE_LIMIT');
  const skipped = plan(['U']), skipBytes = encodePlan(skipped, limits());
  assert.doesNotThrow(() => createWorkflowPolicy(skipped, limits({}, { maxPlanBytes: skipBytes.length })));
});
