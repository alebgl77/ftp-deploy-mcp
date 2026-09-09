import { createHash } from 'node:crypto';

export const CODES = Object.freeze(['STATE_DISABLED', 'STATE_INVALID', 'STATE_BUSY', 'STATE_LIMIT', 'STATE_CORRUPT', 'STATE_IO', 'STATE_CONFLICT']);
export class StateError extends Error {
  constructor(code, stage) {
    if (!CODES.includes(code) || !/^[a-z][a-z0-9_]{0,63}$/.test(stage)) throw new TypeError('Invalid state error');
    super(`${code}: ${stage}`);
    this.name = 'StateError'; this.code = code; this.stage = stage;
  }
}
export const fail = (code, stage) => { throw new StateError(code, stage); };
export const POLICY = Object.freeze({
  maxStateBytes: [1073741824, 17179869184], maxBackupBytes: [536870912, 8589934592],
  maxPlans: [100, 1000], maxOperations: [100, 1000], maxPlanFiles: [1000, 10000],
  maxPlanBytes: [4194304, 33554432], maxJournalBytes: [16777216, 268435456],
  maxJournalEvents: [50000, 500000], maxBackupFiles: [10000, 100000],
});
export const HASH = /^[a-f0-9]{64}$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const IDS = { domain: new RegExp(`^${UUID}$`), plan: new RegExp(`^pln_${UUID}$`), operation: new RegExp(`^op_${UUID}$`) };
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor', 'password', 'passphrase', 'privateKey', 'privateKeyPath', 'cause', 'stack', 'config']);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function id(value, kind, code = 'STATE_INVALID') { if (typeof value !== 'string' || !IDS[kind]?.test(value)) fail(code, 'identifier'); return value; }
export function hash(value, code = 'STATE_INVALID') { if (typeof value !== 'string' || !HASH.test(value)) fail(code, 'digest'); return value; }
export function integer(value, maximum, code = 'STATE_INVALID', minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code, 'integer');
  return value;
}
export function exact(value, fields, code = 'STATE_CORRUPT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail(code, 'record_shape');
}
export function validateStateLimits(input = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(k => !Object.hasOwn(POLICY, k))) fail('STATE_INVALID', 'limits');
  const result = Object.fromEntries(Object.entries(POLICY).map(([key, [fallback, maximum]]) => [key, integer(input[key] === undefined ? fallback : input[key], maximum, 'STATE_INVALID', 1)]));
  if (result.maxBackupBytes > result.maxStateBytes) fail('STATE_INVALID', 'backup_limit');
  return Object.freeze(result);
}
function ordered(value, limit, depth = 0, budget) {
  const charge = (bytes) => { budget.left -= bytes; if (budget.left < 0) fail('STATE_LIMIT', 'record_bytes'); };
  if (depth > 8) fail('STATE_CORRUPT', 'depth');
  if (typeof value === 'string') { if (value.length > 1024) fail('STATE_CORRUPT', 'string_length'); charge(Buffer.byteLength(JSON.stringify(value))); return value; }
  if (value === null || typeof value === 'boolean') { charge(value === null ? 4 : value ? 4 : 5); return value; }
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) { charge(Buffer.byteLength(JSON.stringify(value))); return value; }
  if (Array.isArray(value)) { if (value.length > limit) fail('STATE_CORRUPT', 'array_length'); charge(2 + Math.max(0, value.length - 1)); return value.map(v => ordered(v, limit, depth + 1, budget)); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 64) fail('STATE_CORRUPT', 'object_shape');
  charge(2 + Math.max(0, Object.keys(value).length - 1));
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key.length > 1024 || FORBIDDEN.has(key)) fail('STATE_CORRUPT', 'object_key');
    charge(Buffer.byteLength(JSON.stringify(key)) + 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) fail('STATE_CORRUPT', 'object_accessor');
    result[key] = ordered(descriptor.value, limit, depth + 1, budget);
  }
  return result;
}
export function encode(value, limits, max = 4096) {
  const bytes = Buffer.from(`${JSON.stringify(ordered(value, limits.maxPlanFiles, 0, { left: max - 1 }))}\n`);
  if (bytes.length > max) fail('STATE_LIMIT', 'record_bytes');
  return bytes;
}
// Lexical size/shape accounting precedes JSON.parse. Canonical re-encoding then
// rejects duplicate keys, alternate escapes/number spellings and whitespace.
function preflight(text, maxArray) {
  const stack = []; let inString = false, escaped = false, stringUnits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        if (c === 'u') { if (!/^[a-fA-F0-9]{4}$/.test(text.slice(i + 1, i + 5))) fail('STATE_CORRUPT', 'json_escape'); i += 4; }
        stringUnits++;
      } else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      else stringUnits++;
      if (stringUnits > 1024) fail('STATE_CORRUPT', 'string_length');
    } else if (c === '"') { inString = true; stringUnits = 0; }
    else if (c === '{' || c === '[') {
      stack.push({ type: c, count: 0 });
      if (stack.length > 9) fail('STATE_CORRUPT', 'depth');
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ':' && stack.at(-1)?.type === '{') {
      if (++stack.at(-1).count > 64) fail('STATE_CORRUPT', 'object_shape');
    } else if (c === ',' && stack.at(-1)?.type === '[') {
      if (++stack.at(-1).count >= maxArray) fail('STATE_CORRUPT', 'array_length');
    }
  }
}
export function decode(bytes, limits, max = 4096) {
  if (!Buffer.isBuffer(bytes) || bytes.length > max || bytes.length === 0 || bytes.at(-1) !== 10) fail('STATE_CORRUPT', 'record_bytes');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('STATE_CORRUPT', 'utf8'); }
  preflight(text, limits.maxPlanFiles);
  let value; try { value = JSON.parse(text); } catch { fail('STATE_CORRUPT', 'json'); }
  if (!encode(value, limits, max).equals(bytes)) fail('STATE_CORRUPT', 'noncanonical');
  return value;
}
export function seal(fields, limits, max = 4096) { return encode({ ...fields, hash: sha256(encode(fields, limits, max)) }, limits, max); }
export function unseal(bytes, fields, limits, max = 4096) {
  const value = decode(bytes, limits, max); exact(value, [...fields, 'hash']); hash(value.hash, 'STATE_CORRUPT');
  const { hash: digest, ...body } = value;
  if (sha256(encode(body, limits, max)) !== digest) fail('STATE_CORRUPT', 'record_digest');
  return value;
}
