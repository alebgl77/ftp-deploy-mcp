import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createRedactor } from "../src/redact.js";
import { createOperation } from "../src/operations.js";
import { withZeroCancellation } from "../src/zero-cancellation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("expected cancellation state was not reached"); await tick(); }
}
const call = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ftp_read", arguments: {} } });
const cancel = (id) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "untrusted reason" } });
const success = () => ({ content: [{ type: "text", text: "complete" }] });

async function realFixture(t, handler, timeout = 2000, { scopeTap } = {}) {
  const server = new McpServer({ name: "falsy-id-server", version: "1.0.0" });
  const [peer, base] = InMemoryTransport.createLinkedPair();
  const transport = withZeroCancellation(base);
  const realScope = transport.scope;
  if (scopeTap) transport.scope = (extra) => { const scoped = realScope(extra); scopeTap(extra, scoped); return scoped; };
  const registry = createToolRegistry({ redactor: createRedactor(), transportContext: transport, timeoutFor: () => timeout });
  registry.registerTool("ftp_read", { inputSchema: {}, annotations: {} }, handler);
  registry.install(server);
  const messages = [];
  let closes = 0;
  peer.onmessage = (message) => messages.push(message);
  peer.onclose = () => { closes++; };
  await server.connect(transport);
  await peer.start();
  t.after(() => server.close());
  await peer.send({ jsonrpc: "2.0", id: 97, method: "initialize", params: {
    protocolVersion: "2025-11-25", clientInfo: { name: "raw-peer", version: "1.0.0" }, capabilities: {},
  } });
  await until(() => messages.some((message) => message.id === 97));
  await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const response = (id) => messages.find((message) => message.id === id && !message.method);
  return { peer, transport, messages, response, closes: () => closes };
}

for (const id of [0, "", 1, "0", "native"]) {
  test(`real SDK cancels exact ID ${JSON.stringify(id)} without a result`, async (t) => {
    let operation;
    const gate = deferred();
    const fixture = await realFixture(t, async (_args, current) => {
      operation = current;
      current.signal.addEventListener("abort", gate.resolve, { once: true });
      await gate.promise;
      current.check();
      return success();
    }, 2000, { scopeTap(original, scoped) {
      if (id !== 0 && id !== "") assert.equal(scoped, original, "native extra must remain unchanged");
    } });
    await fixture.peer.send(call(id));
    await until(() => operation);
    await fixture.peer.send(cancel(id));
    await until(() => operation.signal.aborted);
    await operation.settlement; await tick();
    assert.equal(fixture.response(id), undefined);
    assert.equal(operation.signal.reason.code, "CANCELLED");
  });
}

test("numeric zero and empty string have separate simultaneous slots", async (t) => {
  const operations = [];
  const gates = [deferred(), deferred()];
  const fixture = await realFixture(t, async (_args, operation) => {
    const index = operations.push(operation) - 1;
    await gates[index].promise;
    operation.check(); return success();
  });
  await fixture.peer.send(call(0));
  await fixture.peer.send(call(""));
  await until(() => operations.length === 2);
  await fixture.peer.send(cancel(0));
  assert.equal(operations[0].signal.aborted, true);
  assert.equal(operations[1].signal.aborted, false);
  await fixture.peer.send(cancel(""));
  assert.equal(operations[1].signal.aborted, true);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(operations.map((operation) => operation.settlement)); await tick();
  assert.equal(fixture.response(0), undefined);
  assert.equal(fixture.response(""), undefined);
  assert.equal(fixture.closes(), 0);
});

