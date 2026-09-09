import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createIO } from '../../src/state/io.mjs';
import { validateStateLimits } from '../../src/state/codec.mjs';
import { fixture, allocation, backup, stateError, delay, tick, digest, native, planId } from './helpers.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 40));
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test barrier timeout')), 3000); })]); }
  finally { clearTimeout(timer); }
}

for (const reason of ['overflow', 'abort', 'reader_rejection', 'late_write_rejection']) {
  test(`destroyed backup waits for real write, store.close and endpoint settlement: ${reason}`, async t => {
    const entered = delay(), release = delay(), triggered = delay(), controller = new AbortController();
    let armed = false, actualWriteSettled = false, closedEarly = false, bytesWritten = 0;
    const f = await fixture(t, { signal: controller.signal, fault: async (stage, detail) => {
      if (armed && stage === 'backup_write_before') {
        entered.resolve(); await release.promise;
        if (reason === 'late_write_rejection') { actualWriteSettled = true; throw native('EIO', 'write'); }
      }
      if (armed && stage === 'backup_write_after') { bytesWritten += detail.bytes; actualWriteSettled = true; }
      if (armed && stage === 'backup_close_before') closedEarly ||= !actualWriteSettled;
    } });
    const entry = backup(0, 'abc'), { writer } = await f.create(allocation([entry])); armed = true;
    let backupDone = false, endpointDone = false, closeDone = false;
    const endpoint = f.store.withEndpointLock(digest('settlement'), async () => {
      try { return await writer.createBackup({ ...entry, read: async sink => {
        sink.write(Buffer.from('ab')); await entered.promise;
        if (reason === 'abort') controller.abort();
        else if (reason === 'reader_rejection') { triggered.resolve(); throw native('EIO', 'read'); }
        else sink.write(Buffer.from('cd'));
        triggered.resolve();
      } }); } finally { backupDone = true; }
    }).then(() => { endpointDone = true; return null; }, error => { endpointDone = true; return error; });
    let closing;
    try {
      await within(triggered.promise); await pause();
      const beforeClose = { backupDone, endpointDone, closedEarly, locks: await fs.readdir(f.file('locks')) };
      if (reason !== 'abort') await assert.rejects(writer.createBackup({ ...entry, read: async () => assert.fail('owned slot must remain occupied') }), stateError('STATE_BUSY', 'backup_occupied'));
      closing = f.store.close().then(() => { closeDone = true; }); await pause();
      assert.equal(beforeClose.backupDone, false); assert.equal(beforeClose.endpointDone, false);
      assert.equal(beforeClose.closedEarly, false); assert.equal(closeDone, false);
      assert.equal(beforeClose.locks.filter(name => name.startsWith('stripe-')).length, 1);
      assert.equal((await fs.readdir(f.file('locks'))).filter(name => name.startsWith('stripe-')).length, 1);
    } finally { release.resolve(); await endpoint; if (closing) await closing; }
    assert.equal(closedEarly, false); assert.equal(actualWriteSettled, true);
    assert.ok(bytesWritten <= 2); assert.deepEqual(await fs.readdir(f.file('locks')), []);
    assert.equal((await endpoint).code, reason === 'abort' ? 'STATE_BUSY' : reason === 'reader_rejection' ? 'STATE_IO' : 'STATE_LIMIT');
  });
}

for (const [expected, chunks, maximumWritten, success] of [
  ['abc', ['abc'], 3, true], ['abc', ['abcd'], 0, false], ['', [''], 0, true], ['', ['x'], 0, false], ['abc', ['ab', 'cd'], 2, false],
]) {
  test(`end(chunk) dispatch bound: cap=${expected.length}, chunks=${chunks.map(x => x.length).join('+')}`, async t => {
    let actual = 0; const f = await fixture(t, { fault: (stage, detail) => { if (stage === 'backup_write_after') actual += detail.bytes; } });
    const entry = backup(0, expected), { claim, writer } = await f.create(allocation([entry]));
    const operation = writer.createBackup({ ...entry, read: async sink => {
      if (chunks.length === 2) sink.write(Buffer.from(chunks[0]));
      sink.end(Buffer.from(chunks.at(-1)));
    } });
    if (success) assert.equal((await operation).bytes, expected.length);
    else await assert.rejects(operation, stateError('STATE_LIMIT', 'backup_bytes'));
    assert.equal(actual, maximumWritten);
    assert.equal((await fs.stat(f.file('operations', claim.operationId, 'backups', '0.blob'))).size, maximumWritten);
  });
}

