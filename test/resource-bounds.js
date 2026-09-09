import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, normalizeServer } from "../src/config.js";
import { registerTools } from "../src/tools.js";
import { selectDeployFiles } from "../src/scanner.js";
import { createToolRegistry, ERROR_SCHEMA, MAX_RESULT_BYTES, utf8Size } from "../src/tool-registry.js";
import { createRedactor } from "../src/redact.js";
import { createI18n } from "../src/i18n.js";
import { withZeroCancellation } from "../src/zero-cancellation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const success = () => ({ content: [{ type: "text", text: "complete" }] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, "expected state was not reached"); await tick(); }
}
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ftp-resource-bounds-")));
  t.after(() => {
    assert.ok(path.basename(root).startsWith("ftp-resource-bounds-"));
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function configured(root, extra = {}) {
  return { protocol: "sftp", host: "scan.invalid", user: "fixture", password: "bounded-secret",
    hostKeySha256: `SHA256:${Buffer.alloc(32, 23).toString("base64").replace(/=+$/, "")}`,
    localRoot: root, root: "/", ...extra };
}
function deployment(root, extra = {}, options = {}) {
  let connections = 0, mutations = 0;
  const loaded = { found: true, error: null, serverNames: ["test"], defaultServer: "test", serverErrors: {},
    config: { servers: { test: configured(root, extra) } } };
  const registry = registerTools(null, loaded, { ...options, openAdapter: async () => {
    connections++; mutations++; throw new Error("a rejected scan must never connect");
  } });
  return { registry, calls: () => ({ connections, mutations }),
    call: (args = {}, context = {}) => registry.call("ftp_deploy", { local_dir: ".", dry_run: true, ...args }, context) };
}
function error(result, code, next = "fix_input") {
  assert.equal(result.isError, true);
  assert.ok(ERROR_SCHEMA.safeParse(result.structuredContent).success);
  assert.equal(result.structuredContent.error.code, code);
  assert.equal(result.structuredContent.error.effects, "none");
  assert.equal(result.structuredContent.error.retryable, false);
  assert.equal(result.structuredContent.error.next_action, next);
  assert.ok(utf8Size(result) <= MAX_RESULT_BYTES);
  return result.structuredContent.error;
}
const file = (name) => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
const dir = (name) => ({ name, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false });
const link = (name) => ({ name, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true });
function virtualTree(t, root, tree, hooks = {}) {
  const events = [], stats = [];
  let live = 0, maximum = 0, reads = 0;
  t.mock.method(fs.promises, "opendir", async (absolute, options) => {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    assert.equal(options.bufferSize, 32);
    assert.ok(Object.hasOwn(tree, relative), `unexpected descent ${relative}`);
    events.push(`open:${relative}`);
    await hooks.open?.(relative);
    live++; maximum = Math.max(maximum, live);
    let index = 0;
    return {
      async read() {
        reads++; await hooks.read?.(relative, index);
        return tree[relative][index++] ?? null;
      },
      async close() {
        events.push(`closing:${relative}`);
        try { await hooks.close?.(relative); }
        finally { live--; events.push(`closed:${relative}`); }
      },
    };
  });
  t.mock.method(fs.promises, "stat", async (absolute) => { stats.push(path.relative(root, absolute)); return { size: 1 }; });
  return { events, stats, live: () => live, maximum: () => maximum, reads: () => reads };
}
function registry(handler, options = {}) {
  const value = createToolRegistry({ redactor: createRedactor(), ...options });
  value.registerTool("ftp_read", { inputSchema: { max_bytes: z.number().optional() }, annotations: {} }, handler);
  return value;
}
async function occupy(t, count = 64) {
  const gate = deferred(), operations = [];
  const values = [registry(async (_args, operation) => { operations.push(operation); await gate.promise; return success(); }),
    registry(async (_args, operation) => { operations.push(operation); await gate.promise; return success(); })];
  const pending = Array.from({ length: count }, (_, index) => values[index % 2].call("ftp_read", {}));
  const release = async () => { gate.resolve(); await Promise.all(pending); await Promise.all(operations.map((op) => op.settlement)); };
  t.after(release);
  await until(() => operations.length === count);
  return { release, values, operations };
}

for (const [field, maximum, defaultValue] of [["maxScanEntries", 1000000, 100000], ["maxScanDepth", 256, 64]]) {
  test(`${field}: positive safe policies, boundaries, defaults and private diagnostics`, (t) => {
    const root = temp(t), configFile = path.join(root, "config.json");
    assert.equal(normalizeServer("test", configured(root))[field], defaultValue);
    for (const value of [1, maximum, 0, -1, maximum + 1, 1.5, "SECRET_REJECTED_POLICY", null,
      Number.MAX_SAFE_INTEGER + 1, { SECRET_REJECTED_KEY: true }]) {
      fs.writeFileSync(configFile, JSON.stringify({ servers: { test: configured(root, { [field]: value }) } }));
      const loaded = loadConfig(configFile);
      if (value === 1 || value === maximum) assert.equal(loaded.error, null);
      else {
        assert.match(loaded.error, new RegExp(field));
        assert.doesNotMatch(loaded.error, /SECRET_REJECTED/);
      }
    }
  });
}

test("empty root counts one; exact entry boundary succeeds and +1 refuses the complete scan", async (t) => {
  const root = temp(t);
  assert.equal((await deployment(root, { maxScanEntries: 1 }).call()).structuredContent.total_files, 0);
  fs.writeFileSync(path.join(root, "a"), "x");
  const exact = deployment(root, { maxScanEntries: 2 });
  assert.equal((await exact.call()).structuredContent.total_files, 1);
  for (const dry_run of [true, false]) {
    const refused = deployment(root, { maxScanEntries: 1 });
    error(await refused.call({ dry_run, maxScanEntries: 1000000 }), "SCAN_LIMIT");
    assert.deepEqual(refused.calls(), { connections: 0, mutations: 0 });
  }
});

test("directories, excluded files and links each count once, without a second descent charge", async (t) => {
  const root = temp(t);
  const scan = virtualTree(t, root, { "": [dir("docs"), file(".env"), link("outside"), file("a")], docs: [file("b")] });
  assert.equal((await deployment(root, { maxScanEntries: 6 }).call()).structuredContent.total_files, 2);
  error(await deployment(root, { maxScanEntries: 5 }).call(), "SCAN_LIMIT");
  assert.equal(scan.live(), 0);
  assert.equal(scan.maximum(), 2);
  assert.ok(scan.stats.every((name) => !name.includes("outside") && !name.includes(".env")));
});

for (const dry_run of [true, false]) {
  test(`inclusive depth refuses before opening an over-depth child (dry_run=${dry_run})`, async (t) => {
    const root = temp(t);
    const scan = virtualTree(t, root, { "": [dir("docs")], docs: [file("wanted"), dir("nested")] });
    const value = deployment(root, { maxScanDepth: 1 });
    error(await value.call({ dry_run }), "SCAN_LIMIT");
    assert.deepEqual(scan.events.filter((event) => event.startsWith("open:")), ["open:", "open:docs"]);
    assert.equal(scan.live(), 0);
    assert.deepEqual(value.calls(), { connections: 0, mutations: 0 });
  });
}

test("files in the final allowed directory remain eligible and handles peak at depth + 1", async (t) => {
  const root = temp(t);
  const scan = virtualTree(t, root, { "": [dir("a")], a: [dir("b")], "a/b": [file("wanted")] });
  const result = await deployment(root, { maxScanDepth: 2, maxScanEntries: 4 }).call();
  assert.equal(result.structuredContent.total_files, 1);
  assert.equal(result.structuredContent.planned[0].path, "a/b/wanted");
  assert.equal(scan.maximum(), 3); assert.equal(scan.live(), 0);
});

test("only proven built-in directory exclusions prune, even at the depth/entry boundary", async (t) => {
  const root = temp(t);
  const scan = virtualTree(t, root, { "": [dir("docs")], docs: [dir("node_modules"), dir(".git"), dir(".ftp-mcp"), file("wanted")] });
  const value = await deployment(root, { maxScanEntries: 6, maxScanDepth: 1 }).call({ include: ["**/*"] });
  assert.equal(value.structuredContent.total_files, 1);
  assert.equal(scan.maximum(), 2); assert.equal(scan.live(), 0);
});

test("custom sentinel exclusion does not prune wanted files; slash/basename matching and sorting remain", async (t) => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, "docs"));
  for (const relative of ["z.txt", "docs/wanted.txt", "docs/__ftp_deploy_probe__", "docs/a.log", "docs/.env", "a.txt"])
    fs.writeFileSync(path.join(root, relative), "x");
  const result = await deployment(root).call({ exclude: ["**/__ftp_deploy_probe__"], include: ["*.txt", "docs/**"] });
  assert.deepEqual(result.structuredContent.planned.map((entry) => entry.path), ["a.txt", "docs/wanted.txt", "z.txt"]);
});

