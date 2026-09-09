import path from 'node:path';
import { encode, decode, exact, integer, hash, id, sha256, fail, validateStateLimits } from '../state/codec.mjs';

const TRANSIENT = Object.freeze({ maxPlanFiles: 1024 });
const TRANSIENT_BYTES = 262144;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TARGET_KEYS = ['protocol', 'host', 'port', 'user', 'root', 'localRoot', 'canonicalRoot'];
const FLAGS = ['readOnly', 'insecureTLS', 'implicitTLS', 'allowInsecure', 'allowUnknownHostKey', 'allowUnsafeRemoteRoot'];
const SERVER_BOUNDS = { operationTimeoutMs: [100, 3600000], maxTransferBytes: [1, 1099511627776],
  maxDeployBytes: [1, 1099511627776], maxDeployFiles: [1, 100000], maxScanEntries: [1, 1000000], maxScanDepth: [1, 256] };

// Internal helpers are exported only for the other two pure workflow modules.
export function immutable(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
export function workflowLimits(input) {
  const value = decode(encode(input, TRANSIENT, TRANSIENT_BYTES), TRANSIENT, TRANSIENT_BYTES);
  exact(value, ['stateLimits', 'maxTransferBytes', 'maxDeployBytes', 'maxDeployFiles'], 'STATE_INVALID');
  for (const key of ['maxTransferBytes', 'maxDeployBytes', 'maxDeployFiles']) {
    integer(value[key], SERVER_BOUNDS[key][1], 'STATE_INVALID', 1);
  }
  return Object.freeze({ ...value, stateLimits: validateStateLimits(value.stateLimits) });
}
function text(value, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || CONTROL.test(value)) fail(code, 'plan_string');
  return value;
}
function remoteAbsolute(value, code) {
  text(value, code);
  if (!value.startsWith('/') || value.includes('\\') || path.posix.normalize(value) !== value ||
      (value !== '/' && value.endsWith('/')) || value.split('/').some(s => s === '..' || s === '.')) fail(code, 'plan_root');
  return value;
}
function relative(value, code) {
  text(value, code);
  if (value.includes('\\') || /^[a-zA-Z]:/.test(value) || value.startsWith('/') || path.posix.normalize(value) !== value ||
      value.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.ftp-mcp-'))) fail(code, 'plan_path');
}
function localAbsolute(value, code) {
  text(value, code);
  if (!path.isAbsolute(value) || path.normalize(value) !== value ||
      (process.platform === 'win32' && !/^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/.test(value))) fail(code, 'plan_local_root');
}
export function insideRemote(root, candidate) { return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`); }
function validateTarget(target, code) {
  exact(target, TARGET_KEYS, code);
  if (!['ftp', 'ftps', 'sftp'].includes(target.protocol)) fail(code, 'plan_protocol');
  text(target.host, code); text(target.user, code);
  if (target.host !== target.host.trim().toLowerCase().replace(/\.$/, '')) fail(code, 'plan_host');
  integer(target.port, 65535, code, 1);
  remoteAbsolute(target.root, code); localAbsolute(target.localRoot, code);
  if (target.protocol === 'sftp') remoteAbsolute(target.canonicalRoot, code);
  else if (target.canonicalRoot !== null) fail(code, 'plan_canonical_root');
}
export function unchanged(file) {
  return file.before.kind === 'file' && file.bytes === file.before.bytes && file.sha256 === file.before.sha256 && file.desiredMode === file.before.mode;
}
function validatePlan(plan, limits, code) {
  exact(plan, ['v', 'createdAt', 'expiresAt', 'serverAlias', 'target', 'policyHash', 'files'], code);
  if (plan.v !== 1) fail(code, 'plan_version');
  integer(plan.createdAt, Number.MAX_SAFE_INTEGER, code); integer(plan.expiresAt, Number.MAX_SAFE_INTEGER, code);
  if (plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > 900000) fail(code, 'plan_lifetime');
  text(plan.serverAlias, code); validateTarget(plan.target, code); hash(plan.policyHash, code);
  if (!Array.isArray(plan.files) || !plan.files.length || plan.files.length > Math.min(limits.stateLimits.maxPlanFiles, limits.maxDeployFiles)) fail(code, 'plan_files');
  const localPaths = new Set(), remotePaths = new Set();
  let planned = 0, recovery = 0;
  for (const [index, file] of plan.files.entries()) {
    exact(file, ['index', 'localPath', 'remotePath', 'bytes', 'sha256', 'before', 'parent', 'desiredMode'], code);
    if (file.index !== index) fail(code, 'plan_index');
    relative(file.localPath, code); relative(file.remotePath, code);
    if (localPaths.has(file.localPath) || remotePaths.has(file.remotePath)) fail(code, 'plan_duplicate');
    if (index && plan.files[index - 1].remotePath >= file.remotePath) fail(code, 'plan_order');
    localPaths.add(file.localPath); remotePaths.add(file.remotePath);
    integer(file.bytes, limits.maxTransferBytes, code); hash(file.sha256, code);
    if (file.bytes > limits.maxDeployBytes - planned) fail('STATE_LIMIT', 'plan_transfer_bytes');
    planned += file.bytes;
    remoteAbsolute(file.parent, code);
    const base = plan.target.canonicalRoot ?? plan.target.root;
    if (!insideRemote(base, file.parent)) fail(code, 'plan_parent');
    if (plan.target.protocol !== 'sftp' && file.parent !== path.posix.dirname(path.posix.join(base, file.remotePath))) fail(code, 'plan_parent');
    if (file.before?.kind === 'absent') {
      exact(file.before, ['kind'], code);
      if (plan.target.protocol !== 'sftp' || file.desiredMode !== 420) fail(code, 'plan_absent');
    } else {
      exact(file.before, ['kind', 'bytes', 'sha256', 'mode'], code);
      if (file.before.kind !== 'file') fail(code, 'plan_before');
      integer(file.before.bytes, Number.MAX_SAFE_INTEGER, code); hash(file.before.sha256, code);
      if (plan.target.protocol === 'sftp') integer(file.before.mode, 511, code);
      else if (file.before.mode !== null) fail(code, 'plan_mode');
      if (file.desiredMode !== file.before.mode) fail(code, 'plan_mode');
      if (!unchanged(file)) {
        integer(file.before.bytes, limits.maxTransferBytes, code);
        if (file.before.bytes > limits.maxDeployBytes - recovery) fail('STATE_LIMIT', 'plan_recovery_bytes');
        recovery += file.before.bytes;
      }
    }
  }
  // One planned file must never be another planned file's parent directory.
  for (const value of remotePaths) {
    const segments = value.split('/');
    for (let i = 1; i < segments.length; i++) if (remotePaths.has(segments.slice(0, i).join('/'))) fail(code, 'plan_file_parent');
  }
  return plan;
}
export function encodePlan(plan, limits) {
  const checked = workflowLimits(limits), state = checked.stateLimits;
  const bytes = encode(plan, state, state.maxPlanBytes);
  validatePlan(decode(bytes, state, state.maxPlanBytes), checked, 'STATE_INVALID');
  return bytes;
}
export function decodePlan(bytes, limits) {
  const checked = workflowLimits(limits), state = checked.stateLimits;
  return immutable(validatePlan(decode(bytes, state, state.maxPlanBytes), checked, 'STATE_CORRUPT'));
}
function data(object, key) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype) fail('STATE_INVALID', 'policy_object');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('STATE_INVALID', 'policy_field');
  return descriptor.value;
}
function unsupported() {
  const error = new Error('PLAN_UNSUPPORTED: policy_projection');
  error.name = 'WorkflowError'; error.code = 'PLAN_UNSUPPORTED'; error.stage = 'policy_projection';
  throw error;
}
export function policyFingerprint(input) {
  try {
    exact(input, ['server', 'target', 'requirePlan', 'stateLimits'], 'STATE_INVALID');
    const server = data(input, 'server');
    const target = decode(encode(data(input, 'target'), TRANSIENT, TRANSIENT_BYTES), TRANSIENT, TRANSIENT_BYTES);
    validateTarget(target, 'STATE_INVALID');
    const requirePlan = data(input, 'requirePlan');
    if (typeof requirePlan !== 'boolean') fail('STATE_INVALID', 'policy_boolean');
    const stateLimits = validateStateLimits(decode(encode(data(input, 'stateLimits'), TRANSIENT, TRANSIENT_BYTES), TRANSIENT, TRANSIENT_BYTES));
    const projection = { v: 1, target, requirePlan, stateLimits };
    for (const [key, [minimum, maximum]] of Object.entries(SERVER_BOUNDS)) projection[key] = integer(data(server, key), maximum, 'STATE_INVALID', minimum);
    for (const key of FLAGS) {
      projection[key] = data(server, key);
      if (typeof projection[key] !== 'boolean') fail('STATE_INVALID', 'policy_boolean');
    }
    const protocol = data(server, 'protocol'), host = data(server, 'host'), user = data(server, 'user');
    text(protocol, 'STATE_INVALID'); text(host, 'STATE_INVALID'); text(user, 'STATE_INVALID');
    if (protocol.trim().toLowerCase() !== target.protocol || host.trim().toLowerCase().replace(/\.$/, '') !== target.host ||
        data(server, 'port') !== target.port || user !== target.user) fail('STATE_INVALID', 'policy_target');
    const root = data(server, 'root'); text(root, 'STATE_INVALID');
    let normalizedRoot = root.replace(/\\/g, '/').trim();
    if (!normalizedRoot.startsWith('/')) normalizedRoot = `/${normalizedRoot}`;
    normalizedRoot = path.posix.normalize(normalizedRoot).replace(/\/$/, '') || '/';
    if (normalizedRoot !== target.root) fail('STATE_INVALID', 'policy_root');
    if (Object.hasOwn(server, 'localRoot')) {
      const local = data(server, 'localRoot');
      // normalizeServer represents an omitted localRoot as undefined.
      if (local !== undefined) text(local, 'STATE_INVALID');
    }
    const pins = data(server, 'hostKeySha256');
    if (!Array.isArray(pins) || pins.length > 1024) fail('STATE_INVALID', 'policy_pins');
    const normalizedPins = [];
    for (let i = 0; i < pins.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(pins, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('STATE_INVALID', 'policy_pin');
      const pin = descriptor.value;
      if (typeof pin !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pin)) fail('STATE_INVALID', 'policy_pin');
      const value = Buffer.from(pin.slice(7), 'base64');
      if (value.length !== 32 || value.toString('base64').replace(/=+$/, '') !== pin.slice(7)) fail('STATE_INVALID', 'policy_pin');
      normalizedPins.push(pin);
    }
    projection.hostKeySha256 = [...new Set(normalizedPins)].sort();
    return sha256(encode(projection, TRANSIENT, TRANSIENT_BYTES));
  } catch { unsupported(); }
}
export function idempotencyKeyHash(input) {
  // Bounded canonical capture rejects accessors and extra/forbidden fields first.
  const value = decode(encode(input, TRANSIENT, 4096), TRANSIENT, 4096);
  exact(value, ['domainId', 'key'], 'STATE_INVALID'); id(value.domainId, 'domain');
  if (typeof value.key !== 'string' || !/^[!-~]{16,128}$/.test(value.key)) fail('STATE_INVALID', 'idempotency_key');
  return sha256(encode({ v: 1, domainId: value.domainId, key: value.key }, TRANSIENT));
}
