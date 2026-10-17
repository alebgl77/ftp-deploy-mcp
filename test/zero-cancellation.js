import assert from "node:assert/strict";
import test from "node:test";
import { createRequestStateCodec, InMemoryTransport, inputRequired, McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { bindRequestLifecycle, createRequestLifecycleTransport, createToolRegistry } from "../src/tool-registry.js";
import { createRedactor } from "../src/redact.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("expected cancellation state was not reached");
    await tick();
  }
}
const call = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ftp_read", arguments: {} } });
const cancel = (id) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "stop" } });
const success = () => ({ content: [{ type: "text", text: "complete" }] });
function tamperToken(token) {
  if (typeof token !== "string" || token.length < 4) throw new TypeError("requestState token is too short");
  const index = Math.min(token.length - 2, Math.max(1, Math.floor(token.length / 2)));
  return `${token.slice(0, index)}${token[index] === "A" ? "B" : "A"}${token.slice(index + 1)}`;
}

async function fixture(t, handler, timeout = 2000) {
  const server = new McpServer({ name: "falsy-id-server", version: "1.0.0" });
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const requestLifecycle = createRequestLifecycleTransport(transport);
  bindRequestLifecycle(server, requestLifecycle);
  const registry = createToolRegistry({ redactor: createRedactor(), timeoutFor: () => timeout });
  registry.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {} }, handler);
  registry.install(server);
  const messages = [];
  peer.onmessage = (message) => messages.push(message);
  await server.connect(requestLifecycle);
  await peer.start();
  t.after(() => server.close());
  await peer.send({ jsonrpc: "2.0", id: 97, method: "initialize", params: {
    protocolVersion: "2025-11-25", clientInfo: { name: "raw-peer", version: "1.0.0" }, capabilities: {},
  } });
  await until(() => messages.some((message) => message.id === 97));
  await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { peer, server, messages,
    response: (id) => messages.find((message) => message.id === id && !message.method) };
}

for (const id of [0, "", 1, "0"]) {
  test(`SDK v2 cancels exact request ID ${JSON.stringify(id)} without a response`, async (t) => {
    const workerGate = deferred();
    let operation;
    const current = await fixture(t, async (_args, active) => {
      operation = active;
      await workerGate.promise;
      active.check();
      return success();
    });
    await current.peer.send(call(id));
    await until(() => operation);
    await current.peer.send(cancel(id));
    await until(() => operation.signal.aborted);
    assert.equal(operation.signal.reason.code, "CANCELLED");
    assert.equal(current.response(id), undefined);
    let settled = false;
    operation.settlement.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, "outward cancellation must not fake worker settlement");
    workerGate.resolve();
    await operation.settlement;
    await tick();
    assert.equal(current.response(id), undefined);
  });
}

test("numeric zero and empty string remain distinct simultaneous request IDs", async (t) => {
  const operations = [];
  const gates = [deferred(), deferred()];
  const current = await fixture(t, async (_args, operation) => {
    const index = operations.push(operation) - 1;
    await gates[index].promise;
    operation.check();
    return success();
  });
  await current.peer.send(call(0));
  await current.peer.send(call(""));
  await until(() => operations.length === 2);
  await current.peer.send(cancel(0));
  await until(() => operations[0].signal.aborted);
  assert.equal(operations[1].signal.aborted, false);
  await current.peer.send(cancel(""));
  await until(() => operations[1].signal.aborted);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(operations.map((operation) => operation.settlement));
  assert.equal(current.response(0), undefined);
  assert.equal(current.response(""), undefined);
});

for (const id of [0, ""]) {
  test(`unknown and malformed cancellation do not abort request ID ${JSON.stringify(id)}`, async (t) => {
    const gate = deferred();
    let operation;
    const current = await fixture(t, async (_args, active) => {
      operation = active;
      await gate.promise;
      return success();
    });
    await current.peer.send(cancel(id));
    await current.peer.send(call(id));
    await until(() => operation);
    assert.equal(operation.signal.aborted, false);
    await current.peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: {} } });
    await current.peer.send(cancel(id === 0 ? "0" : "different"));
    assert.equal(operation.signal.aborted, false);
    gate.resolve();
    await until(() => current.response(id));
    assert.equal(current.response(id).result.isError, undefined);
  });

  test(`internal timeout for request ID ${JSON.stringify(id)} still returns a bounded tool error`, async (t) => {
    const gate = deferred();
    let operation;
    const current = await fixture(t, async (_args, active) => {
      operation = active;
      active.dispatch();
      await gate.promise;
      active.check();
      return success();
    }, 50);
    await current.peer.send(call(id));
    await until(() => operation);
    await until(() => current.response(id));
    assert.equal(current.response(id).result.structuredContent.error.code, "TIMEOUT");
    assert.equal(current.response(id).result.structuredContent.error.effects, "possible");
    gate.resolve();
    await operation.settlement;
  });
}