test("includes and ambiguous custom exclusions never prune unmatched directories", async (t) => {
  const root = temp(t);
  virtualTree(t, root, { "": [dir("docs")], docs: [dir("deep")] });
  for (const args of [{ include: ["only.txt"] }, { exclude: ["docs/**"] }])
    error(await deployment(root, { maxScanDepth: 1 }).call(args), "SCAN_LIMIT");
});

test("maxDeployFiles stops accumulation before statting the first excess selected file", async (t) => {
  const root = temp(t), scan = virtualTree(t, root, { "": [file("a"), file("b"), file("c")] });
  const value = deployment(root, { maxDeployFiles: 1 });
  error(await value.call({ dry_run: false }), "TRANSFER_LIMIT");
  assert.deepEqual(scan.stats, ["a"]);
  assert.equal(scan.reads(), 2); assert.equal(scan.live(), 0);
  assert.deepEqual(value.calls(), { connections: 0, mutations: 0 });
});

test("a ready-buffer scan yields to parent cancellation and a timer before exhausting unmatched entries", async (t) => {
  const root = temp(t), controller = new AbortController();
  let timerFired = false;
  const scan = virtualTree(t, root, { "": Array.from({ length: 50000 }, (_, i) => file(`.env.${i}`)) }, {
    open() { setTimeout(() => { timerFired = true; controller.abort(); }, 0); },
  });
  const value = deployment(root);
  error(await value.call({}, { signal: controller.signal }), "CANCELLED", "none");
  await until(() => scan.live() === 0);
  assert.ok(timerFired); assert.ok(scan.reads() >= 256 && scan.reads() < 50000);
  assert.deepEqual(value.calls(), { connections: 0, mutations: 0 });
});

