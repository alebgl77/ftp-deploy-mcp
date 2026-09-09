import { encode, decode, exact, integer, hash, sha256, fail } from '../state/codec.mjs';
import { encodePlan, decodePlan, workflowLimits, immutable, unchanged } from './model.mjs';

const GRAMMAR = immutable({
  apply: { INIT: ['planDigest', 'fileCount'], SKIP: ['i'], BACKUP_INTENT: ['i'], BACKUP_READY: ['i'],
    STAGE_INTENT: ['i', 'a', 'token'], STAGED: ['i', 'a', 'mode'], PROMOTING: ['i', 'a'], APPLIED: ['i', 'a'],
    SATISFIED_UNOWNED: ['i', 'a'], ATTEMPT_ABANDONED: ['i', 'a'], APPLY_COMPLETE: [], CLEANING: ['i', 'a'], CLEANED: ['i', 'a'] },
  recovery: { ROLLBACK_START: [], RESTORE_INTENT: ['i', 'a', 'token'], RESTORE_STAGED: ['i', 'a', 'mode'],
    RESTORING: ['i', 'a'], RESTORED: ['i', 'a', 'proof'], REMOVE_INTENT: ['i', 'a'], REMOVED: ['i', 'a'],
    RECOVERY_ATTEMPT_ABANDONED: ['i', 'a'], ROLLBACK_COMPLETE: [], CLEANING: ['i', 'a'], CLEANED: ['i', 'a'] },
});
const TOKEN = /^[a-f0-9]{32}$/;
const SLOTS = ['a1', 'a2', 'a3'];
const APPLY_TERMINAL = ['ABANDONED', 'PROMOTED', 'SATISFIED'];
const RECOVERY_TERMINAL = ['ABANDONED', 'RESTORED', 'REMOVED'];
const PHASES = ['APPLYING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_WITH_WARNINGS'];
const check = (condition) => { if (!condition) fail('STATE_CORRUPT', 'workflow_transition'); };
const emptySlots = () => ({ a1: null, a2: null, a3: null });
const row = () => ({ state: 'PENDING', backup: 'NONE', apply: emptySlots(), recovery: emptySlots() });
const slot = (phase, token = null) => ({ phase, token, mode: null, staged: false, cleanup: 'NONE', proof: null });
const terminal = (scope, value) => (scope === 'apply' ? APPLY_TERMINAL : RECOVERY_TERMINAL).includes(value.phase);
export function temporaryWarnings(state) {
  let warnings = 0;
  for (const file of state.files) for (const scope of ['apply', 'recovery']) for (const value of Object.values(file[scope])) {
    if (value?.token && value.cleanup !== 'CLEANED' && value.phase !== 'PROMOTED' &&
        !(value.phase === 'RESTORED' && value.proof === 'ack')) warnings++;
  }
  return warnings;
}
function warningCompletion(state) { return temporaryWarnings(state) > 0 || state.files.some(file => file.state === 'SATISFIED_UNOWNED'); }
function initial(plan, digest) {
  return { v: 1, phase: 'APPLYING', planDigest: digest, applyCharged: 0, recoveryCharged: 0, files: plan.files.map(row) };
}
export function assertStateCapacity(plan, limits) {
  const state = initial(plan, '0'.repeat(64));
  state.phase = 'COMPLETED_WITH_WARNINGS';
  state.applyCharged = limits.maxDeployBytes; state.recoveryCharged = limits.maxDeployBytes;
  for (const [i, file] of state.files.entries()) {
    if (unchanged(plan.files[i])) { file.state = 'SKIPPED'; continue; }
    file.state = 'SATISFIED_UNOWNED'; file.backup = 'INTENT';
    for (const scope of ['apply', 'recovery']) for (const key of SLOTS) {
      // Independent field maxima intentionally overestimate reachable states.
      file[scope][key] = { phase: 'RESTORING', token: '0'.repeat(32), mode: null, staged: false, cleanup: 'CLEANING', proof: 'observed' };
    }
  }
  encode(state, limits.stateLimits, limits.stateLimits.maxPlanBytes);
}
function validateState(state, plan, digest, limits) {
  exact(state, ['v', 'phase', 'planDigest', 'applyCharged', 'recoveryCharged', 'files']);
  check(state.v === 1 && PHASES.includes(state.phase) && state.planDigest === digest);
  integer(state.applyCharged, limits.maxDeployBytes, 'STATE_CORRUPT'); integer(state.recoveryCharged, limits.maxDeployBytes, 'STATE_CORRUPT');
  check(Array.isArray(state.files) && state.files.length === plan.files.length);
  let applyCharged = 0, recoveryCharged = 0;
  const tokens = new Set();
  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i], planned = plan.files[i];
    exact(file, ['state', 'backup', 'apply', 'recovery']);
    check(['PENDING', 'SKIPPED', 'APPLIED', 'SATISFIED_UNOWNED', 'ROLLED_BACK'].includes(file.state));
    check(['NONE', 'INTENT', 'READY'].includes(file.backup));
    if (unchanged(planned) || planned.before.kind === 'absent') check(file.backup === 'NONE');
    if (file.state === 'SKIPPED') check(unchanged(planned));
    for (const scope of ['apply', 'recovery']) {
      exact(file[scope], SLOTS);
      let seenEmpty = false, predecessor;
      for (const key of SLOTS) {
        const value = file[scope][key];
        if (value === null) { seenEmpty = true; continue; }
        check(!seenEmpty && (!predecessor || terminal(scope, predecessor)));
        exact(value, ['phase', 'token', 'mode', 'staged', 'cleanup', 'proof']);
        const phases = scope === 'apply' ? ['INTENT', 'STAGED', 'PROMOTING', ...APPLY_TERMINAL] :
          planned.before.kind === 'absent' ? ['REMOVING', 'REMOVED', 'ABANDONED'] : ['INTENT', 'STAGED', 'RESTORING', 'RESTORED', 'ABANDONED'];
        check(phases.includes(value.phase) && typeof value.staged === 'boolean' && ['NONE', 'CLEANING', 'CLEANED'].includes(value.cleanup));
        if (scope === 'recovery' && planned.before.kind === 'absent') {
          check(value.token === null && value.mode === null && !value.staged && value.cleanup === 'NONE');
        } else {
          check(typeof value.token === 'string' && TOKEN.test(value.token) && !tokens.has(value.token));
          tokens.add(value.token);
          check(!unchanged(planned));
          if (planned.before.kind === 'file') check(file.backup === 'READY');
          const mode = scope === 'apply' ? planned.desiredMode : planned.before.mode;
          check(value.staged ? value.mode === mode : value.mode === null && value.cleanup === 'NONE');
          if (['STAGED', 'PROMOTING', 'PROMOTED', 'SATISFIED', 'RESTORING', 'RESTORED'].includes(value.phase)) check(value.staged);
          if (value.phase === 'INTENT') check(!value.staged);
        }
        check(value.phase === 'RESTORED' ? ['ack', 'observed'].includes(value.proof) : value.proof === null);
        if (value.phase === 'PROMOTED' || value.phase === 'RESTORED' && value.proof === 'ack') check(value.cleanup === 'NONE');
        if (scope === 'apply') applyCharged += planned.bytes;
        else if (planned.before.kind === 'file') recoveryCharged += planned.before.bytes;
        predecessor = value;
      }
    }
    const applied = Object.values(file.apply).some(value => value?.phase === 'PROMOTED');
    const satisfied = Object.values(file.apply).some(value => value?.phase === 'SATISFIED');
    const restored = Object.values(file.recovery).some(value => ['RESTORED', 'REMOVED'].includes(value?.phase));
    check(applied === ['APPLIED', 'ROLLED_BACK'].includes(file.state));
    check(satisfied === (file.state === 'SATISFIED_UNOWNED'));
    check(restored === (file.state === 'ROLLED_BACK'));
    if (file.state === 'SKIPPED' || unchanged(planned)) check(Object.values(file.apply).every(value => value === null));
    if (Object.values(file.recovery).some(Boolean)) check(applied);
  }
  check(applyCharged === state.applyCharged && recoveryCharged === state.recoveryCharged);
  if (['APPLYING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(state.phase)) check(state.files.every(file => Object.values(file.recovery).every(value => value === null)));
  if (['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(state.phase)) {
    check(state.files.every(file => ['APPLIED', 'SKIPPED', 'SATISFIED_UNOWNED'].includes(file.state)));
    check(state.phase === (warningCompletion(state) ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'));
  }
  if (['ROLLED_BACK', 'ROLLBACK_WITH_WARNINGS'].includes(state.phase)) {
    check(state.files.every(file => file.state !== 'APPLIED'));
    check(state.phase === (warningCompletion(state) ? 'ROLLBACK_WITH_WARNINGS' : 'ROLLED_BACK'));
  }
}
export function createWorkflowPolicy(plan, suppliedLimits) {
  const limits = workflowLimits(suppliedLimits), codecLimits = limits.stateLimits;
  const bytes = encodePlan(plan, limits), captured = decodePlan(bytes, limits), digest = sha256(bytes);
  assertStateCapacity(captured, limits);
  function captureEvent(event) {
    const value = decode(encode(event, codecLimits), codecLimits);
    check(value.v === 1 && typeof value.scope === 'string' && Object.hasOwn(GRAMMAR, value.scope));
    check(typeof value.type === 'string' && Object.hasOwn(GRAMMAR[value.scope], value.type));
    const fields = GRAMMAR[value.scope][value.type]; exact(value, ['v', 'scope', 'type', ...fields]);
    if (fields.includes('i')) integer(value.i, captured.files.length - 1, 'STATE_CORRUPT');
    if (fields.includes('a')) integer(value.a, 3, 'STATE_CORRUPT', 1);
    if (fields.includes('token')) check(typeof value.token === 'string' && TOKEN.test(value.token));
    if (fields.includes('mode')) check(value.mode === (value.scope === 'apply' ? captured.files[value.i].desiredMode : captured.files[value.i].before.mode));
    if (fields.includes('proof')) check(['ack', 'observed'].includes(value.proof));
    if (value.type === 'INIT') { hash(value.planDigest, 'STATE_CORRUPT'); check(value.planDigest === digest && value.fileCount === captured.files.length); }
    return value;
  }
  function reduce(previous, suppliedEvent) {
    const event = captureEvent(suppliedEvent);
    if (event.type === 'INIT') { check(previous === undefined); return immutable(initial(captured, digest)); }
    check(previous !== undefined);
    const state = decode(encode(previous, codecLimits, codecLimits.maxPlanBytes), codecLimits, codecLimits.maxPlanBytes);
    validateState(state, captured, digest, limits);
    if (event.scope === 'apply') check(state.phase === 'APPLYING');
    else if (event.type === 'ROLLBACK_START') check(['APPLYING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(state.phase));
    else check(state.phase === 'ROLLING_BACK');
    const file = state.files[event.i], planned = captured.files[event.i];
    const attempts = file?.[event.scope], key = `a${event.a}`, attempt = attempts?.[key];
    function nextAttempt(phase, token) {
      check(attempt === null);
      for (let a = 1; a < event.a; a++) check(attempts[`a${a}`] !== null && terminal(event.scope, attempts[`a${a}`]));
      for (let a = event.a + 1; a <= 3; a++) check(attempts[`a${a}`] === null);
      if (token) for (const other of state.files) for (const scope of ['apply', 'recovery']) for (const value of Object.values(other[scope])) check(value?.token !== token);
      attempts[key] = slot(phase, token);
    }
    function charge(scope, amount) {
      const field = scope === 'apply' ? 'applyCharged' : 'recoveryCharged';
      if (amount > limits.maxDeployBytes - state[field]) fail('STATE_LIMIT', 'workflow_transfer_budget');
      state[field] += amount;
    }
    function recoveryFile(kind) {
      check(file.state === 'APPLIED' && planned.before.kind === kind);
      for (let i = event.i + 1; i < state.files.length; i++) check(state.files[i].state !== 'APPLIED');
    }
    switch (event.type) {
      case 'SKIP': check(file.state === 'PENDING' && unchanged(planned) && Object.values(file.apply).every(value => value === null)); file.state = 'SKIPPED'; break;
      case 'BACKUP_INTENT': check(file.state === 'PENDING' && !unchanged(planned) && planned.before.kind === 'file' && file.backup === 'NONE'); file.backup = 'INTENT'; break;
      case 'BACKUP_READY': check(file.state === 'PENDING' && file.backup === 'INTENT'); file.backup = 'READY'; break;
      case 'STAGE_INTENT':
        check(file.state === 'PENDING' && !unchanged(planned));
        check(state.files.every((other, i) => unchanged(captured.files[i]) || captured.files[i].before.kind === 'absent' || other.backup === 'READY'));
        nextAttempt('INTENT', event.token); charge('apply', planned.bytes); break;
      case 'STAGED': case 'RESTORE_STAGED':
        check(attempt?.phase === 'INTENT'); attempt.phase = 'STAGED'; attempt.mode = event.mode; attempt.staged = true; break;
      case 'PROMOTING': case 'RESTORING':
        check(attempt?.phase === 'STAGED' && attempt.cleanup === 'NONE'); attempt.phase = event.type; break;
      case 'APPLIED': case 'SATISFIED_UNOWNED':
        check(file.state === 'PENDING' && attempt?.phase === 'PROMOTING');
        check(event.type === 'SATISFIED_UNOWNED' || attempt.cleanup === 'NONE');
        attempt.phase = event.type === 'APPLIED' ? 'PROMOTED' : 'SATISFIED'; file.state = event.type; break;
      case 'ATTEMPT_ABANDONED':
        check(file.state === 'PENDING' && ['INTENT', 'STAGED', 'PROMOTING'].includes(attempt?.phase)); attempt.phase = 'ABANDONED'; break;
      case 'APPLY_COMPLETE':
        check(state.files.every(value => ['APPLIED', 'SKIPPED', 'SATISFIED_UNOWNED'].includes(value.state)));
        state.phase = warningCompletion(state) ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'; break;
      case 'ROLLBACK_START': state.phase = 'ROLLING_BACK'; break;
      case 'RESTORE_INTENT': recoveryFile('file'); check(file.backup === 'READY'); nextAttempt('INTENT', event.token); charge('recovery', planned.before.bytes); break;
      case 'REMOVE_INTENT': recoveryFile('absent'); check(captured.target.protocol === 'sftp'); nextAttempt('REMOVING'); break;
      case 'RESTORED':
        check(file.state === 'APPLIED' && attempt?.phase === 'RESTORING');
        check(event.proof === 'observed' || attempt.cleanup === 'NONE');
        attempt.phase = 'RESTORED'; attempt.proof = event.proof; file.state = 'ROLLED_BACK'; break;
      case 'REMOVED': check(file.state === 'APPLIED' && attempt?.phase === 'REMOVING'); attempt.phase = 'REMOVED'; file.state = 'ROLLED_BACK'; break;
      case 'RECOVERY_ATTEMPT_ABANDONED':
        check(file.state === 'APPLIED' && ['INTENT', 'STAGED', 'RESTORING', 'REMOVING'].includes(attempt?.phase)); attempt.phase = 'ABANDONED'; break;
      case 'ROLLBACK_COMPLETE':
        check(state.files.every(value => value.state !== 'APPLIED')); state.phase = warningCompletion(state) ? 'ROLLBACK_WITH_WARNINGS' : 'ROLLED_BACK'; break;
      case 'CLEANING':
        check(attempt?.staged && attempt.cleanup === 'NONE' && attempt.phase !== 'PROMOTED' && !(attempt.phase === 'RESTORED' && attempt.proof === 'ack'));
        attempt.cleanup = 'CLEANING'; break;
      case 'CLEANED': check(attempt?.staged && attempt.cleanup === 'CLEANING'); attempt.cleanup = 'CLEANED'; break;
      default: check(false);
    }
    validateState(state, captured, digest, limits);
    return immutable(decode(encode(state, codecLimits, codecLimits.maxPlanBytes), codecLimits, codecLimits.maxPlanBytes));
  }
  return Object.freeze({ validateEvent(event) { captureEvent(event); return true; }, reduce });
}
