import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, validateStateLimits, POLICY, StateError, seal, unseal } from '../../src/state/codec.mjs';
import { stateError } from './helpers.mjs';

const limits = validateStateLimits();
test('limits exactly enforce defaults, maxima, cross-field constraints and unknown keys', () => {
  for (const [field, [fallback, max]] of Object.entries(POLICY)) {
    assert.equal(limits[field], fallback);
    for (const invalid of [null, 0, -1, 1.5, max + 1, Infinity, '1']) assert.throws(() => validateStateLimits({ [field]: invalid }), stateError('STATE_INVALID'));
  }
  assert.throws(() => validateStateLimits({ surprise: 1 }), stateError('STATE_INVALID'));
  assert.throws(() => validateStateLimits({ maxStateBytes: 1, maxBackupBytes: 2 }), stateError('STATE_INVALID'));
});
test('canonical framing rejects duplicate keys, alternate escaping, prototype keys and opaque objects', () => {
  for (const raw of ['{"a":1,"a":1}\n', '{"b":1,"a":2}\n', '{"a":"\\u0061"}\n', '{"__proto__":{}}\n', '{"constructor":1}\n', '{}', '{}\n\n']) {
    assert.throws(() => decode(Buffer.from(raw), limits), stateError('STATE_CORRUPT'));
  }
  for (const payload of [new Error('secret'), { password: 'secret' }, { cause: 'native' }, { config: {} }, { a: undefined }]) assert.throws(() => encode(payload, limits), stateError('STATE_CORRUPT'));
  assert.deepEqual(decode(encode({ b: 1, a: ['x'] }, limits), limits), { a: ['x'], b: 1 });
});
test('byte, UTF8, string, key, nesting and array bounds precede JSON.parse', () => {
  const samples = [Buffer.from(`{"x":"${'x'.repeat(1025)}"}\n`), Buffer.from(`${'['.repeat(11)}0${']'.repeat(11)}\n`), Buffer.from(`{${Array.from({length:65},(_,i)=>`"${i}":0`).join(',')}}\n`), Buffer.from('[0,0,0]\n'), Buffer.from([0xff,10]), Buffer.alloc(5000,32)];
  const original = JSON.parse; let parses = 0; JSON.parse = (...args) => { parses++; return original(...args); };
  try { for (const bytes of samples) assert.throws(() => decode(bytes, {maxPlanFiles:2}), StateError); }
  finally { JSON.parse = original; }
  assert.equal(parses, 0);
});
test('digests bind canonical fields including domain and identity', () => {
  const bytes = seal({v:1, identity:'x'}, limits); assert.equal(unseal(bytes,['v','identity'],limits).identity,'x');
  const changed = Buffer.from(bytes.toString().replace('"x"','"y"'));
  assert.throws(() => unseal(changed,['v','identity'],limits), stateError('STATE_CORRUPT','record_digest'));
});
test('encoding stops at the byte budget before expanding a large nested metadata tree', () => {
  const touched=new Set();
  const tree=Array.from({length:1000},(_,group)=>Array.from({length:3},(_,index)=>new Proxy({value:'x'.repeat(1024)},{getOwnPropertyDescriptor(target,key){touched.add(group*3+index);return Reflect.getOwnPropertyDescriptor(target,key);}})));
  assert.throws(()=>encode(tree,limits,4096),stateError('STATE_LIMIT','record_bytes'));
  assert.ok(touched.size>0&&touched.size<=4,'only the bounded prefix is traversed');
});
