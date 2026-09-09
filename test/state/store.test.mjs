import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openStateStore } from '../../src/state/store.mjs';
import { encode, seal } from '../../src/state/codec.mjs';
import { fixture, limits, planId, claimInput, allocation, backup, policy, stateError, delay, tick, digest, native, offlineRemoveLocks } from './helpers.mjs';

test('disabled/overlapping/noncanonical state never initializes; sibling bootstrap and private modes work', async t => {
  await assert.rejects(openStateStore({}), stateError('STATE_DISABLED'));
  const f = await fixture(t);
  await assert.rejects(openStateStore({...f.config,stateDir:f.config.localRoots[0]}), stateError('STATE_INVALID','state_overlap'));
  await assert.rejects(openStateStore({...f.config,stateDir:f.root}), stateError('STATE_INVALID','state_overlap'));
  assert.deepEqual((await f.store.inventory()).plans,0);
  if(process.platform !== 'win32') {
    assert.equal((await fs.stat(f.config.stateDir)).mode & 0o777,0o700);
    assert.equal((await fs.stat(f.file('domain.json'))).mode & 0o777,0o600);
  }
  const alias=path.join(f.root,'alias'); await fs.symlink(f.config.stateDir,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(openStateStore({...f.config,stateDir:alias}),stateError('STATE_INVALID'));
});
test('domain marker missing, unknown files, versions and retargeted directory identities fail closed', async t => {
  const f=await fixture(t);
  await fs.writeFile(f.file('unexpected'),'');
  await assert.rejects(f.store.inventory(),stateError('STATE_CORRUPT'));
  await fs.unlink(f.file('unexpected')); await fs.unlink(f.file('domain.json'));
  await assert.rejects(f.open(),stateError('STATE_CORRUPT','domain_missing'));
  assert.equal((await fs.readdir(f.config.stateDir)).includes('domain.json'),false);
});
test('plans are exclusive, bounded digest envelopes and detached verified payload bytes', async t => {
  const f=await fixture(t), id=planId();
  const bytes=Buffer.from('{"files":[]}\n'); await f.store.publishPlan(id,bytes);
  await assert.rejects(f.store.publishPlan(id,bytes),stateError('STATE_CONFLICT','plan_exists'));
  assert.deepEqual(await f.store.readPlan(id),bytes);
  const first=await f.store.readPlan(id); first.fill(0); assert.deepEqual(await f.store.readPlan(id),bytes);
  const file=f.file('plans',`${id}.json`), original=await fs.readFile(file,'utf8');
  await fs.writeFile(file,original.replace('"files":[]','"files":[0]'));
  await assert.rejects(f.store.readPlan(id),stateError('STATE_CORRUPT','record_digest'));
});
test('claim authority is immutable; duplicate association returns without writes; missing references never reconstruct', async t => {
  let writes=0; const f=await fixture(t,{fault:stage=>{if(stage.endsWith('_write_before')&&!stage.startsWith('lock'))writes++;}});
  const {id,claim}=await f.create(); const before=writes;
  assert.equal((await f.store.claim(claimInput(id))).operationId,claim.operationId); assert.equal(writes,before);
  await assert.rejects(f.store.claim(claimInput(id,allocation(),{keyHash:digest('other')})),stateError('STATE_CONFLICT','claim_association'));
  const other=planId(); await f.store.publishPlan(other,Buffer.from('{}\n'));
  await assert.rejects(f.store.claim(claimInput(other,allocation(),{keyHash:digest(id)})),stateError('STATE_CONFLICT','key_association'));
  assert.equal((await f.store.lookupClaim({operationId:claim.operationId})).planId,id);
  await fs.unlink(f.file('operations',claim.operationId,'journal.jsonl'));
  await assert.rejects(f.open(),stateError('STATE_CORRUPT'));
  assert.equal((await fs.readdir(f.file('operations',claim.operationId))).includes('journal.jsonl'),false);
});
test('quotas reserve all future logical capacity, retain zero backups and reject before writes', async t => {
  const f=await fixture(t,{limits:{...limits,maxPlans:1,maxBackupFiles:1}});
  const {id,claim}=await f.create(allocation([backup(0,'')]));
  const before=await f.store.inventory(); assert.equal(before.backupFiles,1); assert.equal(before.backupBytes,0);
  assert.ok(before.reservedBytes>before.actualBytes);
  await assert.rejects(f.store.publishPlan(planId(),Buffer.from('{}\n')),stateError('STATE_LIMIT','plan_capacity'));
  assert.equal((await f.store.inventory()).reservedBytes,before.reservedBytes);
  const writer=await f.store.openJournal(claim.operationId,policy);
  await assert.rejects(writer.createBackup({...backup(1,''),read:async()=>assert.fail('no callback')}),stateError('STATE_CONFLICT','unreserved_backup'));
  await assert.rejects(f.store.claim(claimInput(id,allocation([], {metadataBytes:1}),{keyHash:digest('different')})),stateError('STATE_CONFLICT'));
});
test('pure event validation and transition errors block creation/append and caller mutation cannot change events', async t => {
  const f=await fixture(t), id=planId(); await f.store.publishPlan(id,Buffer.from('{}\n'));
  await assert.rejects(f.store.claim(claimInput(id,allocation(),{initialEvent:{type:'DONE'}})),stateError('STATE_CORRUPT','event_transition'));
  assert.equal((await f.store.inventory()).operations,0);
  const {writer}=await f.create(); const before=writer.metadata;
  await assert.rejects(writer.append({type:'INIT'},{budget:'apply'}),stateError('STATE_CORRUPT','event_transition'));
  assert.deepEqual(writer.metadata,before);
  const event={type:'STEP'}; const append=writer.append(event,{budget:'apply'}); event.type='INIT'; await append;
  assert.equal(writer.metadata.state.count,2);
  writer.metadata.state.count=999; assert.equal(writer.metadata.state.count,2);
});
test('replay restores distinct apply/recovery budgets; stale writers cannot append', async t => {
  const f=await fixture(t), {claim,writer}=await f.create(allocation([],{applyJournalEvents:2,recoveryJournalEvents:1}));
  const stale=await f.store.openJournal(claim.operationId,policy);
  await writer.append({type:'STEP'},{budget:'apply'});
  await assert.rejects(stale.append({type:'STEP'},{budget:'apply'}),stateError('STATE_BUSY','stale_writer'));
  const reopened=await f.store.openJournal(claim.operationId,policy);
  await assert.rejects(reopened.requireBudget({bytes:1,events:1,budget:'apply'}),stateError('STATE_LIMIT','journal_budget'));
  await assert.rejects(reopened.append({type:'STEP'},{budget:'apply'}),stateError('STATE_LIMIT','journal_budget'));
  await reopened.requireBudget({bytes:256,events:1,budget:'recovery'});
  await reopened.append({type:'DONE'},{budget:'recovery'});
  const final=await f.store.openJournal(claim.operationId,policy);
  assert.equal(final.metadata.used.apply.events,2); assert.equal(final.metadata.used.recovery.events,1);
});
for(const alteration of ['removed_suffix','extra_suffix','partial_suffix','missing_head','bad_hash','unknown_version']) {
  test(`journal refuses ${alteration} without repair`,async t=>{
    const f=await fixture(t),{claim,writer}=await f.create(); await writer.append({type:'STEP'},{budget:'apply'});
    const file=f.file('operations',claim.operationId,'journal.jsonl'), head=f.file('operations',claim.operationId,'head.json');
    const bytes=await fs.readFile(file), lines=bytes.toString().trimEnd().split('\n');
    if(alteration==='removed_suffix') await fs.writeFile(file,`${lines[0]}\n`);
    if(alteration==='extra_suffix') await fs.appendFile(file,`${lines[1]}\n`);
    if(alteration==='partial_suffix') await fs.appendFile(file,'{"v":');
    if(alteration==='missing_head') await fs.unlink(head);
    if(alteration==='bad_hash') await fs.writeFile(file,bytes.toString().replace('"STEP"','"DONE"'));
    if(alteration==='unknown_version') await fs.writeFile(file,bytes.toString().replace('"v":1','"v":2'));
    const corrupted=await fs.readFile(file);
    await assert.rejects(f.store.openJournal(claim.operationId,policy),stateError('STATE_CORRUPT'));
    assert.deepEqual(await fs.readFile(file),corrupted);
  });
}
test('short writes are completed and append I/O is linear without journal replay per event',async t=>{
  let measure=false, replay=0,written=0; const f=await fixture(t,{fault:(stage,detail)=>{
    if(measure&&stage==='journal_replay_before')replay++;
    if(measure&&stage==='journal_write_after')written+=detail.bytes;
    if(stage.endsWith('_write_before'))return{maxWriteBytes:7};
  }});
  const {writer}=await f.create(); const initial=writer.metadata.tip.byte_length;measure=true;
  for(let i=0;i<12;i++)await writer.append({type:'STEP'},{budget:'apply'});
  assert.equal(replay,0); assert.equal(written,writer.metadata.tip.byte_length-initial);
});
for(const stage of ['journal_write_before','journal_sync_before','journal_close_before','head_write_before','head_sync_before','head_close_before','head_publish_before','head_publish_after']) {
  test(`failed append ${stage} propagates, poisons writer and prevents later append`,async t=>{
    let armed=false;const f=await fixture(t,{fault:s=>{if(armed&&s===stage)throw native();}}),{writer}=await f.create();
    armed=true;await assert.rejects(writer.append({type:'STEP'},{budget:'apply'}),stateError('STATE_IO'));
    assert.equal(writer.metadata.poisoned,true);
    await assert.rejects(writer.append({type:'STEP'},{budget:'apply'}),stateError('STATE_CORRUPT','writer_poisoned'));
  });
}
test('cancellation and close retain endpoint/admission until delayed write actually settles; no waiter queue',async t=>{
  const entered=delay(),release=delay(),controller=new AbortController();let armed=false;
  const f=await fixture(t,{signal:controller.signal,fault:async stage=>{if(armed&&stage==='journal_write_before'){entered.resolve();await release.promise;}}});
  const {writer}=await f.create();armed=true;
  const pending=f.store.withEndpointLock(digest('endpoint'),()=>writer.append({type:'STEP'},{budget:'apply'}));
  await entered.promise;controller.abort();let closed=false;const closing=f.store.close().then(()=>{closed=true;});
  await tick();assert.equal(closed,false);
  assert.ok((await fs.readdir(f.file('locks'))).includes('admission.lock'));
  await assert.rejects(f.store.inventory(),stateError('STATE_BUSY'));
  release.resolve();await pending;await closing;assert.equal(closed,true);
  assert.deepEqual(await fs.readdir(f.file('locks')),[]);
});
test('real Windows directory fsync exposes its reduced capability',async t=>{
  const f=await fixture(t);assert.equal(f.store.metadata.powerLoss,'not_guaranteed');
  if(process.platform==='win32'){assert.equal(f.store.metadata.directorySync,false);assert.equal(f.store.metadata.directorySyncLimitation,'windows_eperm_fsync');}
});
for(const [stage,code,syscall] of [['directory_sync_before','EIO','fsync'],['directory_close_before','EPERM','close'],['plan_sync_before','EPERM','fsync'],['plan_close_before','EPERM','close'],['plan_publish_before','EPERM','link']]) {
  test(`unexpected ${stage}/${code} always fails closed`,async t=>{
    const f=await fixture(t);
    const store=await f.open({fault:s=>{if(s===stage)throw native(code,syscall);}});
    await assert.rejects(store.publishPlan(planId(),Buffer.from('{}\n')),stateError('STATE_IO'));
    await store.close();
  });
}
