import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, sha256 } from '../../src/state/codec.mjs';
import { encodePlan, decodePlan, policyFingerprint, idempotencyKeyHash, workflowLimits } from '../../src/workflow/model.mjs';
import { plan, limits, server, pin, UUID } from './helpers.mjs';

test('plan round trip is canonical, detached and deeply immutable', () => {
  const p = plan(), l = limits(), bytes = encodePlan(p, l), copy = decodePlan(bytes, l);
  assert.deepEqual(copy, p); p.files[0].localPath = 'changed'; bytes.fill(0);
  assert.equal(copy.files[0].localPath, 'file-00000');
  assert.throws(() => { copy.files[0].bytes = 1; }, TypeError);
  const fresh = encodePlan(copy, l); assert.ok(fresh.equals(encode(copy, l.stateLimits, l.stateLimits.maxPlanBytes)));
});
test('minimum one-file ceiling works for SFTP/FTP/FTPS, empty files and inherited modes', () => {
  for (const protocol of ['sftp', 'ftp', 'ftps']) for (const mode of [0, 511]) {
    const p = plan(['C'], protocol), l = limits({}, { maxPlanFiles: 1 });
    p.files[0].bytes = 0; p.files[0].before.bytes = 0;
    if (protocol === 'sftp') p.files[0].desiredMode = p.files[0].before.mode = mode;
    assert.deepEqual(decodePlan(encodePlan(p, l), l), p);
  }
});
test('plan lifetime arithmetic remains exact next to the safe-integer maximum', () => {
  const p = plan(); p.createdAt = Number.MAX_SAFE_INTEGER - 900000; p.expiresAt = Number.MAX_SAFE_INTEGER;
  assert.doesNotThrow(() => encodePlan(p, limits())); p.createdAt--;
  assert.throws(() => encodePlan(p, limits()));
});
const invalidPlans = {
  unknown: p => { p.extra = true; }, version: p => { p.v = 2; }, empty: p => { p.files = []; },
  unsafeTime: p => { p.createdAt = Number.MAX_SAFE_INTEGER + 1; }, lifetime: p => { p.expiresAt++; },
  reversedTime: p => { p.expiresAt = p.createdAt; }, alias: p => { p.serverAlias = ''; },
  targetExtra: p => { p.target.password = 'sentinel'; }, hostCase: p => { p.target.host = 'Example.test'; },
  trailingDot: p => { p.target.host += '.'; }, port: p => { p.target.port = 0; }, user: p => { p.target.user = ''; },
  rootTraversal: p => { p.target.root = '/root/../root'; }, relativeRoot: p => { p.target.localRoot = 'relative'; },
  parentOutside: p => { p.files[0].parent = '/canonical2'; }, beforeUnknown: p => { p.files[0].before.kind = 'unknown'; },
  beforeExtra: p => { p.files[0].before.error = 'secret'; }, badDigest: p => { p.files[0].sha256 = 'Z'.repeat(64); },
  mode: p => { p.files[0].desiredMode = 511; }, wrongIndex: p => { p.files[0].index = 1; },
  negativeSize: p => { p.files[0].bytes = -1; }, controlPath: p => { p.files[0].localPath = 'a\n'; },
  traversalPath: p => { p.files[0].remotePath = '../a'; }, absolutePath: p => { p.files[0].remotePath = '/a'; },
  backslashPath: p => { p.files[0].localPath = 'a\\b'; }, drivePath: p => { p.files[0].localPath = 'C:a'; },
  temporaryPath: p => { p.files[0].remotePath = 'a/.ftp-mcp-any/file'; }, pathSlash: p => { p.files[0].remotePath = 'a/'; },
};
for (const [name, mutate] of Object.entries(invalidPlans)) test(`closed plan rejects ${name}`, () => {
  const p = plan(); mutate(p); assert.throws(() => encodePlan(p, limits()));
  assert.throws(() => decodePlan(Buffer.from(`${JSON.stringify(p)}\n`), limits()));
});
test('canonical decoding rejects duplicate fields, unknown version and lexical expansion before JSON.parse', () => {
  const p = plan(), l = limits({}, { maxPlanFiles: 1 }), valid = encodePlan(p, l);
  assert.throws(() => decodePlan(Buffer.from(valid.toString().replace('"v":1', '"v":1,"v":1')), l));
  const original = JSON.parse; let calls = 0; JSON.parse = value => { calls++; return original(value); };
  try {
    // workflowLimits performs one small bounded capture before payload preflight.
    for (const payload of ['{"x":"' + 'a'.repeat(1025) + '"}\n', '['.repeat(10) + '0' + ']'.repeat(10) + '\n', '[0,0]\n']) {
      const before = calls; assert.throws(() => decodePlan(Buffer.from(payload), l)); assert.equal(calls - before, 1);
    }
  } finally { JSON.parse = original; }
  for (const bytes of [Buffer.from(valid.subarray(0, -1)), Buffer.from([255, 10]), Buffer.alloc(l.stateLimits.maxPlanBytes + 1)]) assert.throws(() => decodePlan(bytes, l));
});
test('encoding bounds hostile arrays/strings before getter expansion', () => {
  const p = plan(), l = limits({}, { maxPlanFiles: 1 }); let reached = false;
  p.files = new Array(2); Object.defineProperty(p.files, '0', { get() { reached = true; throw new Error('getter'); } });
  assert.throws(() => encodePlan(p, l)); assert.equal(reached, false);
  const huge = plan(); huge.files[0].localPath = 'a'.repeat(1025); assert.throws(() => encodePlan(huge, l));
});
test('paths use stable UTF-16 order, reject duplicates and file-parent conflicts', () => {
  const p = plan(['C', 'C']); p.files[1].remotePath = p.files[0].remotePath;
  assert.throws(() => encodePlan(p, limits()));
  p.files[1].remotePath = 'a'; assert.throws(() => encodePlan(p, limits()));
  p.files[1].remotePath = 'z'; p.files[1].localPath = p.files[0].localPath; assert.throws(() => encodePlan(p, limits()));
  const hierarchy = plan(['C', 'C', 'C']); ['a', 'a-b', 'a/c'].forEach((name, i) => { hierarchy.files[i].remotePath = name; });
  assert.throws(() => encodePlan(hierarchy, limits()));
  const unicode = plan(['C', 'C']); ['Z', 'ä'].forEach((name, i) => { unicode.files[i].remotePath = name; });
  assert.doesNotThrow(() => encodePlan(unicode, limits()));
});
test('FTP absence and unsupported mode fail; SFTP absence has exactly mode 0644', () => {
  for (const protocol of ['ftp', 'ftps']) {
    assert.throws(() => encodePlan(plan(['A'], protocol), limits()));
    const p = plan(['C'], protocol); p.files[0].parent = '/root/other'; assert.throws(() => encodePlan(p, limits()));
    p.files[0].parent = '/root'; p.files[0].before.mode = 420; p.files[0].desiredMode = 420; assert.throws(() => encodePlan(p, limits()));
  }
  const p = plan(['A']); assert.doesNotThrow(() => encodePlan(p, limits()));
  p.files[0].desiredMode = 384; assert.throws(() => encodePlan(p, limits()));
});
test('observed canonical SFTP parent may differ from lexical parent within bound root', () => {
  const p = plan(); p.files[0].parent = '/canonical/observed'; assert.doesNotThrow(() => encodePlan(p, limits()));
});
test('relative paths reject drive prefixes without inventing a blanket POSIX colon ban', () => {
  const p = plan(); p.files[0].localPath = 'dir/file:variant'; p.files[0].remotePath = 'dir/file:variant';
  assert.doesNotThrow(() => encodePlan(p, limits()));
  p.files[0].remotePath = 'C:/absolute'; assert.throws(() => encodePlan(p, limits()));
  p.files[0].remotePath = 'C:drive-relative'; assert.throws(() => encodePlan(p, limits()));
});
test('source and first recovery ceilings accept equality and reject +1 independently', () => {
  const p = plan(['C', 'C']), l = limits({ maxDeployBytes: 6, maxTransferBytes: 3, maxDeployFiles: 2 });
  assert.doesNotThrow(() => encodePlan(p, l));
  assert.throws(() => encodePlan(p, { ...l, maxDeployFiles: 1 }));
  assert.throws(() => encodePlan(p, { ...l, maxDeployBytes: 5 }));
  assert.throws(() => encodePlan(p, { ...l, maxTransferBytes: 2 }));
  p.files[0].before.bytes = 4; assert.throws(() => encodePlan(p, l));
  assert.throws(() => encodePlan(p, { ...l, maxTransferBytes: 4 }));
  p.files[0].bytes = 0; assert.throws(() => encodePlan(p, { ...l, maxTransferBytes: 4 }));
});
test('workflow limits are closed and required with effective state policy', () => {
  const l = limits(); for (const field of ['maxTransferBytes', 'maxDeployBytes', 'maxDeployFiles']) {
    const missing = { ...l }; delete missing[field]; assert.throws(() => workflowLimits(missing));
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => workflowLimits({ ...l, [field]: value }));
  }
  assert.throws(() => workflowLimits({ ...l, arbitrary: 1 })); assert.throws(() => workflowLimits({ ...l, stateLimits: { unknown: 1 } }));
  assert.doesNotThrow(() => workflowLimits({ ...l, stateLimits: {} }));
});
test('policy fingerprint uses explicit nonsecret fields, normalized identities and multiple pins independent of maxPlanFiles', () => {
  const p = plan(), l = limits({}, { maxPlanFiles: 1 }), s = server(p.target);
  s.hostKeySha256 = [pin(2), pin(1), pin(2)];
  const input = { server: s, target: p.target, requirePlan: true, stateLimits: l.stateLimits };
  const first = policyFingerprint(input);
  s.hostKeySha256 = [pin(1), pin(2)]; s.protocol = ' SFTP '; s.host = ' EXAMPLE.TEST. ';
  Object.defineProperty(s, 'password', { enumerable: true, get() { throw new Error('secret touched'); } });
  s.passphrase = 'a'; s.privateKeyPath = '/secret'; s.unrelated = { arbitrary: true };
  assert.equal(policyFingerprint(input), first);
  s.passphrase = 'b'; assert.equal(policyFingerprint(input), first);
  assert.match(first, /^[a-f0-9]{64}$/);
});
test('every projected policy field changes the digest; alias is not a policy identity', () => {
  const p = plan(), s = server(p.target), input = { server: s, target: p.target, requirePlan: true, stateLimits: limits().stateLimits };
  const base = policyFingerprint(input);
  for (const field of ['operationTimeoutMs', 'maxTransferBytes', 'maxDeployBytes', 'maxDeployFiles', 'maxScanEntries', 'maxScanDepth']) {
    assert.notEqual(policyFingerprint({ ...input, server: { ...s, [field]: s[field] + 1 } }), base);
  }
  for (const field of ['readOnly', 'insecureTLS', 'implicitTLS', 'allowInsecure', 'allowUnknownHostKey', 'allowUnsafeRemoteRoot']) {
    assert.notEqual(policyFingerprint({ ...input, server: { ...s, [field]: !s[field] } }), base);
  }
  assert.notEqual(policyFingerprint({ ...input, requirePlan: false }), base);
  assert.notEqual(policyFingerprint({ ...input, stateLimits: { ...input.stateLimits, maxPlans: 101 } }), base);
  assert.notEqual(policyFingerprint({ ...input, server: { ...s, hostKeySha256: [pin(2)] } }), base);
  assert.equal(policyFingerprint({ ...input, server: { ...s, name: 'OtherAlias' } }), base);
  for (const field of ['user', 'host', 'port', 'root']) {
    const target = { ...p.target, [field]: field === 'port' ? 23 : `${p.target[field]}x` };
    assert.notEqual(policyFingerprint({ ...input, target, server: { ...s, [field]: target[field] } }), base);
  }
});
test('oversized, malformed and accessor projections fail safely without pin truncation', () => {
  const p = plan(), s = server(p.target), input = { server: s, target: p.target, requirePlan: true, stateLimits: {} };
  const rejected = value => assert.throws(() => policyFingerprint(value), error => error.code === 'PLAN_UNSUPPORTED' && error.message === 'PLAN_UNSUPPORTED: policy_projection');
  for (const root of [null, '', 42, undefined]) rejected({ ...input, server: { ...s, root } });
  for (const localRoot of [null, '', 42]) rejected({ ...input, server: { ...s, localRoot } });
  rejected({ ...input, server: { ...s, hostKeySha256: Array(1025).fill(pin(1)) } });
  rejected({ ...input, server: { ...s, hostKeySha256: ['SHA256:' + 'B'.repeat(43)] } });
  const pins = Array(1024).fill(pin(1)); assert.doesNotThrow(() => policyFingerprint({ ...input, server: { ...s, hostKeySha256: pins } }));
  const getter = { ...s }; Object.defineProperty(getter, 'maxDeployBytes', { enumerable: true, get() { throw new Error('sentinel'); } });
  rejected({ ...input, server: getter }); rejected({ ...input, extra: true });
});
test('idempotency hash is exact closed object projection; domain and key are bound', () => {
  const input = { domainId: UUID, key: 'Abcdefghijklmnop' };
  assert.equal(idempotencyKeyHash(input), sha256(encode({ v: 1, ...input }, { maxPlanFiles: 1024 })));
  assert.notEqual(idempotencyKeyHash(input), idempotencyKeyHash({ ...input, key: input.key.toLowerCase() }));
  assert.notEqual(idempotencyKeyHash(input), idempotencyKeyHash({ ...input, domainId: '22345678-1234-4234-8234-123456789abc' }));
  for (const key of ['a'.repeat(15), 'a'.repeat(129), 'a'.repeat(15) + ' ', 'a'.repeat(15) + '\n', 'a'.repeat(15) + 'é']) assert.throws(() => idempotencyKeyHash({ ...input, key }));
  assert.doesNotThrow(() => idempotencyKeyHash({ ...input, key: '~'.repeat(128) }));
  assert.throws(() => idempotencyKeyHash({ ...input, extra: true })); assert.throws(() => idempotencyKeyHash({ ...input, domainId: `pln_${UUID}` }));
});
