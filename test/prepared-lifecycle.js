import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOperation, DEFAULT_OPERATION_TIMEOUT_MS, observeOperationWorker } from "../src/operations.js";
import { createToolRegistry, ERROR_SCHEMA, MAX_RESULT_BYTES, utf8Size } from "../src/tool-registry.js";
import { createRedactor } from "../src/redact.js";
import { appError } from "../src/errors.js";
import { withZeroCancellation } from "../src/zero-cancellation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const success = () => ({ content: [{ type: "text", text: "complete" }] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  const deadline = performance.now() + 5000;
  while (!check()) { assert.ok(performance.now() < deadline, "expected lifecycle state was not reached"); await tick(); }
}
function registry(spec = {}, handler = success, options = {}) {
  const value = createToolRegistry({ redactor: createRedactor(), ...options });
  value.registerTool("ftp_read", { inputSchema: { max_bytes: z.number().optional() }, annotations: {}, ...spec }, handler);
  return value;
}
function error(result, code) {
  assert.equal(result.isError, true);
  assert.ok(ERROR_SCHEMA.safeParse(result.structuredContent).success);
  assert.equal(result.structuredContent.error.code, code);
  assert.ok(utf8Size(result) <= MAX_RESULT_BYTES);
}
// Node's documented MockTimers.tick advances timers and Date; setTime advances
// Date alone to exercise check() while the event loop cannot deliver a timer.
// https://nodejs.org/api/test.html#class-mocktimers
const clock = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });

test("prepared timeout and paired private callbacks are validated at construction/registration", () => {
  for (const preparedTimeoutMs of [0, -1, 1.5, null, "100", NaN, Infinity, 3600001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => registry({}, success, { preparedTimeoutMs }), TypeError);
  }
  for (const preparedTimeoutMs of [1, 3600000, undefined]) registry({}, success, { preparedTimeoutMs });
  for (const spec of [{ prepare() {} }, { disposePrepared() {} }, { prepare: undefined },
    { disposePrepared: undefined }, { prepare: null, disposePrepared() {} },
    { prepare() {}, disposePrepared: 1 }, { prepare: 1, disposePrepared() {} }]) {
    assert.throws(() => registry(spec), TypeError);
  }
});

test("private preparation leaves descriptors/results unchanged and bypasses the legacy alias resolver", async () => {
  let legacyCalls = 0, disposals = 0;
  const options = { timeoutFor(args) { legacyCalls++; assert.deepEqual(args, { max_bytes: 3 }); return 1000; } };
  const legacy = registry({}, success, options);
  const prepared = registry({ prepare: () => undefined, disposePrepared(value) { assert.equal(value, undefined); disposals++; } },
    (_args, _operation, value) => { assert.equal(value, undefined); return success(); }, options);
  assert.deepEqual(prepared.list(), legacy.list());
  assert.deepEqual(await prepared.call("ftp_read", {}), success());
  assert.equal(legacyCalls, 0); assert.equal(disposals, 1);
  assert.deepEqual(await legacy.call("ftp_read", { max_bytes: 3 }), success());
  assert.equal(legacyCalls, 1);
});

test("pre-aborted and invalid requests acquire no preparation resource", async () => {
  let effects = 0;
  const value = registry({ prepare() { effects++; }, disposePrepared() { effects++; } }, () => { effects++; return success(); });
  const controller = new AbortController(); controller.abort();
  error(await value.call("ftp_read", {}, { signal: controller.signal }), "CANCELLED");
  error(await value.call("ftp_read", { max_bytes: "invalid" }), "INVALID_ARGUMENT");
  assert.equal(effects, 0);
});

