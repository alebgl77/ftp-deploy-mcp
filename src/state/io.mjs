import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateError, fail, encode, decode, exact, id } from './codec.mjs';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function contains(root, child) { const rel = path.relative(root, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export const identity = (stat) => `${stat.dev}:${stat.ino}`;
export function checkSignal(signal) { if (signal?.aborted) fail('STATE_BUSY', 'cancelled'); }
export function safeFailure(error, stage) { return error instanceof StateError ? error : new StateError('STATE_IO', stage); }

export async function createIO({ stateDir, localRoots, signal, fault, limits, create = true }) {
  if (stateDir === undefined || stateDir === null || stateDir === '') fail('STATE_DISABLED', 'state_dir');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir || !Array.isArray(localRoots)) fail('STATE_INVALID', 'state_dir');
  const roots = [];
  for (const root of localRoots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('STATE_INVALID', 'local_root');
    const real = await fs.realpath(root).catch(() => fail('STATE_INVALID', 'local_root'));
    if (!samePath(real, root)) fail('STATE_INVALID', 'local_root_canonical');
    if (contains(real, stateDir) || contains(stateDir, real)) fail('STATE_INVALID', 'state_overlap');
    roots.push(real);
  }
  let ancestor = stateDir;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!samePath(ancestor, real)) fail('STATE_INVALID', 'ancestor_canonical');
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('STATE_INVALID', 'state_directory');
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw safeFailure(error, 'ancestor'); ancestor = path.dirname(ancestor); }
  }
  checkSignal(signal);
  if (create) await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  else {
    try { await fs.lstat(stateDir); }
    catch (error) { if (error.code === 'ENOENT') fail('STATE_INVALID', 'domain_uninitialized'); throw error; }
  }
  const pin = identity(await fs.lstat(stateDir));
  const capability = { processCrash: true, powerLoss: 'not_guaranteed', directorySync: true, directorySyncLimitation: null, platform: process.platform };
  async function guard(file = stateDir) {
    if (!contains(stateDir, file)) fail('STATE_INVALID', 'state_path');
    for (const root of roots) {
      if (!samePath(await fs.realpath(root), root) || contains(root, stateDir) || contains(stateDir, root)) fail('STATE_CORRUPT', 'root_identity');
    }
    if (!samePath(await fs.realpath(stateDir), stateDir) || identity(await fs.lstat(stateDir)) !== pin) fail('STATE_CORRUPT', 'root_identity');
    let current = stateDir;
    for (const part of path.relative(stateDir, file).split(path.sep).filter(Boolean)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STATE_CORRUPT', 'directory_identity');
      current = path.join(current, part);
    }
    try { if ((await fs.lstat(file)).isSymbolicLink()) fail('STATE_CORRUPT', 'symbolic_link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function hook(stage, phase, detail = {}) { return await fault?.(`${stage}_${phase}`, Object.freeze({ ...detail })); }
  async function act(stage, run, detail) { await hook(stage, 'before', detail); const value = await run(); await hook(stage, 'after', detail); return value; }
  async function open(file, flags, stage = 'file_open') {
    await guard(file); await hook(stage, 'before');
    const handle = await fs.open(file, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail('STATE_CORRUPT', 'regular_file');
      await hook(stage, 'after');
      return handle;
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }
  async function close(handle, stage = 'file_close') {
    let primary;
    try { await hook(stage, 'before'); } catch (error) { primary = error; }
    try { await handle.close(); } catch (error) { primary ??= error; }
    try { await hook(stage, 'after'); } catch (error) { primary ??= error; }
    if (primary) throw primary;
  }
  async function write(handle, bytes, position, stage = 'file_write') {
    let offset = 0;
    while (offset < bytes.length) {
      const instruction = await hook(stage, 'before', { bytes: bytes.length - offset });
      const maximum = instruction?.maxWriteBytes ?? bytes.length;
      if (!Number.isSafeInteger(maximum) || maximum <= 0) fail('STATE_IO', 'short_write');
      const { bytesWritten } = await handle.write(bytes, offset, Math.min(bytes.length - offset, maximum), position === null ? null : position + offset);
      if (bytesWritten <= 0) fail('STATE_IO', 'short_write');
      offset += bytesWritten;
      await hook(stage, 'after', { bytes: bytesWritten });
    }
  }
  async function sync(handle, stage = 'file_sync') { await act(stage, () => handle.sync()); }
  async function syncDirectory(dir) {
    await guard(dir); const handle = await fs.open(dir, 'r'); let error, directory = false;
    try {
      directory = (await handle.stat()).isDirectory();
      if (!directory) fail('STATE_CORRUPT', 'directory_type');
      await sync(handle, 'directory_sync');
    }
    catch (failure) {
      if (directory && process.platform === 'win32' && failure.code === 'EPERM' && failure.syscall === 'fsync') {
        capability.directorySync = false; capability.directorySyncLimitation = 'windows_eperm_fsync';
      }
      else error = failure;
    }
    try { await close(handle, 'directory_close'); } catch (failure) { error ??= failure; }
    if (error) throw error;
  }
  async function read(file, max, stage = 'record_read') {
    const handle = await open(file, 'r'); let error, value;
    try {
      const stat = await handle.stat();
      if (stat.size > max) fail('STATE_LIMIT', 'file_bytes');
      const chunks = []; let total = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(65536, max - total + 1));
        const { bytesRead } = await act(stage, () => handle.read(buffer, 0, buffer.length, total));
        if (!bytesRead) break;
        total += bytesRead;
        if (total > max) fail('STATE_LIMIT', 'file_bytes');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      if (identity(await fs.lstat(file)) !== identity(stat)) fail('STATE_CORRUPT', 'file_identity');
      value = Buffer.concat(chunks, total);
    } catch (failure) { error = failure; }
    try { await close(handle); } catch (failure) { error ??= failure; }
    if (error) throw error;
    return value;
  }
  async function publish(file, bytes, { replace = false, stage = 'record' } = {}) {
    const temp = path.join(path.dirname(file), `.publish-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', `${stage}_open`); let error;
    try { await write(handle, bytes, 0, `${stage}_write`); await sync(handle, `${stage}_sync`); }
    catch (failure) { error = failure; }
    try { await close(handle, `${stage}_close`); } catch (failure) { error ??= failure; }
    if (error) throw error; // An orphan is evidence: do not silently remove it.
    await guard(file);
    await act(`${stage}_publish`, () => replace ? fs.rename(temp, file) : fs.link(temp, file));
    if (!replace) await act(`${stage}_unlink_temp`, () => fs.unlink(temp));
    await syncDirectory(path.dirname(file));
  }
  async function mkdir(dir) { await guard(dir); await act('directory_create', () => fs.mkdir(dir, { mode: 0o700 })); await syncDirectory(path.dirname(dir)); }
  async function lock(file, run) {
    checkSignal(signal);
    const token = randomUUID(); let handle;
    try { handle = await open(file, 'wx', 'lock_open'); }
    catch (error) { if (error.code === 'EEXIST') fail('STATE_BUSY', 'lock_occupied'); throw error; }
    let error, result, own, ready = false;
    try {
      own = identity(await handle.stat());
      await write(handle, encode({ v: 1, owner: token, pid: process.pid }, limits), 0, 'lock_write');
      await sync(handle, 'lock_sync');
      await close(handle, 'lock_close'); handle = undefined;
      ready = true; checkSignal(signal); result = await run();
    } catch (failure) { error = failure; }
    if (handle) { try { await close(handle, 'lock_close'); } catch (failure) { error ??= failure; } }
    if (ready) {
      try {
        const record = decode(await read(file, 4096), limits); exact(record, ['v', 'owner', 'pid']); id(record.owner, 'domain', 'STATE_CORRUPT');
        if (record.v !== 1 || record.owner !== token || identity(await fs.lstat(file)) !== own) fail('STATE_CORRUPT', 'lock_owner');
        await act('lock_remove', () => fs.unlink(file));
      } catch (failure) { error ??= failure; }
    }
    if (error) throw error;
    return result;
  }
  return { root: stateDir, limits, signal, capability, guard, hook, act, open, close, write, sync, syncDirectory, read, publish, mkdir, lock };
}
