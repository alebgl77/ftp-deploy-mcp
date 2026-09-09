import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateError, fail, id, hash, integer, exact, encode, decode, seal, validateStateLimits } from './codec.mjs';
import { createIO, checkSignal, safeFailure, identity } from './io.mjs';
import { readDomain, readPlanRecord, readClaimRecord, reservation, headRecord, FIXED_BYTES } from './records.mjs';
import { initializeJournal, loadWriter } from './writer.mjs';

export { StateError, validateStateLimits };
export async function openStateStore(options = {}) {
  if (options.create !== undefined && typeof options.create !== 'boolean') fail('STATE_INVALID', 'create_option');
  const limits = validateStateLimits(options.limits);
  if (limits.maxStateBytes < FIXED_BYTES) fail('STATE_LIMIT', 'fixed_capacity');
  let io;
  try { io = await createIO({ ...options, limits, localRoots: options.localRoots ?? [] }); }
  catch (error) { throw safeFailure(error, 'store_open'); }
  const root = io.root;
  const p = (...parts) => path.join(root, ...parts);
  let domain, closing = false, admission = false;
  const pending = new Set(), stripes = new Set(), backups = new Set(), handles = new Map();
  const owned = { io, limits, path: p, backups, handles };
  async function execute(run) {
    if (closing) fail('STATE_BUSY', 'store_closed');
    checkSignal(io.signal);
    const task = Promise.resolve().then(run).catch(error => { throw safeFailure(error, 'store_io'); });
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  async function admit(run) {
    if (admission) fail('STATE_BUSY', 'admission_occupied');
    admission = true;
    try { return await execute(() => io.lock(p('locks', 'admission.lock'), async () => { await io.guard(); return run(); })); }
    finally { admission = false; }
  }
  Object.assign(owned, { admit, execute, domain: () => domain.domainId });
  async function names(dir, maximum) {
    await io.guard(dir); const reader = await fs.opendir(dir); const result = []; let error;
    try {
      while (true) {
        const entry = await reader.read(); if (!entry) break;
        result.push(entry.name);
        if (result.length > maximum) fail('STATE_LIMIT', 'artifact_count');
      }
    } catch (failure) { error = failure; }
    try { await reader.close(); } catch (failure) { error ??= failure; }
    if (error) throw error;
    return result.sort();
  }
  async function isFile(file, max) {
    await io.guard(file); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STATE_CORRUPT', 'artifact_shape');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('STATE_CORRUPT', 'file_permissions');
    if (stat.size > max) fail('STATE_LIMIT', 'artifact_bytes');
    return stat;
  }
  async function directory(dir) {
    await io.guard(dir); const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STATE_CORRUPT', 'artifact_shape');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('STATE_CORRUPT', 'directory_permissions');
  }
  async function scan() {
    await directory(root);
    const roots = await names(root, 6);
    if (roots.join('|') !== ['claims', 'domain.json', 'locks', 'operations', 'plans'].sort().join('|')) fail('STATE_CORRUPT', 'domain_layout');
    const marker = readDomain(await io.read(p('domain.json'), 4096), limits);
    if (marker.domainId !== domain.domainId) fail('STATE_CORRUPT', 'domain_identity');
    for (const dir of ['claims', 'locks', 'operations', 'plans']) await directory(p(dir));
    let actualBytes = (await isFile(p('domain.json'), 4096)).size, artifacts = 5;
    const lockNames = await names(p('locks'), 65);
    for (const name of lockNames) {
      const endpoint = /^stripe-(?:[0-5][0-9]|6[0-3])\.lock$/.test(name);
      if (name !== 'admission.lock' && !endpoint) fail('STATE_CORRUPT', 'lock_layout');
      let stat;
      try {
        await io.hook('inventory_lock_stat', 'before', { name });
        stat = await isFile(p('locks', name), 4096);
      } catch (error) {
        // An endpoint owner may normally release after the directory listing.
        // Admission and all persistent references remain strict.
        if (endpoint && error.code === 'ENOENT') continue;
        throw error;
      }
      actualBytes += stat.size; artifacts++;
      // Endpoint acquisition is earlier in the lock order: its small owner
      // record may still be writing. Inventory counts the bounded artifact;
      // only its owner validates the token before release. Admission is ours.
      if (name === 'admission.lock') {
        const lock = decode(await io.read(p('locks', name), 4096), limits);
        exact(lock, ['v', 'owner', 'pid']); id(lock.owner, 'domain', 'STATE_CORRUPT'); integer(lock.pid, Number.MAX_SAFE_INTEGER, 'STATE_CORRUPT', 1);
        if (lock.v !== 1) fail('STATE_CORRUPT', 'lock_version');
      }
    }
    const plans = new Map(), claims = new Map(), operations = new Map(), keys = new Set();
    for (const name of await names(p('plans'), limits.maxPlans)) {
      if (!name.endsWith('.json')) fail('STATE_CORRUPT', 'plan_layout');
      const planId = id(name.slice(0, -5), 'plan', 'STATE_CORRUPT');
      const bytes = await io.read(p('plans', name), limits.maxPlanBytes);
      plans.set(planId, readPlanRecord(bytes, planId, domain.domainId, limits)); actualBytes += bytes.length; artifacts++;
      if (actualBytes > limits.maxStateBytes || FIXED_BYTES + plans.size * limits.maxPlanBytes * 2 > limits.maxStateBytes) fail('STATE_LIMIT', 'state_bytes');
    }
    let reservedBytes = FIXED_BYTES + plans.size * limits.maxPlanBytes * 2, backupBytes = 0, backupFiles = 0;
    for (const name of await names(p('claims'), limits.maxOperations)) {
      if (!name.endsWith('.json')) fail('STATE_CORRUPT', 'claim_layout');
      const planId = id(name.slice(0, -5), 'plan', 'STATE_CORRUPT');
      const bytes = await io.read(p('claims', name), limits.maxPlanBytes);
      const claim = readClaimRecord(bytes, planId, domain.domainId, limits), r = claim.reservation;
      if (plans.get(planId)?.hash !== claim.planHash || operations.has(claim.operationId) || keys.has(claim.keyHash)) fail('STATE_CORRUPT', 'claim_reference');
      claims.set(planId, claim); operations.set(claim.operationId, claim); keys.add(claim.keyHash);
      reservedBytes += r.applyJournalBytes + r.recoveryJournalBytes + r.backupBytes + r.metadataBytes;
      backupBytes += r.backupBytes; backupFiles += r.backupFiles; actualBytes += bytes.length; artifacts++;
      if (actualBytes > limits.maxStateBytes) fail('STATE_LIMIT', 'state_bytes');
      if (reservedBytes > limits.maxStateBytes || backupBytes > limits.maxBackupBytes || backupFiles > limits.maxBackupFiles) fail('STATE_LIMIT', 'state_reservation');
    }
    const operationNames = await names(p('operations'), limits.maxOperations);
    if (operationNames.length !== operations.size) fail('STATE_CORRUPT', 'operation_reference');
    for (const operationId of operationNames) {
      id(operationId, 'operation', 'STATE_CORRUPT'); const claim = operations.get(operationId);
      if (!claim) fail('STATE_CORRUPT', 'orphan_operation');
      const dir = p('operations', operationId); await directory(dir); artifacts++;
      if ((await names(dir, 6)).join('|') !== 'backups|head.json|journal.jsonl') fail('STATE_CORRUPT', 'operation_layout');
      const head = headRecord(decode(await io.read(path.join(dir, 'head.json'), 4096), limits));
      const journal = await isFile(path.join(dir, 'journal.jsonl'), claim.reservation.applyJournalBytes + claim.reservation.recoveryJournalBytes);
      if (journal.size !== head.byte_length) fail('STATE_CORRUPT', 'head_length');
      actualBytes += journal.size + (await isFile(path.join(dir, 'head.json'), 4096)).size; artifacts += 2;
      if (actualBytes > limits.maxStateBytes) fail('STATE_LIMIT', 'state_bytes');
      const backupDir = path.join(dir, 'backups'); await directory(backupDir); artifacts++;
      const expected = new Map(claim.reservation.backups.map(item => [`${item.fileIndex}.blob`, item]));
      for (const name of await names(backupDir, Math.max(1, claim.reservation.backups.length * 2))) {
        if (!expected.has(name)) fail('STATE_CORRUPT', 'backup_index');
        actualBytes += (await isFile(path.join(backupDir, name), expected.get(name).expectedBytes)).size; artifacts++;
        if (actualBytes > limits.maxStateBytes) fail('STATE_LIMIT', 'state_bytes');
      }
    }
    if (reservedBytes > limits.maxStateBytes || actualBytes > reservedBytes || artifacts > 71 + plans.size * 3 + operations.size * 6 + backupFiles * 2) fail('STATE_LIMIT', 'state_bytes');
    return { plans, claims, operations, actualBytes, reservedBytes, backupBytes, backupFiles, artifacts };
  }
  owned.scan = scan;
  async function plan(planId) { return readPlanRecord(await io.read(p('plans', `${id(planId, 'plan')}.json`), limits.maxPlanBytes), planId, domain.domainId, limits); }
  owned.claimFor = async (operationId) => {
    id(operationId, 'operation'); const state = await scan();
    const record = state.operations.get(operationId); if (!record) fail('STATE_CONFLICT', 'operation_missing'); return record;
  };
  const store = {
    get metadata() { return Object.freeze({ v: 1, domainId: domain.domainId, ...io.capability, logicalReservations: true, endpointStripes: 64 }); },
    async withEndpointLock(endpointSha256, run) {
      hash(endpointSha256); if (typeof run !== 'function') fail('STATE_INVALID', 'callback');
      const stripe = Number.parseInt(endpointSha256.slice(0, 8), 16) % 64;
      if (stripes.has(stripe)) fail('STATE_BUSY', 'stripe_occupied');
      stripes.add(stripe);
      try { return await execute(() => io.lock(p('locks', `stripe-${String(stripe).padStart(2, '0')}.lock`), run)); }
      finally { stripes.delete(stripe); }
    },
    async publishPlan(planId, validatedPlanBytes) {
      id(planId, 'plan');
      const payload = decode(validatedPlanBytes, limits, limits.maxPlanBytes);
      const bytes = seal({ v: 1, domainId: domain.domainId, planId, payload }, limits, limits.maxPlanBytes);
      return admit(async () => {
        const current = await scan();
        if (current.plans.has(planId)) fail('STATE_CONFLICT', 'plan_exists');
        if (current.plans.size >= limits.maxPlans || current.reservedBytes + 2 * limits.maxPlanBytes > limits.maxStateBytes) fail('STATE_LIMIT', 'plan_capacity');
        checkSignal(io.signal); await io.publish(p('plans', `${planId}.json`), bytes, { stage: 'plan' });
        return Object.freeze({ planId, digest: decode(bytes, limits, limits.maxPlanBytes).hash });
      });
    },
    async readPlan(planId) { id(planId, 'plan'); return admit(async () => { await scan(); return encode((await plan(planId)).payload, limits, limits.maxPlanBytes); }); },
    async claim(supplied) {
      const input = { ...supplied, initialEvent: decode(encode(supplied?.initialEvent, limits), limits) };
      exact(input, ['planId', 'keyHash', 'targetHash', 'reservation', 'initialEvent', 'validateEvent', 'reduce'], 'STATE_INVALID');
      id(input.planId, 'plan'); hash(input.keyHash); hash(input.targetHash);
      const allocation = reservation(input.reservation, limits);
      return admit(async () => {
        const current = await scan(), existing = current.claims.get(input.planId);
        if (existing) {
          if (existing.keyHash !== input.keyHash || existing.targetHash !== input.targetHash) fail('STATE_CONFLICT', 'claim_association');
          return structuredClone(existing);
        }
        if ([...current.claims.values()].some(c => c.keyHash === input.keyHash)) fail('STATE_CONFLICT', 'key_association');
        const original = current.plans.get(input.planId); if (!original) fail('STATE_CONFLICT', 'plan_missing');
        const operationId = `op_${randomUUID()}`;
        const record = { v: 1, domainId: domain.domainId, planId: input.planId, planHash: original.hash, operationId,
          keyHash: input.keyHash, targetHash: input.targetHash, reservation: allocation };
        const bytes = seal(record, limits, limits.maxPlanBytes);
        if (allocation.metadataBytes < 2 * bytes.length + 8192) fail('STATE_LIMIT', 'metadata_capacity');
        const additional = allocation.applyJournalBytes + allocation.recoveryJournalBytes + allocation.backupBytes + allocation.metadataBytes;
        if (current.operations.size >= limits.maxOperations || current.reservedBytes + additional > limits.maxStateBytes ||
            current.backupBytes + allocation.backupBytes > limits.maxBackupBytes || current.backupFiles + allocation.backupFiles > limits.maxBackupFiles) fail('STATE_LIMIT', 'claim_capacity');
        checkSignal(io.signal);
        await initializeJournal(owned, record, input.initialEvent, { validateEvent: input.validateEvent, reduce: input.reduce });
        await io.hook('claim_commit', 'before');
        await io.publish(p('claims', `${input.planId}.json`), bytes, { stage: 'claim' });
        await io.hook('claim_commit', 'after');
        return structuredClone(decode(bytes, limits, limits.maxPlanBytes));
      });
    },
    async lookupClaim(selector) {
      if (!selector || Object.keys(selector).length !== 1 || !['planId', 'operationId'].includes(Object.keys(selector)[0])) fail('STATE_INVALID', 'claim_selector');
      const [key] = Object.keys(selector); id(selector[key], key === 'planId' ? 'plan' : 'operation');
      return admit(async () => { const current = await scan(); return structuredClone((key === 'planId' ? current.claims : current.operations).get(selector[key]) ?? null); });
    },
    async openJournal(operationId, callbacks) { id(operationId, 'operation'); return admit(async () => loadWriter(owned, await owned.claimFor(operationId), callbacks)); },
    async inventory() {
      return admit(async () => { const s = await scan(); return Object.freeze({ plans: s.plans.size, operations: s.operations.size,
        actualBytes: s.actualBytes, reservedBytes: s.reservedBytes, backupBytes: s.backupBytes, backupFiles: s.backupFiles, artifacts: s.artifacts }); });
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
      const outcomes = await Promise.allSettled([...handles.values()].map(handle => handle.close()));
      if (outcomes.some(r => r.status === 'rejected')) fail('STATE_IO', 'store_close');
    },
  };
  try {
    // Bootstrap can temporarily own domain + publication link + lock + four
    // directories. Detect the fixed lock before the ordinary layout bound.
    await io.guard(p('bootstrap.lock'));
    try { await fs.lstat(p('bootstrap.lock')); fail('STATE_BUSY', 'bootstrap_occupied'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entries = await names(root, 6);
    if (entries.includes('bootstrap.lock')) fail('STATE_BUSY', 'bootstrap_occupied');
    if (!entries.includes('domain.json')) {
      if (entries.length) fail('STATE_CORRUPT', 'domain_missing');
      if (options.create === false) fail('STATE_INVALID', 'domain_uninitialized');
      await directory(root);
      await io.lock(p('bootstrap.lock'), async () => {
        if ((await names(root, 1)).join('|') !== 'bootstrap.lock') fail('STATE_CORRUPT', 'bootstrap_layout');
        for (const dir of ['plans', 'claims', 'operations', 'locks']) await io.mkdir(p(dir));
        const bytes = seal({ v: 1, domainId: randomUUID() }, limits);
        await io.publish(p('domain.json'), bytes, { stage: 'domain' }); domain = readDomain(bytes, limits);
      });
    } else domain = readDomain(await io.read(p('domain.json'), 4096), limits);
    await admit(scan);
    return store;
  } catch (error) { throw safeFailure(error, 'store_open'); }
}