for (const id of [0, ""]) {
  test(`pre-handler cancellation of ${JSON.stringify(id)} runs no worker or progress`, async (t) => {
    let workers = 0;
    const fixture = await realFixture(t, async () => { workers++; return success(); });
    const sending = fixture.peer.send(call(id));
    const cancelling = fixture.peer.send(cancel(id));
    await Promise.all([sending, cancelling]); await tick();
    assert.equal(workers, 0);
    assert.equal(fixture.response(id), undefined);
    assert.equal(fixture.messages.filter((message) => message.method === "notifications/progress").length, 0);
    await fixture.peer.send(call(id));
    await until(() => fixture.response(id));
    assert.equal(workers, 1, "completed cancelled slot is reusable without a tombstone");
  });

  test(`unknown and malformed cancellation do not reserve or abort ${JSON.stringify(id)}`, async (t) => {
    let operation;
    const gate = deferred();
    const fixture = await realFixture(t, async (_args, current) => { operation = current; await gate.promise; return success(); });
    await fixture.peer.send(cancel(id));
    await fixture.peer.send(call(id));
    await until(() => operation);
    assert.equal(operation.signal.aborted, false);
    await fixture.peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: {} } });
    await fixture.peer.send(cancel(id === 0 ? "0" : "different"));
    assert.equal(operation.signal.aborted, false);
    gate.resolve(); await until(() => fixture.response(id));
    assert.equal(fixture.response(id).result.isError, undefined);
  });

  test(`internal TIMEOUT for ${JSON.stringify(id)} is delivered and slot/lock retain late worker`, async (t) => {
    const gate = deferred();
    const operations = [];
    let entered = 0;
    const fixture = await realFixture(t, async (_args, operation) => {
      operations.push(operation);
      return operation.lock([`zero-test:${JSON.stringify(id)}`], async () => {
        entered++; operation.dispatch();
        if (entered === 1) await gate.promise;
        operation.confirm(); return success();
      });
    }, 100);
    await fixture.peer.send(call(id));
    await until(() => entered === 1);
    await until(() => fixture.response(id));
    assert.equal(fixture.response(id).result.structuredContent.error.code, "TIMEOUT");
    assert.equal(fixture.response(id).result.structuredContent.error.effects, "possible");
    await fixture.peer.send(call(42));
    await until(() => operations.length === 2);
    assert.equal(entered, 1);
    gate.resolve(); await Promise.all(operations.map((operation) => operation.settlement));
    await until(() => fixture.response(42));
    assert.equal(entered, 2);
    assert.equal(fixture.response(42).result.isError, undefined);
  });

  test(`cancelled ${JSON.stringify(id)} keeps its slot until true settlement; duplicate method closes`, async (t) => {
    const gate = deferred();
    let operation, workers = 0;
    const fixture = await realFixture(t, async (_args, current) => {
      workers++; operation = current; current.dispatch(); await gate.promise; current.confirm(); return success();
    });
    await fixture.peer.send(call(id));
    await until(() => operation);
    await fixture.peer.send(cancel(id)); await tick();
    assert.equal(fixture.response(id), undefined);
    await fixture.peer.send({ jsonrpc: "2.0", id, method: "ping" });
    await until(() => fixture.closes() === 1);
    assert.equal(workers, 1);
    let settled = false;
    operation.settlement.then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    gate.resolve(); await operation.settlement; await tick();
    assert.equal(fixture.response(id), undefined);
    assert.equal(fixture.closes(), 1);
  });

  test(`close aborts ${JSON.stringify(id)} without evicting pending settlement`, async (t) => {
    const gate = deferred(); let operation;
    const fixture = await realFixture(t, async (_args, current) => { operation = current; await gate.promise; current.check(); return success(); });
    await fixture.peer.send(call(id)); await until(() => operation);
    await fixture.transport.close();
    assert.equal(operation.signal.aborted, true);
    let settled = false; operation.settlement.then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    gate.resolve(); await operation.settlement;
    await fixture.transport.close(); assert.equal(fixture.closes(), 1);
  });
}