for (const outcome of ["CANCELLED", "TIMEOUT"]) {
  for (const phase of ["preparation", "resolved preparation", "handler", "disposal"]) {
    test(`${outcome} during ${phase} observes actual worker and disposes the captured context once`, async (t) => {
      clock(t);
      const controller = new AbortController(), prepareGate = deferred(), handlerGate = deferred(), disposeGate = deferred();
      const context = {}, extra = { signal: controller.signal };
      let operation, handlerCalls = 0, disposals = 0, actualSettled = false;
      const stop = () => outcome === "CANCELLED" ? controller.abort() : t.mock.timers.tick(100);
      observeOperationWorker(extra, (worker) => { void worker.then(() => { actualSettled = true; }, () => { actualSettled = true; }); });
      const value = registry({
        async prepare(_args, current) {
          operation = current;
          if (phase === "preparation") await prepareGate.promise;
          if (phase === "resolved preparation") stop();
          return context;
        },
        async disposePrepared(prepared, current) {
          assert.equal(prepared, context); assert.equal(current, operation);
          disposals++; await disposeGate.promise;
        },
      }, async (_args, current, prepared) => {
        assert.equal(prepared, context); assert.equal(current, operation);
        handlerCalls++;
        if (phase === "handler") await handlerGate.promise;
        return success();
      }, { preparedTimeoutMs: 100 });
      const pending = value.call("ftp_read", {}, extra);
      t.after(async () => { prepareGate.resolve(); handlerGate.resolve(); disposeGate.resolve(); await pending; await operation?.settlement; });
      if (phase === "preparation") await until(() => operation);
      if (phase === "handler") await until(() => handlerCalls === 1);
      if (phase === "disposal") await until(() => disposals === 1);
      if (phase !== "resolved preparation") stop();
      error(await pending, outcome);
      assert.equal(actualSettled, false);
      prepareGate.resolve(); handlerGate.resolve();
      await until(() => disposals === 1);
      assert.equal(handlerCalls, phase.includes("preparation") ? 0 : 1);
      assert.equal(actualSettled, false);
      disposeGate.resolve(); await operation.settlement; await tick();
      assert.equal(actualSettled, true); assert.equal(disposals, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(getEventListeners(operation.signal, "abort").length, 0);
    });
  }
}

for (const asynchronous of [false, true]) {
  test(`rejected preparation owns its unreturned resources and never calls handler/disposer (async=${asynchronous})`, async () => {
    const first = appError("NOT_FOUND", "error.notFound", { path: "fixture" });
    let open = 0, closed = 0, handlers = 0, disposals = 0;
    const reject = () => { open++; closed++; throw first; };
    const value = registry({ prepare: asynchronous ? async () => reject() : reject,
      disposePrepared() { disposals++; } }, () => { handlers++; return success(); });
    error(await value.call("ftp_read", {}), "NOT_FOUND");
    assert.equal(open, 1); assert.equal(closed, 1); assert.equal(handlers, 0); assert.equal(disposals, 0);
  });
}

for (const primary of [appError("NOT_FOUND", "error.notFound", { path: "fixture" }), undefined, null]) {
  test(`handler's first failure survives disposal failure (${primary?.code ?? String(primary)})`, async () => {
    let disposals = 0;
    const value = registry({ prepare: () => ({}), disposePrepared() { disposals++; throw appError("OUTPUT_LIMIT", "error.OUTPUT_LIMIT"); } },
      () => { throw primary; });
    error(await value.call("ftp_read", {}), primary?.code ?? "INTERNAL_ERROR");
    assert.equal(disposals, 1);
  });
}

test("disposal failure after success is a bounded normal tool error", async () => {
  const value = registry({ prepare: () => ({}), disposePrepared() { throw appError("OUTPUT_LIMIT", "error.OUTPUT_LIMIT"); } });
  error(await value.call("ftp_read", {}), "OUTPUT_LIMIT");
});

for (const phase of ["preparation", "handler", "disposal"]) {
  test(`late ${phase} rejection after outward abort is consumed`, async (t) => {
    const controller = new AbortController(), gate = deferred(), unhandled = [];
    let operation, entered = false, disposals = 0;
    const onUnhandled = (failure) => unhandled.push(failure);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.removeListener("unhandledRejection", onUnhandled));
    const value = registry({
      async prepare(_args, current) { operation = current; if (phase === "preparation") { entered = true; await gate.promise; } return {}; },
      async disposePrepared() { disposals++; if (phase === "disposal") { entered = true; await gate.promise; } },
    }, async () => { if (phase === "handler") { entered = true; await gate.promise; } return success(); });
    const pending = value.call("ftp_read", {}, { signal: controller.signal });
    await until(() => entered); controller.abort(); error(await pending, "CANCELLED");
    gate.reject(new Error("late private failure")); await operation.settlement; await tick();
    assert.deepEqual(unhandled, []); assert.equal(disposals, phase === "preparation" ? 0 : 1);
  });
}

