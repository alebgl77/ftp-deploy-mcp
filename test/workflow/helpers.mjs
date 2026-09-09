import path from 'node:path';
import { sha256, validateStateLimits } from '../../src/state/codec.mjs';
import { encodePlan } from '../../src/workflow/model.mjs';
import { createWorkflowPolicy } from '../../src/workflow/events.mjs';

export const UUID = '12345678-1234-4234-8234-123456789abc';
export const OLD = sha256(Buffer.from('old')), NEW = sha256(Buffer.from('new'));
export function limits(overrides = {}, state = {}) {
  return { stateLimits: validateStateLimits(state), maxTransferBytes: 1099511627776, maxDeployBytes: 1099511627776, maxDeployFiles: 100000, ...overrides };
}
export function plan(kinds = ['C'], protocol = 'sftp') {
  return { v: 1, createdAt: 1, expiresAt: 900001, serverAlias: 'Prod', policyHash: 'a'.repeat(64),
    target: { protocol, host: 'example.test', port: protocol === 'sftp' ? 22 : 21, user: 'Deploy',
      root: '/root', localRoot: path.resolve('fixture-source'), canonicalRoot: protocol === 'sftp' ? '/canonical' : null },
    files: kinds.map((kind, index) => ({ index, localPath: `file-${String(index).padStart(5, '0')}`, remotePath: `file-${String(index).padStart(5, '0')}`,
      bytes: 3, sha256: NEW, before: kind === 'A' ? { kind: 'absent' } : { kind: 'file', bytes: 3, sha256: kind === 'U' ? NEW : OLD, mode: protocol === 'sftp' ? 420 : null },
      parent: protocol === 'sftp' ? '/canonical' : '/root', desiredMode: protocol === 'sftp' ? 420 : null })) };
}
export function server(target) {
  return { ...target, operationTimeoutMs: 120000, maxTransferBytes: 268435456, maxDeployBytes: 1073741824,
    maxDeployFiles: 10000, maxScanEntries: 100000, maxScanDepth: 64, readOnly: false, insecureTLS: false, implicitTLS: false,
    allowInsecure: false, allowUnknownHostKey: false, allowUnsafeRemoteRoot: false,
    hostKeySha256: target.protocol === 'sftp' ? [pin(1)] : [] };
}
export const pin = byte => `SHA256:${Buffer.alloc(32, byte).toString('base64').replace(/=+$/, '')}`;
export const token = n => n.toString(16).padStart(32, '0');
export const event = (scope, type, fields = {}) => ({ v: 1, scope, type, ...fields });
export function runner(p = plan(), l = limits()) {
  const policy = createWorkflowPolicy(p, l); let state;
  const events = [];
  function append(scope, type, fields = {}) {
    const e = event(scope, type, fields); state = policy.reduce(state, e); events.push(e); return state;
  }
  append('apply', 'INIT', { planDigest: sha256(encodePlan(p, l)), fileCount: p.files.length });
  return { policy, events, get state() { return state; }, append,
    backup(i = 0) { append('apply', 'BACKUP_INTENT', { i }); append('apply', 'BACKUP_READY', { i }); },
    stage(i = 0, a = 1, n = a) { append('apply', 'STAGE_INTENT', { i, a, token: token(n) }); append('apply', 'STAGED', { i, a, mode: p.files[i].desiredMode }); },
    promote(i = 0, a = 1) { append('apply', 'PROMOTING', { i, a }); append('apply', 'APPLIED', { i, a }); },
    restore(i = 0, a = 1, n = 10 + a) { append('recovery', 'RESTORE_INTENT', { i, a, token: token(n) }); append('recovery', 'RESTORE_STAGED', { i, a, mode: p.files[i].before.mode }); append('recovery', 'RESTORING', { i, a }); },
  };
}