test("public transport preserves send backpressure/options, server requests and optional interfaces", async () => {
  const pending = deferred(); const sent = []; let starts = 0, closes = 0, protocol;
  const base = { sessionId: "session", start() { starts++; },
    send(message, options) { sent.push({ message, options }); return pending.promise; },
    close() { closes++; this.onclose?.(); }, setProtocolVersion(value) { protocol = value; } };
  const wrapper = withZeroCancellation(base); let closeEvents = 0; const incoming = [];
  wrapper.onclose = () => { closeEvents++; }; wrapper.onmessage = (...args) => incoming.push(args);
  await wrapper.start(); assert.equal(starts, 1);
  assert.equal(wrapper.sessionId, "session"); wrapper.setProtocolVersion("version"); assert.equal(protocol, "version");
  base.onmessage(call(0), { authInfo: { clientId: "fixture" } });
  base.onmessage(cancel(0));
  const request = { jsonrpc: "2.0", id: 0, method: "ping" };
  const options = { relatedRequestId: "related" };
  let completed = false;
  const sending = wrapper.send(request, options).then(() => { completed = true; });
  await tick(); assert.equal(completed, false);
  assert.equal(sent[0].message, request); assert.equal(sent[0].options, options);
  const response = { jsonrpc: "2.0", id: 0, result: {} };
  base.onmessage(response); assert.equal(incoming.at(-1)[0], response, "inbound responses are not intercepted");
  assert.deepEqual(incoming[0][1], { authInfo: { clientId: "fixture" } });
  await wrapper.send({ jsonrpc: "2.0", id: 0, error: { code: -1, message: "cancelled" } });
  assert.equal(sent.length, 1, "only the peer-cancelled result/error is suppressed");
  pending.resolve(); await sending;
  await wrapper.close(); await wrapper.close();
  assert.equal(closes, 1); assert.equal(closeEvents, 1);
});

test("send failure releases a settled slot and propagates the exact error", async () => {
  const failure = new Error("send failure");
  let calls = 0, closes = 0;
  const base = { start() {}, send() { calls++; return Promise.reject(failure); }, close() { closes++; this.onclose?.(); } };
  const wrapper = withZeroCancellation(base); wrapper.onmessage = () => {};
  await wrapper.start();
  for (const id of [0, ""]) {
    base.onmessage(call(id));
    await assert.rejects(wrapper.send({ jsonrpc: "2.0", id, result: {} }), (error) => error === failure);
    base.onmessage(call(id));
    base.onmessage(cancel(id));
    await wrapper.send({ jsonrpc: "2.0", id, result: {} });
  }
  assert.equal(calls, 2); assert.equal(closes, 0); await wrapper.close();
});

test("scoped notification/request wrappers preserve options and gate the combined signal", async () => {
  const base = { start() {}, send() {}, close() {} };
  const wrapper = withZeroCancellation(base); wrapper.onmessage = () => {}; await wrapper.start();
  base.onmessage(call(""));
  const native = new AbortController(), caller = new AbortController();
  const sent = [];
  const extra = { requestId: "", signal: native.signal, _meta: { progressToken: 3 }, authInfo: { clientId: "fixture" },
    sendNotification(...args) { sent.push(args); return Promise.resolve("notice"); },
    sendRequest(...args) { sent.push(args); return Promise.resolve("request"); } };
  const scoped = wrapper.scope(extra);
  const notification = { method: "notifications/progress", params: { progressToken: 3, progress: 1 } };
  const options = { timeout: 50, signal: caller.signal };
  assert.equal(await scoped.sendNotification(notification, options), "notice");
  assert.equal(sent[0][0], notification); assert.equal(sent[0][1], options);
  const schema = {};
  assert.equal(await scoped.sendRequest({ method: "ping" }, schema, options), "request");
  assert.equal(sent[1][1], schema); assert.equal(sent[1][2].timeout, 50);
  caller.abort(); assert.equal(sent[1][2].signal.aborted, true); assert.equal(scoped.signal.aborted, false);
  base.onmessage(cancel(""));
  assert.throws(() => scoped.sendNotification(notification));
  assert.throws(() => scoped.sendRequest({ method: "ping" }, schema));
  assert.equal(sent.length, 2);
  assert.equal(scoped._meta, extra._meta); assert.equal(scoped.authInfo, extra.authInfo);
  assert.equal(wrapper.scope({ requestId: "0" }).requestId, "0");
  await wrapper.close();
});

test("a send already in progress is not retracted and its settlement still releases the slot", async () => {
  const gate = deferred(); let sent = 0, closes = 0;
  const base = { start() {}, send() { sent++; return gate.promise; }, close() { closes++; } };
  const wrapper = withZeroCancellation(base); wrapper.onmessage = () => {}; await wrapper.start();
  base.onmessage(call(0));
  const sending = wrapper.send({ jsonrpc: "2.0", id: 0, result: {} });
  base.onmessage(cancel(0)); assert.equal(sent, 1);
  gate.resolve(); await sending;
  base.onmessage(call(0)); assert.equal(closes, 0);
  await wrapper.close();
});