for (const phase of ["preparation", "disposal"]) {
  for (const outcome of ["CANCELLED", "TIMEOUT"]) {
    test(`all 64 aborted ${phase}s retain admission until actual disposal settlement (${outcome})`, async (t) => {
      clock(t);
      const preparations = Array.from({ length: 64 }, deferred), disposers = Array.from({ length: 64 }, deferred);
      const controllers = Array.from({ length: 64 }, () => new AbortController()), operations = [];
      let disposing = 0;
      const value = registry({
        async prepare(_args, operation) {
          const index = operations.push(operation) - 1;
          if (phase === "preparation") await preparations[index].promise;
          return index;
        },
        async disposePrepared(index) { disposing++; await disposers[index].promise; },
      }, success, { preparedTimeoutMs: 100 });
      const pending = controllers.map((controller) => value.call("ftp_read", {}, { signal: controller.signal }));
      t.after(async () => {
        preparations.forEach((gate) => gate.resolve()); disposers.forEach((gate) => gate.resolve());
        await Promise.all(pending); await Promise.all(operations.map((operation) => operation.settlement));
      });
      await until(() => operations.length === 64 && (phase === "preparation" || disposing === 64));
      if (outcome === "CANCELLED") controllers.forEach((controller) => controller.abort());
      else t.mock.timers.tick(100);
      for (const result of await Promise.all(pending)) error(result, outcome);
      const probe = registry();
      error(await probe.call("ftp_read", {}), "CAPACITY_LIMIT");
      preparations.forEach((gate) => gate.resolve()); await until(() => disposing === 64);
      error(await probe.call("ftp_read", {}), "CAPACITY_LIMIT");
      disposers[0].resolve(); await operations[0].settlement; await tick();
      const nextGate = deferred(); let nextOperation;
      const next = registry({}, async (_args, operation) => { nextOperation = operation; await nextGate.promise; return success(); });
      const admitted = next.call("ftp_read", {});
      t.after(async () => { nextGate.resolve(); await admitted; await nextOperation?.settlement; });
      await until(() => nextOperation);
      error(await probe.call("ftp_read", {}), "CAPACITY_LIMIT");
      nextGate.resolve(); assert.deepEqual(await admitted, success());
    });
  }
}