for (const kind of ['create_backup', 'verified_backup', 'lock']) {
  test(`post-open FSTAT failure closes its exact handle before releasing work: ${kind}`, async t => {
    const f = await fixture(t), entry = backup(), { claim, writer } = await f.create(allocation([entry]));
    if (kind === 'verified_backup') await writer.createBackup({ ...entry, read: async sink => { sink.end('abc'); } });
    const entered = delay(), release = delay(), originalOpen = fs.open;
    let closed = false, callbacks = 0, finished = false, closeDone = false;
    const blob = f.file('operations', claim.operationId, 'backups', '0.blob');
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (kind === 'lock' ? /stripe-\d\d\.lock$/.test(String(args[0])) : String(args[0]) === blob) {
        const stat = handle.stat.bind(handle), close = handle.close.bind(handle); let calls = 0;
        handle.stat = async (...parameters) => { if (++calls === 2) throw native('EIO', 'fstat'); return stat(...parameters); };
        handle.close = async () => { entered.resolve(); await release.promise; await close(); closed = true; };
      }
      return handle;
    };
    const result = f.store.withEndpointLock(digest('fstat'), async () => {
      callbacks++;
      if (kind === 'create_backup') return writer.createBackup({ ...entry, read: async () => assert.fail('stat failed before reader') });
      if (kind === 'verified_backup') { const { fileIndex, ...expectation } = entry; return writer.openVerifiedBackup(0, expectation); }
      assert.fail('lock stat failure must prevent callback');
    }).then(() => { finished = true; return null; }, error => { finished = true; return error; });
    let closing;
    try {
      await within(entered.promise); closing = f.store.close().then(() => { closeDone = true; }); await pause();
      assert.equal(finished, false); assert.equal(closeDone, false); assert.equal(closed, false);
      assert.equal((await fs.readdir(f.file('locks'))).filter(name => name.startsWith('stripe-')).length, 1);
    } finally { release.resolve(); await result; if (closing) await closing; fs.open = originalOpen; }
    assert.equal(closed, true); stateError('STATE_IO')(await result);
    assert.equal(callbacks, kind === 'lock' ? 0 : 1);
  });
}

test('directory fsync tolerance requires FSTAT directory proof; ordinary files are closed and refused', async t => {
  const f = await fixture(t); let syncs = 0, closes = 0;
  const io = await createIO({ ...f.config, limits: validateStateLimits(f.config.limits), fault: stage => {
    if (stage === 'directory_sync_before') { syncs++; throw native('EPERM', 'fsync'); }
    if (stage === 'directory_close_after') closes++;
  } });
  if (process.platform === 'win32') {
    await io.syncDirectory(f.config.stateDir); assert.equal(io.capability.directorySync, false);
  } else await assert.rejects(io.syncDirectory(f.config.stateDir), error => error.code === 'EPERM');
  const previous = syncs;
  await assert.rejects(io.syncDirectory(f.file('domain.json')), stateError('STATE_CORRUPT', 'directory_type'));
  assert.equal(syncs, previous, 'no sync is attempted without directory proof'); assert.equal(closes, 2);
});

test('directory FSTAT failure is never treated as supported EPERM and waits for delayed handle close', async t => {
  const f = await fixture(t), io = await createIO({ ...f.config, limits: validateStateLimits(f.config.limits) });
  const originalOpen = fs.open, entered = delay(), release = delay(); let closed = false, settled = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.config.stateDir) {
      const close = handle.close.bind(handle);
      handle.stat = async () => { throw native('EPERM', 'fsync'); };
      handle.close = async () => { entered.resolve(); await release.promise; await close(); closed = true; };
    }
    return handle;
  };
  const operation = io.syncDirectory(f.config.stateDir).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try { await within(entered.promise); await pause(); assert.equal(settled, false); assert.equal(io.capability.directorySync, true); }
  finally { release.resolve(); await operation; fs.open = originalOpen; }
  assert.equal((await operation).code, 'EPERM'); assert.equal(closed, true);
});

test('inventory tolerates only a recognized endpoint lock released after its listing', async t => {
  const entered = delay(), release = delay(); let endpoint, armed = false, released = false;
  const f = await fixture(t, { fault: async (stage, detail) => {
    if (armed && stage === 'inventory_lock_stat_before' && detail.name.startsWith('stripe-')) {
      release.resolve(); await endpoint; released = true;
    }
  } });
  endpoint = f.store.withEndpointLock(digest('disappearing-stripe'), async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise; armed = true; const result = await f.store.inventory();
    assert.equal(released, true); assert.equal(result.artifacts, 6);
  } finally { release.resolve(); await endpoint; }
});

test('inventory disappearance tolerance excludes admission and non-ENOENT endpoint failures', async t => {
  let armed = false;
  const f = await fixture(t, { fault: async (stage, detail) => {
    if (armed && stage === 'inventory_lock_stat_before' && detail.name === 'admission.lock') await fs.unlink(f.file('locks', detail.name));
  } });
  armed = true; await assert.rejects(f.store.inventory(), stateError('STATE_IO'));
  const g = await fixture(t, { fault: (stage, detail) => {
    if (stage === 'inventory_lock_stat_before' && detail.name.startsWith('stripe-')) throw native('EACCES', 'lstat');
  } });
  await fs.writeFile(g.file('locks', 'stripe-01.lock'), '');
  await assert.rejects(g.store.inventory(), stateError('STATE_IO'));
});

test('persistent plan disappearance between inventory listing and open remains a strict failure', async t => {
  const f = await fixture(t), id = planId(); await f.store.publishPlan(id, Buffer.from('{}\n'));
  const file = f.file('plans', `${id}.json`), originalOpen = fs.open; let removed = false;
  fs.open = async (...args) => {
    if (!removed && String(args[0]) === file) { removed = true; await fs.unlink(file); }
    return originalOpen(...args);
  };
  try { await assert.rejects(f.store.inventory(), stateError('STATE_IO')); }
  finally { fs.open = originalOpen; }
  assert.equal(removed, true);
});