test("closing the SDK server aborts a falsey-ID worker and preserves true settlement", async (t) => {
  const gate = deferred();
  let operation;
  const current = await fixture(t, async (_args, active) => {
    operation = active;
    await gate.promise;
    active.check();
    return success();
  });
  await current.peer.send(call(0));
  await until(() => operation);
  await current.server.close();
  assert.equal(operation.signal.aborted, true);
  let settled = false;
  operation.settlement.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  gate.resolve();
  await operation.settlement;
});

class ControlledTransport {
  onclose;
  onerror;
  onmessage;
  closed = false;
  closes = 0;
  sent = [];
  responseBlocks = new Map();
  responseFailures = new Set();

  async start() {}
  blockResponse(id) {
    const gate = { ...deferred(), started: false };
    this.responseBlocks.set(id, gate);
    return gate;
  }
  failNextResponse(id) {
    this.responseFailures.add(id);
  }
  async send(message) {
    this.sent.push(message);
    if (!message.method && this.responseFailures.delete(message.id)) throw new Error("controlled response failure");
    const gate = !message.method && this.responseBlocks.get(message.id);
    if (!gate) return;
    gate.started = true;
    return gate.promise;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closes++;
    for (const gate of this.responseBlocks.values()) gate.reject(new Error("controlled transport closed"));
    this.onclose?.();
  }
  receive(message) {
    if (this.closed) return false;
    this.onmessage?.(message);
    return true;
  }
}

async function wireFixture(t, spec, handler, { timeout = 2000, capabilities = {} } = {}) {
  const wire = new ControlledTransport();
  const requestLifecycle = createRequestLifecycleTransport(wire);
  const errors = [];
  let pingCalls = 0;
  const handle = serveStdio(() => {
    const server = new McpServer({ name: "wire-lifecycle", version: "1.0.0" });
    bindRequestLifecycle(server, requestLifecycle);
    const registry = createToolRegistry({ redactor: createRedactor(), timeoutFor: () => timeout });
    registry.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {}, ...spec }, handler);
    registry.install(server);
    server.server.setRequestHandler("ping", () => { pingCalls++; return {}; });
    return server;
  }, { transport: requestLifecycle, onerror: (error) => errors.push(error) });
  t.after(() => handle.close());
  wire.receive({ jsonrpc: "2.0", id: 97, method: "initialize", params: {
    protocolVersion: "2025-11-25", clientInfo: { name: "wire-peer", version: "1.0.0" }, capabilities,
  } });
  await until(() => wire.sent.some((message) => message.id === 97));
  wire.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { wire, errors, pingCalls: () => pingCalls,
    responses: (id) => wire.sent.filter((message) => message.id === id && !message.method) };
}

test("blocked terminal response keeps the wire ID reserved and duplicate tools/call never runs", async (t) => {
  let calls = 0, operation;
  const current = await wireFixture(t, {}, async (_args, active) => {
    calls++;
    operation = active;
    return success();
  });
  const blocked = current.wire.blockResponse(0);
  current.wire.receive(call(0));
  await until(() => operation && blocked.started);
  await operation.settlement;
  current.wire.receive(call(0));
  await until(() => current.wire.closes === 1);
  assert.equal(calls, 1);
  assert.equal(current.responses(0).length, 1);
});