test("scan deadline cancels a pending read and awaits its eventual handle close", async (t) => {
  const root = temp(t), read = deferred();
  const scan = virtualTree(t, root, { "": [file("a")] }, { read: () => read.promise });
  const value = deployment(root, { operationTimeoutMs: 20 });
  error(await value.call(), "TIMEOUT", "contact_operator");
  assert.equal(scan.live(), 1);
  read.resolve(); await until(() => scan.live() === 0);
  assert.deepEqual(value.calls(), { connections: 0, mutations: 0 });
});

test("abort during opendir still closes the returned handle", async (t) => {
  const root = temp(t), opening = deferred(), controller = new AbortController();
  const scan = virtualTree(t, root, { "": [] }, { open: () => opening.promise });
  const value = deployment(root);
  const pending = value.call({}, { signal: controller.signal });
  await until(() => scan.events.length > 0); controller.abort();
  error(await pending, "CANCELLED", "none");
  opening.resolve(); await until(() => scan.events.includes("closed:"));
  assert.equal(scan.live(), 0);
});

for (const failScan of [true, false]) {
  test(`unexpected close failure propagates and all ancestors close (primary scan failure=${failScan})`, async (t) => {
    const root = temp(t);
    const scan = virtualTree(t, root, { "": [dir("docs")], docs: [file("a")] }, {
      close(relative) { if (relative === "docs") throw new Error("fixture close failure"); },
    });
    const value = deployment(root, { maxScanEntries: failScan ? 2 : 3 });
    const result = await value.call();
    error(result, failScan ? "SCAN_LIMIT" : "INTERNAL_ERROR", failScan ? "fix_input" : "contact_operator");
    assert.match(result.structuredContent.error.message, /fixture close failure/);
    assert.equal(scan.live(), 0); assert.ok(scan.events.includes("closed:"));
    assert.deepEqual(value.calls(), { connections: 0, mutations: 0 });
  });
}

