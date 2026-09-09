import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { fixture, allocation, backup, policy, stateError, delay, tick, native, digest } from './helpers.mjs';

for(const data of ['', 'original-content']) {
  test(`verified backup streams exact bytes and immutable mode metadata (${data.length} bytes)`,async t=>{
    const entry=backup(0,data,0o755), f=await fixture(t), {claim,writer}=await f.create(allocation([entry]));
    const result=await writer.createBackup({...entry,read:async sink=>{if(data)sink.write(data);}});
    assert.equal(result.bytes,Buffer.byteLength(data));assert.equal(result.mode,0o755);
    const {fileIndex,...expectation}=entry, reader=await writer.openVerifiedBackup(0,expectation);
    const buffer=Buffer.alloc(64); const read=await reader.read(buffer,0,buffer.length,0);
    assert.equal(buffer.subarray(0,read.bytesRead).toString(),data);await reader.close();
    await assert.rejects(reader.read(buffer,0,1,0),stateError('STATE_BUSY','backup_closed'));
    await assert.rejects(writer.createBackup({...entry,read:async()=>assert.fail('no overwrite')}),stateError('STATE_CONFLICT','backup_exists'));
    if(process.platform!=='win32') assert.equal((await fs.stat(f.file('operations',claim.operationId,'backups','0.blob'))).mode&0o777,0o600);
    assert.equal(writer.metadata.state.count,1,'storage never appends an application readiness event');
  });
}
for(const [kind,data,code] of [['grows','abcd','STATE_LIMIT'],['shrinks','ab','STATE_CORRUPT'],['hash_mismatch','xyz','STATE_CORRUPT']]) {
  test(`backup ${kind} retains explicit incomplete blob without consuming another reservation`,async t=>{
    const f=await fixture(t),entry=backup(),{writer,claim}=await f.create(allocation([entry,backup(1,'')]));
    await assert.rejects(writer.createBackup({...entry,read:async sink=>{sink.write(data);}}),stateError(code));
    await assert.rejects(writer.createBackup({...entry,read:async()=>assert.fail()}),stateError('STATE_CONFLICT','backup_exists'));
    assert.equal((await f.store.inventory()).backupFiles,2);
    assert.ok((await fs.stat(f.file('operations',claim.operationId,'backups','0.blob'))).size<=3);
    await writer.createBackup({...backup(1,''),read:async()=>{}});
  });
}
test('zero-byte cap rejects actual data; unreserved index/size/mode cannot allocate a blob',async t=>{
  const f=await fixture(t),entry=backup(0,''),{writer,claim}=await f.create(allocation([entry]));
  for(const change of [{fileIndex:1},{expectedBytes:1},{mode:0o777}]) await assert.rejects(writer.createBackup({...entry,...change,read:async()=>assert.fail()}),stateError('STATE_CONFLICT'));
  assert.deepEqual(await fs.readdir(f.file('operations',claim.operationId,'backups')),[]);
  await assert.rejects(writer.createBackup({...entry,read:async sink=>{sink.write('x');}}),stateError('STATE_LIMIT','backup_bytes'));
});
for(const stage of ['backup_open_after','backup_write_before','backup_write_after','backup_sync_before','backup_sync_after','backup_close_before','backup_close_after']) {
  test(`backup ${stage} error propagates and never acknowledges readiness`,async t=>{
    let armed=false;const f=await fixture(t,{fault:s=>{if(armed&&s===stage)throw native();}}),entry=backup(),{writer}=await f.create(allocation([entry]));
    armed=true;await assert.rejects(writer.createBackup({...entry,read:async sink=>{sink.write('abc');}}),stateError('STATE_IO'));
    assert.equal(writer.metadata.state.count,1);
  });
}
test('backup growth after stat is capped during verified handle read and close errors propagate',async t=>{
  let grow=false,close=false,blob;const f=await fixture(t,{fault:async s=>{
    if(grow&&s==='backup_read_before'){grow=false;await fs.appendFile(blob,'x');}
    if(close&&s==='backup_read_close_before')throw native('EPERM','close');
  }});
  const entry=backup(),{claim,writer}=await f.create(allocation([entry]));blob=f.file('operations',claim.operationId,'backups','0.blob');
  await writer.createBackup({...entry,read:async sink=>{sink.write('abc');}});
  const {fileIndex,...expectation}=entry;grow=true;
  await assert.rejects(writer.openVerifiedBackup(0,expectation),stateError('STATE_CORRUPT','backup_size'));
  await fs.writeFile(blob,'abc');const handle=await writer.openVerifiedBackup(0,expectation);close=true;
  await assert.rejects(handle.close(),stateError('STATE_IO','backup_read_close'));
});
test('late cancelled reader and delayed close retain endpoint ownership; later stages do not acknowledge',async t=>{
  const readEntered=delay(),readRelease=delay(),closeEntered=delay(),closeRelease=delay(),controller=new AbortController();
  let armed=false;const f=await fixture(t,{signal:controller.signal,fault:async stage=>{
    if(armed&&stage==='backup_close_before'){closeEntered.resolve();await closeRelease.promise;}
  }}),entry=backup(),{writer}=await f.create(allocation([entry]));armed=true;
  const result=f.store.withEndpointLock(digest('backup-endpoint'),()=>writer.createBackup({...entry,read:async sink=>{sink.write('a');readEntered.resolve();await readRelease.promise;sink.write('bc');}}));
  const observed=result.catch(error=>error);await readEntered.promise;controller.abort();await tick();
  assert.equal((await fs.readdir(f.file('locks'))).length,1);readRelease.resolve();await closeEntered.promise;
  assert.equal((await fs.readdir(f.file('locks'))).length,1);closeRelease.resolve();assert.equal((await observed).code,'STATE_BUSY');
  assert.deepEqual(await fs.readdir(f.file('locks')),[]);
});
test('owned backup handle serializes reads and close waits for actual dispatched read',async t=>{
  const entered=delay(),release=delay();let armed=false;
  const f=await fixture(t,{fault:async s=>{if(armed&&s==='backup_handle_read_before'){entered.resolve();await release.promise;}}}),entry=backup(),{writer}=await f.create(allocation([entry]));
  await writer.createBackup({...entry,read:async sink=>{sink.write('abc');}});
  const {fileIndex,...expectation}=entry,handle=await writer.openVerifiedBackup(0,expectation);armed=true;
  const read=handle.read(Buffer.alloc(3),0,3,0);await entered.promise;
  await assert.rejects(handle.read(Buffer.alloc(3),0,3,0),stateError('STATE_BUSY','backup_read_occupied'));
  let closed=false;const close=handle.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
  release.resolve();assert.equal((await read).bytesRead,3);await close;assert.equal(closed,true);
});