test("legacy input-required rounds retain every worker settlement before releasing the wire ID", async (t) => {
  const workerGate = deferred();
  let rounds = 0, secondOperation;
  const current = await wireFixture(t, { inputRequired: true }, async (_args, operation) => {
    rounds++;
    if (rounds === 1) {
      return inputRequired({ inputRequests: {
        confirmation: inputRequired.elicit({ message: "Confirm", requestedSchema: z.object({ approved: z.boolean() }) }),
      } });
    }
    secondOperation = operation;
    operation.dispatch();
    await workerGate.promise;
    operation.check();
    return success();
  }, { timeout: 50, capabilities: { elicitation: { form: {} } } });
  t.after(() => workerGate.resolve());

  current.wire.receive(call("legacy-multi-turn"));
  await until(() => current.wire.sent.some((message) => message.method === "elicitation/create"));
  const elicitation = current.wire.sent.find((message) => message.method === "elicitation/create");
  current.wire.receive({ jsonrpc: "2.0", id: elicitation.id,
    result: { action: "accept", content: { approved: true } } });
  await until(() => secondOperation);
  await until(() => current.responses("legacy-multi-turn").length === 1);
  assert.equal(current.responses("legacy-multi-turn")[0].result.structuredContent.error.code, "TIMEOUT");

  current.wire.receive(call("legacy-multi-turn"));
  await until(() => current.wire.closes === 1);
  assert.equal(rounds, 2, "the duplicate must close the channel before a third handler turn");
  workerGate.resolve();
  await secondOperation.settlement;
});

test("active tools/call followed by ping with the same ID closes before ping and preserves cleanup identity", async (t) => {
  const workerGate = deferred(), disposeGate = deferred();
  let operation, handlers = 0, disposals = 0;
  const current = await wireFixture(t, {
    prepare: () => ({}),
    async disposePrepared() { disposals++; await disposeGate.promise; },
  }, async (_args, active) => {
    operation = active;
    handlers++;
    await workerGate.promise;
    active.check();
    return success();
  });
  t.after(() => { workerGate.resolve(); disposeGate.resolve(); });
  current.wire.receive(call(""));
  await until(() => operation);
  current.wire.receive({ jsonrpc: "2.0", id: "", method: "ping" });
  await until(() => current.wire.closes === 1 && operation.signal.aborted);
  assert.equal(current.pingCalls(), 0);
  assert.equal(handlers, 1);
  assert.equal(current.wire.receive(cancel("")), false);
  workerGate.resolve();
  await until(() => disposals === 1);
  let settled = false;
  operation.settlement.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  disposeGate.resolve();
  await operation.settlement;
  assert.equal(disposals, 1);
});

test("a completed response and worker release an ID for later sequential reuse", async (t) => {
  let calls = 0;
  const current = await wireFixture(t, {}, () => { calls++; return success(); });
  current.wire.receive(call(1));
  await until(() => current.responses(1).length === 1);
  current.wire.receive(call(1));
  await until(() => current.responses(1).length === 2);
  assert.equal(calls, 2);
  assert.equal(current.wire.closes, 0);
});

test("a failed terminal response send and settled worker release the ID", async (t) => {
  let calls = 0;
  const current = await wireFixture(t, {}, () => { calls++; return success(); });
  current.wire.failNextResponse("response-failure");
  current.wire.receive(call("response-failure"));
  await until(() => current.responses("response-failure").length === 1);
  await tick();
  current.wire.receive(call("response-failure"));
  await until(() => current.responses("response-failure").length === 2);
  assert.equal(calls, 2);
  assert.equal(current.wire.closes, 0);
});

test("input_required is opt-in, bypasses result shaping byte-exactly, and is rejected for ordinary tools", async () => {
  const state = `signed.${"x".repeat(30000)}.state`;
  const required = inputRequired({ requestState: state });
  const opted = createToolRegistry({ redactor: createRedactor() });
  opted.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {}, inputRequired: true }, () => required);
  const passed = await opted.call("ftp_read", {});
  assert.equal(passed, required);
  assert.equal(passed.requestState, state);

  const ordinary = createToolRegistry({ redactor: createRedactor() });
  ordinary.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {} }, () => required);
  const rejected = await ordinary.call("ftp_read", {});
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "INTERNAL_ERROR");
  assert.throws(() => ordinary.registerTool("bad", {
    inputSchema: z.object({}), annotations: {}, inputRequired: false,
  }, success), TypeError);
});

