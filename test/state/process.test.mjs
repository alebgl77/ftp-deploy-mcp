import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, child, planId, claimInput, allocation, backup, policy, digest, stateError, offlineRemoveLocks } from './helpers.mjs';

function spawn(t,input){const c=child(input);t.after(()=>{if(c.proc.connected)c.proc.kill();});return c;}
test('real processes serialize one claim authority and conflicting plan/key associations',async t=>{
  const f=await fixture(t),id=planId();await f.store.publishPlan(id,Buffer.from('{}\n'));
  const first=spawn(t,{config:f.config,mode:'claim',planId:id,stage:'claim_commit_before'});await first.wait('held');
  const second=spawn(t,{config:f.config,mode:'claim',planId:id});const busy=await second.wait('result');await second.exit;
  assert.equal(busy.code,'STATE_BUSY');first.go();const committed=await first.wait('result');await first.exit;assert.equal(committed.ok,true);
  const same=spawn(t,{config:f.config,mode:'claim',planId:id});const repeated=await same.wait('result');await same.exit;
  assert.equal(repeated.result.operationId,committed.result.operationId);
  const different=spawn(t,{config:f.config,mode:'claim',planId:id,extra:{keyHash:digest('another')}});assert.equal((await different.wait('result')).code,'STATE_CONFLICT');await different.exit;
  const id2=planId();await f.store.publishPlan(id2,Buffer.from('{}\n'));
  const otherPlan=spawn(t,{config:f.config,mode:'claim',planId:id2,extra:{keyHash:digest(id)}});assert.equal((await otherPlan.wait('result')).code,'STATE_CONFLICT');await otherPlan.exit;
});
test('64 endpoint stripes bound files; independent stripe proceeds and collision fails fast across processes',async t=>{
  const f=await fixture(t),a='00000001'+'0'.repeat(56),same='00000041'+'f'.repeat(56),other='00000002'+'0'.repeat(56);
  const first=spawn(t,{config:f.config,mode:'endpoint',endpoint:a});await first.wait('held');
  const second=spawn(t,{config:f.config,mode:'endpoint',endpoint:same});assert.equal((await second.wait('result')).code,'STATE_BUSY');await second.exit;
  const third=spawn(t,{config:f.config,mode:'endpoint',endpoint:other});await third.wait('held');
  assert.equal((await fs.readdir(f.file('locks'))).filter(n=>n.startsWith('stripe-')).length,2);
  const status=await f.store.inventory();assert.equal(status.plans,0);
  third.go();await third.wait('result');await third.exit;first.go();await first.wait('result');await first.exit;
});
test('bootstrap race refuses loser and crash bootstrap lock is never stolen',async t=>{
  const f=await fixture(t),config={...f.config,stateDir:path.join(f.root,'fresh-state')};
  const first=spawn(t,{config,mode:'bootstrap',stage:'domain_publish_before'});await first.wait('held');
  const second=spawn(t,{config,mode:'bootstrap'});assert.equal((await second.wait('result')).code,'STATE_BUSY');await second.exit;
  first.proc.kill();await first.exit;
  const third=spawn(t,{config,mode:'bootstrap'});assert.equal((await third.wait('result')).code,'STATE_BUSY');await third.exit;
  await offlineRemoveLocks(config.stateDir);
  await assert.rejects(f.open({stateDir:config.stateDir}),stateError('STATE_CORRUPT','domain_missing'));
});
const claimStages=['initial_journal_write_before','initial_journal_write_after','initial_journal_sync_before','initial_journal_sync_after',
  'initial_journal_close_before','initial_journal_close_after','initial_journal_publish_before','initial_journal_publish_after',
  'initial_head_publish_before','initial_head_publish_after','claim_commit_before','claim_publish_before','claim_publish_after','claim_commit_after'];
for(const stage of claimStages){
  test(`process crash at ${stage} retains lock/evidence; only complete claim can reopen`,async t=>{
    const f=await fixture(t),id=planId();await f.store.publishPlan(id,Buffer.from('{}\n'));
    const c=spawn(t,{config:f.config,mode:'claim',planId:id,stage,crash:true});assert.equal((await c.exit).code,86);
    await assert.rejects(f.open(),stateError('STATE_BUSY'));
    await offlineRemoveLocks(f.config.stateDir);
    if(stage==='claim_commit_after'){
      const reopened=await f.open(),claim=await reopened.lookupClaim({planId:id});assert.ok(claim);
      assert.equal((await reopened.openJournal(claim.operationId,policy)).metadata.tip.seq,1);
    }else await assert.rejects(f.open(),stateError('STATE_CORRUPT'));
  });
}
for(const stage of ['journal_write_before','journal_write_after','journal_sync_before','journal_sync_after','journal_close_before','journal_close_after','head_write_before','head_write_after','head_sync_before','head_sync_after','head_close_before','head_close_after','head_publish_before','head_publish_after']){
  test(`process crash at append ${stage} never adopts an unacknowledged suffix`,async t=>{
    const f=await fixture(t),{claim}=await f.create();
    const c=spawn(t,{config:f.config,mode:'append',operationId:claim.operationId,stage,crash:true});assert.equal((await c.exit).code,86);
    await assert.rejects(f.open(),stateError('STATE_BUSY'));await offlineRemoveLocks(f.config.stateDir);
    if(['journal_write_before','head_publish_after'].includes(stage)){
      const s=await f.open(),writer=await s.openJournal(claim.operationId,policy);
      assert.equal(writer.metadata.tip.seq,stage==='journal_write_before'?1:2);
    }else await assert.rejects(f.open(),stateError('STATE_CORRUPT'));
  });
}
for(const stage of ['backup_open_after','backup_write_before','backup_write_after','backup_sync_before','backup_sync_after','backup_close_before','backup_close_after']){
  test(`process crash at ${stage} leaves the exact reserved index and no readiness event`,async t=>{
    const f=await fixture(t),entry=backup(),{claim}=await f.create(allocation([entry]));
    const c=spawn(t,{config:f.config,mode:'backup',operationId:claim.operationId,backup:entry,data:'abc',stage,crash:true});assert.equal((await c.exit).code,86);
    const s=await f.open(),writer=await s.openJournal(claim.operationId,policy);
    assert.equal(writer.metadata.tip.seq,1);
    await assert.rejects(writer.createBackup({...entry,read:async()=>assert.fail('no overwrite')}),stateError('STATE_CONFLICT','backup_exists'));
    const {fileIndex,...expectation}=entry;
    if(['backup_open_after','backup_write_before'].includes(stage))await assert.rejects(writer.openVerifiedBackup(0,expectation),stateError('STATE_CORRUPT','backup_size'));
    else {const handle=await writer.openVerifiedBackup(0,expectation);await handle.close();}
  });
}