test("shortening validates bounds, uses original start and never extends a deadline", async (t) => {
  clock(t);
  const gate = deferred(), operation = createOperation({}, 1000);
  const result = operation.run(() => gate.promise).catch((failure) => failure);
  for (const value of [0, -1, 1.5, null, "100", NaN, Infinity, 3600001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => operation.shortenTimeout(value), TypeError);
  }
  t.mock.timers.tick(400); operation.shortenTimeout(600);
  operation.shortenTimeout(3600000); t.mock.timers.tick(199);
  assert.equal(operation.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal((await result).code, "TIMEOUT");
  gate.resolve(); await operation.settlement;
});

test("shortening to an already elapsed original deadline aborts immediately", async (t) => {
  clock(t);
  const gate = deferred(), operation = createOperation({}, 1000);
  const result = operation.run(() => gate.promise).catch((failure) => failure);
  t.mock.timers.tick(400); operation.shortenTimeout(300);
  assert.equal(operation.signal.aborted, true); assert.equal((await result).code, "TIMEOUT");
  gate.resolve(); await operation.settlement;
});

test("timeout before preparation invocation starts no callback", async (t) => {
  clock(t);
  const operation = createOperation({}, 1); let calls = 0;
  t.mock.timers.setTime(100001);
  await assert.rejects(operation.run(() => operation.runPreparation(() => { calls++; })), { code: "TIMEOUT" });
  await operation.settlement; assert.equal(calls, 0);
});

for (const mainTimeout of [50, 20000]) {
  test(`preparation cap is the earlier of 10000ms and the main deadline (${mainTimeout}ms)`, async (t) => {
    clock(t);
    const gate = deferred(), operation = createOperation({}, mainTimeout); let settled = false;
    const result = operation.run(() => operation.runPreparation(() => gate.promise)).catch((failure) => failure);
    operation.settlement.then(() => { settled = true; });
    const cap = Math.min(mainTimeout, 10000);
    t.mock.timers.tick(cap - 1); assert.equal(operation.signal.aborted, false);
    t.mock.timers.tick(1); assert.equal((await result).code, "TIMEOUT");
    assert.equal(settled, false);
    gate.resolve(); await operation.settlement; assert.equal(settled, true);
  });
}

test("blocked-loop checks enforce the stage cap before and after callback settlement", async (t) => {
  clock(t);
  for (const explicitCheck of [false, true]) {
    const operation = createOperation({}, 20000), start = Date.now();
    await assert.rejects(operation.run(() => operation.runPreparation(() => {
      t.mock.timers.setTime(start + 10000);
      if (explicitCheck) operation.check();
    })), { code: "TIMEOUT" });
    assert.equal(operation.signal.aborted, true); await operation.settlement;
  }
});

test("preparation cap starts at stage entry, is removed on success, and retains shortened main deadline", async (t) => {
  clock(t);
  const operation = createOperation({}, 30000), before = deferred(), stage = deferred(), after = deferred();
  let inStage = false, prepared = false;
  const result = operation.run(async () => {
    await before.promise;
    await operation.runPreparation(async () => { inStage = true; await stage.promise; });
    prepared = true; await after.promise;
  }).catch((failure) => failure);
  t.mock.timers.tick(5000); before.resolve(); await until(() => inStage);
  t.mock.timers.tick(9999); operation.check(); stage.resolve(); await until(() => prepared);
  operation.shortenTimeout(20000);
  t.mock.timers.tick(5000); operation.check(); assert.equal(operation.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal((await result).code, "TIMEOUT");
  after.resolve(); await operation.settlement;
});

test("preparation cannot repeat or nest and a finished operation acquires no timer/listener", async (t) => {
  clock(t);
  const controller = new AbortController(), operation = createOperation({ signal: controller.signal }, 20000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  await operation.run(async () => {
    await operation.runPreparation(async () => {
      await assert.rejects(operation.runPreparation(() => assert.fail("nested callback")), /only run once/);
    });
    await assert.rejects(operation.runPreparation(() => assert.fail("repeated callback")), /only run once/);
  });
  const timeout = t.mock.method(globalThis, "setTimeout");
  operation.shortenTimeout(1); operation.shortenTimeout(3600000);
  await assert.rejects(operation.runPreparation(() => assert.fail("finished callback")), /only run once/);
  assert.equal(timeout.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(operation.signal, "abort").length, 0);
  t.mock.timers.tick(4000000); assert.equal(operation.signal.aborted, false);
  controller.abort(); assert.equal(operation.signal.aborted, false);
});

test("prepared default timeout is 120000ms and resolver is never consulted", async (t) => {
  clock(t);
  let operation, handled = false;
  const gate = deferred();
  const value = registry({ prepare(_args, current) { operation = current; return {}; }, disposePrepared() {} },
    async () => { handled = true; await gate.promise; return success(); }, { timeoutFor: () => assert.fail("legacy resolver") });
  const result = value.call("ftp_read", {}); await until(() => handled);
  t.mock.timers.tick(DEFAULT_OPERATION_TIMEOUT_MS - 1); operation.check();
  t.mock.timers.tick(1); error(await result, "TIMEOUT"); gate.resolve(); await operation.settlement;
});

const call = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ftp_read", arguments: {} } });
const cancel = (id) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
async function sdkFixture(t, spec, handler = success, options = {}) {
  const server = new McpServer({ name: "prepared-lifecycle", version: "1.0.0" });
  const [peer, base] = InMemoryTransport.createLinkedPair(), transport = withZeroCancellation(base);
  const originalScope = transport.scope;
  transport.scope = (extra) => {
    const scoped = originalScope(extra);
    if (extra.requestId === 1 || extra.requestId === "0") assert.equal(scoped, extra);
    return scoped;
  };
  const value = registry(spec, handler, { preparedTimeoutMs: 2000, transportContext: transport, ...options });
  value.install(server);
  const messages = []; let closes = 0;
  peer.onmessage = (message) => messages.push(message); peer.onclose = () => { closes++; };
  await server.connect(transport); await peer.start(); t.after(() => server.close());
  await peer.send({ jsonrpc: "2.0", id: 97, method: "initialize", params: {
    protocolVersion: "2025-11-25", clientInfo: { name: "raw-peer", version: "1.0.0" }, capabilities: {},
  } });
  await until(() => messages.some((message) => message.id === 97));
  await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { peer, transport, messages, closes: () => closes,
    response: (id) => messages.find((message) => message.id === id && !message.method) };
}

for (const id of [0, "", 1, "0"]) {
  test(`actual SDK cancellation reaches prepared worker for exact ID ${JSON.stringify(id)} and reuse waits for disposal`, async (t) => {
    const prepareGate = deferred(), disposeGate = deferred(); let operation, preparations = 0, disposals = 0, handlers = 0;
    const fixture = await sdkFixture(t, {
      async prepare(_args, current) { preparations++; operation = current; if (preparations === 1) await prepareGate.promise; return {}; },
      async disposePrepared() { disposals++; if (disposals === 1) await disposeGate.promise; },
    }, () => { handlers++; return success(); });
    t.after(async () => { prepareGate.resolve(); disposeGate.resolve(); await operation?.settlement; });
    await fixture.peer.send(call(id)); await until(() => operation);
    await fixture.peer.send(cancel(id)); await until(() => operation.signal.aborted);
    assert.equal(operation.signal.reason.code, "CANCELLED");
    prepareGate.resolve(); await until(() => disposals === 1);
    assert.equal(handlers, 0); assert.equal(fixture.response(id), undefined);
    disposeGate.resolve(); await operation.settlement; await tick();
    await fixture.peer.send(call(id)); await until(() => fixture.response(id));
    assert.equal(fixture.response(id).result.isError, undefined);
    assert.equal(preparations, 2); assert.equal(disposals, 2); assert.equal(handlers, 1); assert.equal(fixture.closes(), 0);
  });
}

for (const id of [0, ""]) {
  for (const phase of ["preparation", "disposal"]) {
    for (const outcome of ["CANCELLED", "TIMEOUT"]) {
      test(`SDK ${JSON.stringify(id)} retains ${phase} identity after ${outcome}; premature reuse closes transport`, async (t) => {
        const gate = deferred(); let operation, preparations = 0, entered = false, settled = false;
        const fixture = await sdkFixture(t, {
          async prepare(_args, current) {
            operation = current; preparations++;
            current.settlement.then(() => { settled = true; });
            if (phase === "preparation") { entered = true; await gate.promise; }
            return {};
          },
          async disposePrepared() { if (phase === "disposal") { entered = true; await gate.promise; } },
        }, success, { preparedTimeoutMs: outcome === "TIMEOUT" ? 30 : 2000 });
        t.after(async () => { gate.resolve(); await operation?.settlement; });
        await fixture.peer.send(call(id)); await until(() => entered);
        if (outcome === "CANCELLED") await fixture.peer.send(cancel(id));
        await until(() => operation.signal.aborted);
        if (outcome === "TIMEOUT") {
          await until(() => fixture.response(id)); error(fixture.response(id).result, "TIMEOUT");
        } else { await tick(); assert.equal(fixture.response(id), undefined); }
        assert.equal(settled, false);
        await fixture.peer.send(call(id)); await until(() => fixture.closes() === 1);
        assert.equal(preparations, 1); assert.equal(settled, false);
        gate.resolve(); await operation.settlement; assert.equal(settled, true);
      });
    }
  }
}
