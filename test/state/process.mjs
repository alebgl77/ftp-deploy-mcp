import { openStateStore } from '../../src/state/store.mjs';
import { claimInput, policy } from './helpers.mjs';

process.once('message', async input => {
  let armed = input.mode === 'bootstrap';
  const fault = async stage => {
    if (!armed || stage !== input.stage) return;
    if (input.crash) process.exit(86);
    process.send({ type: 'held' }); await new Promise(resolve => process.once('message', resolve));
  };
  let store;
  try {
    store = await openStateStore({ ...input.config, fault }); armed = true;
    let result;
    if (input.mode === 'claim') result = await store.claim(claimInput(input.planId, input.reservation, input.extra));
    if (input.mode === 'endpoint') result = await store.withEndpointLock(input.endpoint, async () => {
      process.send({ type: 'held' }); await new Promise(resolve => process.once('message', resolve)); return true;
    });
    if (input.mode === 'append') { const writer = await store.openJournal(input.operationId, policy); result = await writer.append({ type: 'STEP' }, { budget: 'apply' }); }
    if (input.mode === 'backup') { const writer = await store.openJournal(input.operationId, policy); result = await writer.createBackup({ ...input.backup, read: async sink => { sink.write(Buffer.from(input.data)); } }); }
    process.send({ type: 'result', ok: true, result });
  } catch (error) { process.send({ type: 'result', ok: false, code: error.code, stage: error.stage }); }
  finally { if (store) await store.close().catch(() => {}); process.disconnect(); }
});