test("input-required runtime context cannot be spoofed through direct registry.call extras", async () => {
  let observed;
  const registry = createToolRegistry({ redactor: createRedactor() });
  registry.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {}, inputRequired: true }, (_args, operation) => {
    observed = operation;
    return success();
  });
  await registry.call("ftp_read", {}, {
    inputResponses: { confirmation: { action: "accept", content: { approved: true } } },
    requestState: { approved: true },
    mintRequestState: () => "unsigned",
  });
  assert.equal(observed.inputResponses, undefined);
  assert.equal(observed.requestState, undefined);
  assert.equal(observed.mintRequestState, undefined);
});

test("official request-state codec rejects tamper, expiry, cross-session and cross-method replay", async () => {
  const key = Buffer.alloc(32, 23);
  const bind = (ctx) => `${ctx.mcpReq.method}\0${ctx.sessionId}`;
  const codec = createRequestStateCodec({ key, bind });
  const origin = { sessionId: "session-a", mcpReq: { method: "tools/call" } };
  const token = await codec.mint({ flow: "deploy", round: 1 }, origin);
  assert.deepEqual(await codec.verify(token, origin), { flow: "deploy", round: 1 });
  const changed = tamperToken(token);
  await assert.rejects(codec.verify(changed, origin), /mac|malformed/);
  await assert.rejects(codec.verify(token, { ...origin, sessionId: "session-b" }), /bind/);
  await assert.rejects(codec.verify(token, { ...origin, mcpReq: { method: "resources/read" } }), /bind/);
  const expired = createRequestStateCodec({ key, ttlSeconds: -1, bind });
  await assert.rejects(expired.verify(await expired.mint({ flow: "deploy" }, origin), origin), /expired/);
});

test("modern v2 round trip injects only SDK-lifted input and verified decoded requestState", async (t) => {
  const confirmation = z.object({ approved: z.boolean() });
  const codec = createRequestStateCodec({ key: Buffer.alloc(32, 29),
    bind: (ctx) => `${ctx.mcpReq.method}\0modern-session` });
  const server = new McpServer({ name: "input-required-server", version: "1.0.0" }, {
    requestState: { verify: codec.verify },
  });
  const registry = createToolRegistry({ redactor: createRedactor(),
    mintRequestState: (payload, ctx) => codec.mint(payload, ctx) });
  let rounds = 0, firstResponses, decodedState, responseKind, accepted, mintType, mintedToken;
  registry.registerTool("ftp_read", { inputSchema: z.object({}), annotations: {}, inputRequired: true }, async (_args, operation) => {
    rounds++;
    if (operation.requestState === undefined) {
      firstResponses = operation.inputResponses;
      mintType = typeof operation.mintRequestState;
      const requestState = mintedToken = await operation.mintRequestState({ flow: "deploy", round: 1 });
      return inputRequired({ inputRequests: {
        confirmation: inputRequired.elicit({ message: "Confirm", requestedSchema: confirmation }),
      }, requestState });
    }
    decodedState = operation.requestState;
    responseKind = operation.inputResponse("confirmation").kind;
    accepted = operation.acceptedInputResponse("confirmation", confirmation);
    return success();
  });
  registry.install(server);
  const client = new Client({ name: "input-required-client", version: "1.0.0" }, {
    capabilities: { elicitation: { form: {} } },
    versionNegotiation: { mode: { pin: "2026-07-28" } },
    inputRequired: { autoFulfill: true },
  });
  client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { approved: true } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => server, { transport: serverTransport });
  await client.connect(clientTransport);
  t.after(async () => { await client.close().catch(() => {}); await handle.close().catch(() => {}); });
  const result = await client.callTool({ name: "ftp_read", arguments: {} });
  assert.equal(result.content[0].text, "complete");
  assert.equal(rounds, 2);
  assert.equal(mintType, "function");
  assert.ok(firstResponses === undefined || Object.keys(firstResponses).length === 0);
  assert.deepEqual(decodedState, { flow: "deploy", round: 1 });
  assert.equal(responseKind, "elicit");
  assert.deepEqual(accepted, { approved: true });
  const tampered = tamperToken(mintedToken);
  await assert.rejects(client.callTool({ name: "ftp_read", arguments: {}, requestState: tampered,
    inputResponses: { confirmation: { action: "accept", content: { approved: true } } } }),
  (error) => error?.code === -32602 && error.message === "Invalid or expired requestState");
  assert.equal(rounds, 2, "tampered state is rejected before the opted-in handler runs");
});
