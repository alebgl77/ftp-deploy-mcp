import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openStateStore } from '../../src/state/index.mjs';
import { seal, encode, validateStateLimits } from '../../src/state/codec.mjs';
import { fixture, limits, planId, claimInput, allocation, backup, policy, stateError, delay, tick, digest, native, child, offlineRemoveLocks } from './helpers.mjs';

test('create:false leaves absent and empty directories untouched, existing domains remain usable',async t=>{
  const f=await fixture(t);let calls=0;const fault=()=>{calls++;};
  const absent=path.join(f.root,'absent','state');
  await assert.rejects(f.open({stateDir:absent,create:false,fault}),stateError('STATE_INVALID','domain_uninitialized'));
  await assert.rejects(fs.stat(path.dirname(absent)),error=>error.code==='ENOENT');
  const empty=path.join(f.root,'empty');await fs.mkdir(empty);
  await assert.rejects(f.open({stateDir:empty,create:false,fault}),stateError('STATE_INVALID','domain_uninitialized'));
  assert.deepEqual(await fs.readdir(empty),[]);assert.equal(calls,0);
  const existing=await f.open({create:false});assert.equal(existing.metadata.domainId,f.store.metadata.domainId);
  await fs.writeFile(path.join(empty,'orphan'),'');
  await assert.rejects(f.open({stateDir:empty,create:false}),stateError('STATE_CORRUPT','domain_missing'));
});
test('state quota and metadata capacity reject before operation artifact creation',async t=>{
  const f=await fixture(t),id=planId();await f.store.publishPlan(id,Buffer.from('{}\n'));
  await assert.rejects(f.store.claim(claimInput(id,allocation([],{metadataBytes:1}))),stateError('STATE_LIMIT','metadata_capacity'));
  assert.deepEqual(await fs.readdir(f.file('operations')),[]);
  await assert.rejects(f.store.claim(claimInput(id,allocation([],{backupFiles:11}))),stateError('STATE_INVALID'));
  const absent=path.join(f.root,'too-small');
  await assert.rejects(f.open({stateDir:absent,limits:{...limits,maxStateBytes:100,maxBackupBytes:100}}),stateError('STATE_LIMIT','fixed_capacity'));
  await assert.rejects(fs.stat(absent),error=>error.code==='ENOENT');
});
test('exact byte budget remains charged across reopen and recovery cannot fund apply',async t=>{
  const f=await fixture(t),base=await f.create();const initial=base.writer.metadata.tip.byte_length;
  const {writer,claim}=await f.create(allocation([],{applyJournalBytes:initial,recoveryJournalBytes:8192}));
  assert.equal(writer.metadata.used.apply.bytes,initial);
  await assert.rejects(writer.requireBudget({bytes:1,events:0,budget:'apply'}),stateError('STATE_LIMIT','journal_budget'));
  const reopened=await f.store.openJournal(claim.operationId,policy);
  await assert.rejects(reopened.append({type:'STEP'},{budget:'apply'}),stateError('STATE_LIMIT','journal_budget'));
  await reopened.append({type:'DONE'},{budget:'recovery'});assert.equal(reopened.metadata.used.apply.bytes,initial);
});
test('unknown backup indices, missing claim and supported-layout version failures cannot be reconstructed',async t=>{
  const f=await fixture(t),{claim,id}=await f.create();
  const blob=f.file('operations',claim.operationId,'backups','9.blob');await fs.writeFile(blob,'');
  await assert.rejects(f.store.inventory(),stateError('STATE_CORRUPT','backup_index'));await fs.unlink(blob);
  await fs.unlink(f.file('claims',`${id}.json`));await assert.rejects(f.open(),stateError('STATE_CORRUPT','operation_reference'));
  const domain=f.file('domain.json'),bytes=seal({v:2,domainId:f.store.metadata.domainId},validateStateLimits(limits));await fs.writeFile(domain,bytes);
  await assert.rejects(f.open(),stateError('STATE_CORRUPT','domain_version'));
});
test('unsupported no-clobber leaves existing ID intact; orphan publication artifacts are never deleted',async t=>{
  const f=await fixture(t),id=planId();
  const failing=await f.open({fault:stage=>{if(stage==='plan_publish_before')throw native('ENOTSUP','link');}});
  await assert.rejects(failing.publishPlan(id,Buffer.from('{}\n')),stateError('STATE_IO'));
  const evidence=await fs.readdir(f.file('plans'));assert.equal(evidence.length,1);assert.match(evidence[0],/^\.publish-/);
  await assert.rejects(f.open(),stateError('STATE_CORRUPT'));
  assert.deepEqual(await fs.readdir(f.file('plans')),evidence);
});
test('status/replay refuses admission while another process appends without diagnosing its active head temp',async t=>{
  const f=await fixture(t),{claim}=await f.create();
  const c=child({config:f.config,mode:'append',operationId:claim.operationId,stage:'head_write_before'});t.after(()=>{if(c.proc.connected)c.proc.kill();});
  await c.wait('held');await assert.rejects(f.store.openJournal(claim.operationId,policy),stateError('STATE_BUSY'));
  await assert.rejects(f.store.inventory(),stateError('STATE_BUSY'));
  c.go();assert.equal((await c.wait('result')).ok,true);await c.exit;
  assert.equal((await f.store.openJournal(claim.operationId,policy)).metadata.tip.seq,2);
});
test('lock removal failure leaves an explicit lock and never permits an unlocked callback',async t=>{
  let armed=false;const f=await fixture(t,{fault:stage=>{if(armed&&stage==='lock_remove_before')throw native('EPERM','unlink');}});
  armed=true;let callbacks=0;
  await assert.rejects(f.store.withEndpointLock(digest('locked'),async()=>{callbacks++;}),stateError('STATE_IO'));
  await assert.rejects(f.store.withEndpointLock(digest('locked'),async()=>{callbacks++;}),stateError('STATE_BUSY'));
  assert.equal(callbacks,1);assert.equal((await fs.readdir(f.file('locks'))).length,1);
});
test('async callbacks are refused and late rejections consumed; caller payload is not retained',async t=>{
  const f=await fixture(t),id=planId();await f.store.publishPlan(id,Buffer.from('{}\n'));
  await assert.rejects(f.store.claim(claimInput(id,allocation(),{validateEvent:async()=>{throw new Error('PRIVATE_NATIVE');}})),stateError('STATE_CORRUPT'));
  await assert.rejects(f.store.claim(claimInput(id,allocation(),{reduce:async()=>{throw new Error('PRIVATE_NATIVE');}})),stateError('STATE_CORRUPT'));
  await tick();assert.equal((await f.store.inventory()).operations,0);
  const data={type:'INIT'}, pending=f.store.claim(claimInput(id,allocation(),{initialEvent:data}));data.type='DONE';
  const claim=await pending;assert.equal((await f.store.openJournal(claim.operationId,policy)).metadata.state.done,false);
});
test('root directory retarget is detected before any subsequent plan write',async t=>{
  const f=await fixture(t),old=path.join(f.root,'old-state');await fs.rename(f.config.stateDir,old);await fs.mkdir(f.config.stateDir,{mode:0o700});
  await assert.rejects(f.store.publishPlan(planId(),Buffer.from('{}\n')),stateError('STATE_CORRUPT','root_identity'));
  assert.deepEqual(await fs.readdir(f.config.stateDir),[]);
});
test('all 64 endpoint stripes are bounded and a 65th colliding call fails without a waiter',async t=>{
  const f=await fixture(t),release=delay(),all=delay();let active=0;
  const pending=Array.from({length:64},(_,n)=>f.store.withEndpointLock(n.toString(16).padStart(8,'0')+'0'.repeat(56),async()=>{
    if(++active===64)all.resolve();await release.promise;
  }));
  await all.promise;assert.equal((await fs.readdir(f.file('locks'))).length,64);
  await assert.rejects(f.store.withEndpointLock('00000040'+'f'.repeat(56),async()=>assert.fail()),stateError('STATE_BUSY'));
  assert.equal((await f.store.inventory()).artifacts,70);
  release.resolve();await Promise.all(pending);assert.deepEqual(await fs.readdir(f.file('locks')),[]);
});
for(const stage of ['domain_write_before','domain_write_after','domain_sync_before','domain_sync_after','domain_close_before','domain_close_after','domain_publish_before','domain_publish_after']){
  test(`bootstrap process crash at ${stage} never reconstructs a partially initialized domain`,async t=>{
    const f=await fixture(t),config={...f.config,stateDir:path.join(f.root,'bootstrap-crash')};
    const c=child({config,mode:'bootstrap',stage,crash:true});t.after(()=>{if(c.proc.connected)c.proc.kill();});assert.equal((await c.exit).code,86);
    await assert.rejects(f.open({stateDir:config.stateDir}),stateError('STATE_BUSY','bootstrap_occupied'));
    await offlineRemoveLocks(config.stateDir);await assert.rejects(f.open({stateDir:config.stateDir}),stateError('STATE_CORRUPT'));
  });
}
