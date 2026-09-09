import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openStateStore } from '../../src/state/store.mjs';
import { encode, sha256 } from '../../src/state/codec.mjs';

export const scratch = fileURLToPath(new URL('../../.tmp/state-tests/', import.meta.url));
export const limits = { maxPlanBytes: 8192, maxStateBytes: 1048576, maxBackupBytes: 65536, maxPlans: 10, maxOperations: 10,
  maxPlanFiles: 10, maxJournalBytes: 16384, maxJournalEvents: 50, maxBackupFiles: 10 };
export const policy = { validateEvent: event => event && Object.keys(event).length === 1 && ['INIT', 'STEP', 'DONE'].includes(event.type),
  reduce: (state, event) => { if ((!state && event.type !== 'INIT') || (state && event.type === 'INIT') || state?.done) throw new Error('transition'); return { count: (state?.count ?? 0) + 1, done: event.type === 'DONE' }; } };
export const planId = () => `pln_${randomUUID()}`;
export const digest = sha256;
export const delay = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function native(code = 'EIO', syscall = 'fsync') { return Object.assign(new Error('PRIVATE_NATIVE_DIAGNOSTIC'), { code, syscall }); }
export function allocation(backups = [], extra = {}) { return { applyJournalBytes: 8192, applyJournalEvents: 25, recoveryJournalBytes: 8192,
  recoveryJournalEvents: 25, backupBytes: backups.reduce((n, b) => n + b.expectedBytes, 0), backupFiles: backups.length, metadataBytes: 16384, backups, ...extra }; }
export function backup(index = 0, data = 'abc', mode = null) { return { fileIndex: index, expectedBytes: Buffer.byteLength(data), expectedSha256: sha256(data), mode }; }
export function claimInput(id, reservation = allocation(), extra = {}) { return { planId: id, keyHash: sha256(id), targetHash: sha256('endpoint'),
  reservation, initialEvent: { type: 'INIT' }, ...policy, ...extra }; }
export async function fixture(t, options = {}) {
  await fs.mkdir(scratch, { recursive: true }); const root = await fs.mkdtemp(path.join(scratch, 'case-'));
  const localRoot = path.join(root, 'local'); await fs.mkdir(localRoot);
  const config = { stateDir: path.join(root, 'state'), localRoots: [await fs.realpath(localRoot)], limits, ...options };
  const stores = [];
  t.after(async () => {
    await Promise.allSettled(stores.map(s => s.close()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch));
    assert.ok(path.basename(root).startsWith('case-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = async (extra = {}) => { const s = await openStateStore({ ...config, ...extra }); stores.push(s); return s; };
  const store = await open();
  const create = async (reservation = allocation()) => {
    const id = planId(); await store.publishPlan(id, Buffer.from('{"files":[]}\n'));
    const claim = await store.claim(claimInput(id, reservation));
    const writer = await store.openJournal(claim.operationId, policy); return { id, claim, writer };
  };
  return { root, config, store, open, create, file: (...p) => path.join(config.stateDir, ...p) };
}
export function stateError(code, stage) { return error => { assert.equal(error.name, 'StateError'); assert.equal(error.code, code); if (stage) assert.equal(error.stage, stage); assert.ok(!JSON.stringify(error).includes('PRIVATE_NATIVE')); return true; }; }
export async function offlineRemoveLocks(stateDir) {
  // Test-only offline recovery: callers first await the child exit. The library
  // has no corresponding unlock/reconstruction method.
  for (const dir of [stateDir, path.join(stateDir, 'locks')]) {
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (name === 'bootstrap.lock' || name === 'admission.lock' || /^stripe-\d\d\.lock$/.test(name)) await fs.unlink(path.join(dir, name));
    }
  }
}
export function child(data) {
  const proc = fork(fileURLToPath(new URL('./process.mjs', import.meta.url)), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; proc.stderr.on('data', value => { stderr += value; });
  const waiting = new Map(), queued = [];
  proc.on('message', message => { const resolve = waiting.get(message.type); if (resolve) { waiting.delete(message.type); resolve(message); } else queued.push(message); });
  const exit = new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  function wait(type) { const i = queued.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(queued.splice(i, 1)[0]); return new Promise(resolve => waiting.set(type, resolve)); }
  proc.send(data);
  return { proc, wait, exit, go: () => proc.send({ go: true }) };
}