test("64 calls across registries saturate before preparation; unknown and invalid inputs retain priority", async (t) => {
  const occupied = await occupy(t);
  let preparatory = 0, handlers = 0;
  for (const locale of ["en", "fr"]) {
    const value = registry(() => { handlers++; return success(); }, {
      i18n: createI18n(locale), timeoutFor: () => { preparatory++; return 2000; },
    });
    const refused = error(await value.call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
    assert.match(refused.message, locale === "fr" ? /appels d’outil/ : /tool calls/);
    error(await value.call("ftp_read", { max_bytes: "wrong" }), "INVALID_ARGUMENT");
    await assert.rejects(value.call("missing", {}), (err) => err.code === -32602);
    const controller = new AbortController(); controller.abort();
    error(await value.call("ftp_read", {}, { signal: controller.signal }), "CANCELLED", "none");
  }
  assert.equal(preparatory, 0); assert.equal(handlers, 0);
  await occupied.release();
  assert.equal((await registry(success).call("ftp_read", {})).isError, undefined);
});

for (const failure of ["prepare", "handler"]) {
  test(`synchronous ${failure} failure releases exactly once`, async (t) => {
    const held = await occupy(t, 63);
    const failed = registry(() => { if (failure === "handler") throw new Error("handler failure"); return success(); }, {
      timeoutFor: () => { if (failure === "prepare") throw new Error("prepare failure"); return 2000; },
    });
    for (let i = 0; i < 3; i++) error(await failed.call("ftp_read", {}), "INTERNAL_ERROR", "contact_operator");
    const last = await occupy(t, 1);
    error(await registry(success).call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
    await last.release(); await held.release();
  });
}

test("an aborted asynchronous preparation owns its lease until it settles and never starts a worker", async (t) => {
  const held = await occupy(t, 63), preparation = deferred(), controller = new AbortController();
  let started = 0, preparing = 0;
  const value = registry(() => { started++; return success(); }, { timeoutFor: () => { preparing++; return preparation.promise; } });
  const pending = value.call("ftp_read", {}, { signal: controller.signal });
  assert.equal(preparing, 1); controller.abort();
  error(await registry(success).call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
  preparation.resolve(2000); error(await pending, "CANCELLED", "none");
  assert.equal(started, 0);
  assert.equal((await registry(success).call("ftp_read", {})).isError, undefined);
  await held.release();
});

for (const outcome of ["cancel", "timeout"]) {
  for (const cooperative of [true, false]) {
    test(`${outcome} keeps admission through delayed ${cooperative ? "cooperative cleanup" : "noncooperative work"}`, async (t) => {
      const held = await occupy(t, 63), controller = new AbortController(), gate = deferred();
      let operation, cleanup = false;
      const value = registry(async (_args, current) => {
        operation = current;
        if (cooperative) {
          try { await new Promise((resolve) => current.signal.addEventListener("abort", resolve, { once: true })); current.check(); }
          finally { cleanup = true; await gate.promise; }
        } else { await gate.promise; }
        return success();
      }, { timeoutFor: () => outcome === "timeout" ? 20 : 2000 });
      const pending = value.call("ftp_read", {}, { signal: controller.signal });
      await until(() => operation);
      if (outcome === "cancel") controller.abort();
      error(await pending, outcome === "cancel" ? "CANCELLED" : "TIMEOUT", outcome === "cancel" ? "none" : "contact_operator");
      if (cooperative) assert.equal(cleanup, true);
      error(await registry(success).call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
      gate.resolve(); await operation.settlement;
      assert.equal((await registry(success).call("ftp_read", {})).isError, undefined);
      await held.release();
    });
  }
}

test("pending directory close retains both admission and endpoint FIFO lock", async (t) => {
  const root = temp(t), close = deferred(), controller = new AbortController();
  const scan = virtualTree(t, root, { "": [file("a")] }, { close: () => close.promise });
  const held = await occupy(t, 62);
  const operations = []; let entered = 0;
  const value = registry(async (_args, operation) => {
    operations.push(operation);
    return operation.lock(["resource-bounds:close-lock"], async () => {
      entered++;
      if (entered === 1) await selectDeployFiles(root, undefined, undefined, normalizeServer("test", configured(root)), operation);
      return success();
    });
  });
  const first = value.call("ftp_read", {}, { signal: controller.signal });
  await until(() => scan.events.includes("closing:"));
  const second = value.call("ftp_read", {});
  await until(() => operations.length === 2);
  controller.abort(); error(await first, "CANCELLED", "none");
  error(await registry(success).call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
  assert.equal(entered, 1); assert.equal(scan.live(), 1);
  close.resolve(); await Promise.all(operations.map((op) => op.settlement)); await second;
  assert.equal(entered, 2); assert.equal(scan.live(), 0);
  assert.equal((await registry(success).call("ftp_read", {})).isError, undefined);
  await held.release();
});

for (const id of [0, "", 1, "0"]) {
  test(`actual SDK ID ${JSON.stringify(id)} cancellation retains admission and permits reuse after settlement`, async (t) => {
    const held = await occupy(t, 63), gate = deferred(), operations = [];
    const server = new McpServer({ name: "resource-bounds", version: "1.0.0" });
    const [peer, base] = InMemoryTransport.createLinkedPair();
    const transport = withZeroCancellation(base), messages = [];
    let scopes = 0, closes = 0;
    const scope = transport.scope;
    transport.scope = (extra) => { scopes++; return scope(extra); };
    const value = registry(async (_args, operation) => {
      operations.push(operation);
      if (operations.length === 1) await gate.promise;
      return success();
    }, { transportContext: transport });
    value.install(server);
    peer.onmessage = (message) => messages.push(message);
    peer.onclose = () => { closes++; };
    await server.connect(transport); await peer.start();
    t.after(async () => { gate.resolve(); await server.close(); });
    const sendCall = () => peer.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ftp_read", arguments: {} } });
    await peer.send({ jsonrpc: "2.0", id: 97, method: "initialize", params: {
      protocolVersion: "2025-11-25", clientInfo: { name: "raw-peer", version: "1.0.0" }, capabilities: {},
    } });
    await until(() => messages.some((message) => message.id === 97));
    await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sendCall(); await until(() => operations.length === 1);
    await peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    await until(() => operations[0].signal.aborted); await tick();
    assert.equal(messages.some((message) => message.id === id), false);
    error(await registry(success).call("ftp_read", {}), "CAPACITY_LIMIT", "retry");
    gate.resolve(); await operations[0].settlement; await tick();
    await sendCall(); await until(() => messages.some((message) => message.id === id));
    assert.equal(messages.find((message) => message.id === id).result.isError, undefined);
    assert.equal(operations.length, 2); assert.equal(scopes, 2); assert.equal(closes, 0);
    await held.release();
  });
}
