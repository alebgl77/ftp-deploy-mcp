import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOperation, remoteLockKey, localLockKey } from "../src/operations.js";
import { loadConfig, normalizeServer } from "../src/config.js";
import { registerTools } from "../src/tools.js";
import * as ftp from "../src/adapters/ftp.js";
import * as sftp from "../src/adapters/sftp.js";
import { virtualTransferAdapter } from "./transfers.js";

const SECRET = "operation-test-secret";
const PIN = `SHA256:${Buffer.alloc(32, 17).toString("base64").replace(/=+$/, "")}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("operation test did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function config(root, aliases = { test: {} }) {
  const names = Object.keys(aliases);
  return {
    found: true, error: null, defaultServer: names[0], serverNames: names,
    invalidServerNames: [], serverErrors: {},
    config: { defaultServer: names[0], servers: Object.fromEntries(names.map((name) => [name, {
      protocol: "sftp", host: "operation.invalid", user: "tester", password: SECRET,
      root: "/", localRoot: root, hostKeySha256: PIN, operationTimeoutMs: 3000, ...aliases[name],
    }])) },
  };
}
function capture(loaded, openAdapter) {
  const handlers = new Map();
  registerTools({ registerTool(name, _spec, handler) { handlers.set(name, handler); } }, loaded, { openAdapter });
  return (name, args = {}, extra = {}) => handlers.get(name)(args, extra);
}
function text(result) { return result.content.map((item) => item.text || "").join("\n"); }
function adapter(overrides = {}) {
  return virtualTransferAdapter(overrides);
}

export async function runOperationTests({ root, ok }) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  const deploy = path.join(root, "deploy");
  fs.mkdirSync(deploy, { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(deploy, name), name);
  await aliasPathTests(path.join(root, "aliases"), ok);
  const fixture = config(root).config.servers.test;
  const cfgPath = path.join(root, "timeout.json");
  for (const value of [100, 120000, 3600000, 99, 3600001, 100.5, "100", null, false]) {
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: { test: { ...fixture, operationTimeoutMs: value } } }));
    const loaded = loadConfig(cfgPath);
    const valid = Number.isInteger(value) && value >= 100 && value <= 3600000;
    ok(valid ? loaded.error === null : loaded.error?.includes("operationTimeoutMs"),
      `operations: timeout validation handles ${JSON.stringify(value)}`);
  }
  ok(normalizeServer("test", { ...fixture, operationTimeoutMs: undefined }).operationTimeoutMs === 120000,
    "operations: timeout defaults to 120 seconds");
  const one = createOperation();
  const two = createOperation();
  await one.run(() => {});
  await two.run(() => {});
  ok(one.id !== two.id && /^[0-9a-f-]{36}$/.test(one.id), "operations: request IDs are independent random UUIDs");
  ok(remoteLockKey(normalizeServer("a", fixture)) === remoteLockKey(normalizeServer("b", {
    ...fixture, host: "OPERATION.INVALID.", root: "/overlap",
  })), "operations: normalized endpoint keys ignore server alias and root");
  ok(localLockKey(path.join(root, "x", "..", "same")) === localLockKey(path.join(root, "same")),
    "operations: local destination keys normalize path segments");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { createOperation } from ${JSON.stringify(new URL("../src/operations.js", import.meta.url).href)};
     const controller = new AbortController();
     const operation = createOperation({ signal: controller.signal });
     const result = operation.run(() => new Promise(() => {})).catch(() => {});
     controller.abort();
     await result;`], { timeout: 5000 });
  ok(child.status === 0, "operations: an aborted noncooperative worker leaves no deadline timer keeping Node alive");
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  try {
    const operation = createOperation({}, 100);
    const result = await operation.run(() => { now += 101; }).catch((error) => error);
    ok(result?.code === "TIMEOUT", "operations: deadline checkpoints reject work even before the timer gets an event-loop turn");
  } finally { Date.now = clock; }

  // Separate registrations must share a process-wide FIFO, including aliases
  // whose roots overlap. Cancelled waiters must not open an adapter.
  const aliases = config(root, { first: {}, cancelled: { root: "/sub" }, next: { root: "/sub/deeper" }, last: {} });
  const held = deferred();
  const order = [];
  let active = 0;
  let maxActive = 0;
  let opens = 0;
  const open = async (server, operation) => {
    opens += 1;
    ok(Boolean(operation.id && operation.signal), "operations: context reaches adapter construction");
    return adapter({ async mkdirp() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(server.name);
      if (server.name === "first") await held.promise;
      active -= 1;
    } });
  };
  const firstCall = capture(aliases, open);
  const otherCall = capture(aliases, open);
  const first = firstCall("ftp_mkdir", { server: "first", path: "new" });
  await until(() => active === 1);
  const controller = new AbortController();
  const cancelled = otherCall("ftp_mkdir", { server: "cancelled", path: "new" }, { signal: controller.signal });
  const next = otherCall("ftp_mkdir", { server: "next", path: "new" });
  const last = otherCall("ftp_mkdir", { server: "last", path: "new" });
  await tick();
  ok(opens === 1, "operations: overlapping aliases cannot connect while another mutation owns the endpoint");
  controller.abort(SECRET);
  const cancelledResult = await cancelled;
  ok(cancelledResult.isError && text(cancelledResult).includes("CANCELLED") &&
    text(cancelledResult).includes("TARGET_BUSY") && !text(cancelledResult).includes(SECRET),
  "operations: queued cancellation reports sanitized cancellation and target contention");
  let independentOpened = false;
  const independent = capture(config(root, { other: { host: "independent.invalid" } }), async () => {
    independentOpened = true;
    return adapter();
  });
  const independentResult = await independent("ftp_mkdir", { path: "new" });
  const readResult = await capture(aliases, async () => adapter())("ftp_list", {});
  ok(independentOpened && !independentResult.isError && !readResult.isError && active === 1,
    "operations: independent endpoints and same-endpoint readers proceed concurrently");
  held.resolve();
  const completed = await Promise.all([first, next, last]);
  ok(completed.every((result) => !result.isError) && maxActive === 1 && opens === 3 &&
    order.join(",") === "first,next,last", "operations: FIFO skips cancelled waiter and never overlaps mutations");

  const mutationGate = deferred();
  let mutationOpens = 0;
  let mutationsActive = 0;
  let maxMutations = 0;
  const mutationCall = capture(config(root), async () => {
    mutationOpens += 1;
    const first = mutationOpens === 1;
    const mutate = async () => {
      mutationsActive += 1;
      maxMutations = Math.max(maxMutations, mutationsActive);
      if (first) await mutationGate.promise;
      await tick();
      mutationsActive -= 1;
    };
    return adapter({ mkdirp: mutate, uploadFile: mutate, rename: mutate, deleteFile: mutate });
  });
  const blocker = mutationCall("ftp_mkdir", { path: "held" });
  await until(() => mutationsActive === 1);
  const mutations = [
    mutationCall("ftp_upload", { local_path: "deploy/a.txt" }),
    mutationCall("ftp_deploy", { local_dir: "deploy" }),
    mutationCall("ftp_rename", { from_path: "a", to_path: "b" }),
    mutationCall("ftp_delete", { path: "a" }),
  ];
  await tick();
  ok(mutationOpens === 1, "operations: upload, deploy, rename and delete all wait behind the endpoint mutation lock");
  mutationGate.resolve();
  const mutationResults = await Promise.all([blocker, ...mutations]);
  ok(mutationResults.every((result) => !result.isError) && maxMutations === 1 && mutationOpens === 5,
    "operations: all five remote mutation tools share the same exclusion boundary");

  let preOpens = 0;
  const preCall = capture(config(root), async () => { preOpens += 1; return adapter(); });
  const pre = new AbortController();
  pre.abort();
  for (const [name, args] of [
    ["ftp_list_servers", {}], ["ftp_test", {}], ["ftp_list", {}], ["ftp_read", { path: "x" }],
    ["ftp_upload", { local_path: "deploy/a.txt" }], ["ftp_deploy", { local_dir: "deploy" }],
    ["ftp_download", { remote_path: "x", local_path: "pre.txt" }], ["ftp_mkdir", { path: "x" }],
    ["ftp_rename", { from_path: "x", to_path: "y" }], ["ftp_delete", { path: "x" }],
  ]) {
    const result = await preCall(name, args, { signal: pre.signal });
    ok(result.isError && text(result).includes("CANCELLED"), `operations: pre-aborted ${name} is refused`);
  }
  ok(preOpens === 0 && !fs.existsSync(path.join(root, "pre.txt")), "operations: pre-aborted requests open and write nothing");

  // Downloads lock the canonical local destination across different servers.
  for (const overwrite of [false, true]) {
    const release = deferred();
    let writes = 0;
    let downloading = 0;
    let maxDownloading = 0;
    let downloadOpens = 0;
    const name = `shared-${overwrite}.txt`;
    const call = capture(config(root, { a: {}, b: { host: "other-download.invalid" } }), async () => {
      downloadOpens += 1;
      return adapter({ async downloadFile(_remote, local) {
        downloading += 1;
        maxDownloading = Math.max(maxDownloading, downloading);
        writes += 1;
        if (writes === 1) await release.promise;
        fs.writeFileSync(local, "downloaded");
        downloading -= 1;
      } });
    });
    const a = call("ftp_download", { server: "a", remote_path: "x", local_path: name, overwrite });
    await until(() => downloading === 1);
    const b = call("ftp_download", { server: "b", remote_path: "y", local_path: path.join(root, name), overwrite });
    await tick();
    ok(downloadOpens === 1, `operations: shared download destination waits across servers (overwrite=${overwrite})`);
    release.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    ok(!ra.isError && maxDownloading === 1 && (overwrite ? !rb.isError && writes === 2 :
      rb.isError && text(rb).includes("overwrite:true") && writes === 1 && downloadOpens === 1),
    `operations: destination checks run under lock (overwrite=${overwrite})`);
  }

  const mid = new AbortController();
  let uploaded = 0;
  let closed = 0;
  const midCall = capture(config(root), async () => adapter({
    async uploadFile() { uploaded += 1; mid.abort(); }, async close() { closed += 1; },
  }));
  const midResult = await midCall("ftp_deploy", { local_dir: "deploy" }, { signal: mid.signal });
  await until(() => closed === 1);
  ok(midResult.isError && text(midResult).includes("CANCELLED") && uploaded === 1,
    "operations: cancellation during deploy prevents every following file");

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const rejectLate of [false, true]) {
      const release = deferred();
      let started = false;
      let writes = 0;
      let closes = 0;
      let connections = 0;
      const call = capture(config(root, { slow: { operationTimeoutMs: 100 }, next: {} }), async () => {
        connections += 1;
        return adapter({ async uploadFile() {
          started = true;
          writes += 1;
          await release.promise;
        }, async close() { closes += 1; } });
      });
      const timed = call("ftp_deploy", { server: "slow", local_dir: "deploy" });
      await until(() => started);
      const timeout = await timed;
      ok(timeout.isError && text(timeout).includes("TIMEOUT"), `operations: noncooperative transfer returns deadline error (reject=${rejectLate})`);
      const after = call("ftp_mkdir", { server: "next", path: "next" });
      await tick();
      ok(connections === 1 && closes === 1, "operations: timeout closes transport but keeps the lock while underlying mutation runs");
      if (rejectLate) release.reject(new Error(SECRET));
      else release.resolve();
      const result = await after;
      ok(!result.isError && writes === 1 && connections === 2,
        "operations: settlement releases ownership without late deploy continuation or retry");
    }
    const delayed = deferred();
    let connections = 0;
    let closes = 0;
    let writes = 0;
    const call = capture(config(root, { slow: { operationTimeoutMs: 100 }, busy: { operationTimeoutMs: 100 }, next: {} }),
      async (server) => {
        connections += 1;
        if (server.name === "slow") return delayed.promise;
        return adapter({ async mkdirp() { writes += 1; } });
      });
    const timeout = await call("ftp_mkdir", { server: "slow", path: "late" });
    const busy = await call("ftp_mkdir", { server: "busy", path: "busy" });
    const after = call("ftp_mkdir", { server: "next", path: "next" });
    await tick();
    ok(timeout.isError && busy.isError && text(busy).includes("TIMEOUT") && text(busy).includes("TARGET_BUSY") && connections === 1,
      "operations: pending connection retains ownership and queued deadline reports target contention");
    delayed.resolve(adapter({ async close() { closes += 1; }, async mkdirp() { writes += 100; } }));
    const afterResult = await after;
    ok(!afterResult.isError && closes === 1 && writes === 1 && connections === 2,
      "operations: late-open adapter is closed without mutation before the next waiter proceeds");
    await tick();
    ok(unhandled.length === 0, "operations: late rejection and cleanup produce no unhandled rejection");
  } finally { process.removeListener("unhandledRejection", onUnhandled); }

  for (const failure of ["connect", "write", "close"]) {
    let first = true;
    const call = capture(config(root), async () => {
      const fail = first;
      first = false;
      if (fail && failure === "connect") throw new Error(SECRET);
      return adapter({
        async mkdirp() { if (fail && failure === "write") throw new Error(SECRET); },
        async close() { if (fail && failure === "close") throw new Error(SECRET); },
      });
    });
    const bad = await call("ftp_mkdir", { path: "bad" });
    const good = await call("ftp_mkdir", { path: "good" });
    ok(bad.isError && !text(bad).includes(SECRET) && !good.isError,
      `operations: ${failure} failure releases its lock and remains redacted`);
  }

  await progressTests(ok);
  await sdkTests(root, ok);
  await transportAbortTests(ok);
}

async function aliasPathTests(root, ok) {
  const realParent = path.join(root, "real-parent");
  const realRoot = path.join(realParent, "configured");
  const aliasParent = path.join(root, "alias-parent");
  const aliasRoot = path.join(aliasParent, "configured");
  const realDeploy = path.join(realRoot, "site");
  const nested = path.join(realDeploy, "nested");
  const outside = path.join(root, "outside");
  const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(nested, "payload.txt"), "inside");
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside");
  linkDirectory(realParent, aliasParent);
  for (const [configuredRoot, relativeDir] of [[aliasParent, "configured/site"], [aliasRoot, "site"]]) {
    for (const localDir of [relativeDir, path.resolve(configuredRoot, relativeDir)]) {
      const uploaded = [];
      const call = capture(config(configuredRoot), async () => adapter({
        async uploadFile(local) { uploaded.push(local); },
      }));
      const result = await call("ftp_deploy", { local_dir: localDir });
      ok(!result.isError && uploaded.length === 1 && uploaded[0] === path.join(nested, "payload.txt"),
        "operations: deploy revalidates lexical paths when localRoot or an ancestor is an alias");
    }
  }
  let escapedUploads = 0;
  const escape = capture(config(aliasRoot), async () => {
    // Replace a selected directory only after discovery, so the per-file
    // validation must reject its newly external canonical target.
    fs.renameSync(nested, path.join(realDeploy, "saved-nested"));
    linkDirectory(outside, nested);
    return adapter({ async uploadFile() { escapedUploads += 1; } });
  });
  const escaped = await escape("ftp_deploy", { local_dir: "site" });
  ok(escaped.isError && text(escaped).includes("resolves outside") && escapedUploads === 0,
    "operations: deploy through an aliased root still rejects a selected file retargeted outside");

  const aliases = config(realRoot, {
    direct: {}, alias: { host: "alias-download.invalid", localRoot: aliasRoot },
  });
  for (const retarget of [false, true]) {
    const gate = deferred();
    let opens = 0;
    let writes = 0;
    let started = false;
    const filename = retarget ? "retarget.txt" : "shared.txt";
    const alternateParent = path.join(root, "alternate-parent");
    const alternateRoot = path.join(alternateParent, "configured");
    fs.mkdirSync(alternateRoot, { recursive: true });
    const call = capture(aliases, async () => {
      opens += 1;
      return adapter({ async downloadFile(_remote, local) {
        started = true;
        await gate.promise;
        writes += 1;
        fs.writeFileSync(local, "downloaded");
      } });
    });
    const first = call("ftp_download", { server: "direct", remote_path: "source", local_path: filename });
    await until(() => started);
    const second = call("ftp_download", { server: "alias", remote_path: "source", local_path: filename });
    await tick();
    ok(opens === 1, "operations: canonical destination lock serializes ancestor aliases across servers");
    if (retarget) {
      fs.renameSync(aliasParent, path.join(root, "original-alias"));
      linkDirectory(alternateParent, aliasParent);
    }
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    ok(!a.isError && b.isError && opens === 1 && writes === 1 &&
      text(b).includes(retarget ? "TARGET_CHANGED" : "overwrite:true") &&
      !fs.existsSync(path.join(alternateRoot, filename)),
    retarget ? "operations: retargeted ancestor is refused before opening under the wrong lock" :
      "operations: overwrite:false is rechecked for the same canonical file reached through two roots");
  }
  linkDirectory(outside, path.join(realRoot, "escape"));
  let escapedDownloads = 0;
  const download = capture(config(realRoot), async () => {
    escapedDownloads += 1;
    return adapter();
  });
  const refused = await download("ftp_download", {
    remote_path: "source", local_path: "escape/payload.txt", overwrite: true,
  });
  ok(refused.isError && text(refused).includes("symbolic link or junction") && escapedDownloads === 0 &&
    fs.readFileSync(path.join(outside, "payload.txt"), "utf8") === "outside",
  "operations: canonical locking preserves download refusal of an escaping symlink");
}

async function progressTests(ok) {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const sendGate = deferred();
    const workGate = deferred();
    const sent = [];
    const operation = createOperation({ signal: controller.signal, _meta: { progressToken: "progress" },
      sendNotification: (notification) => { sent.push(notification); return sendGate.promise; } });
    const result = operation.run(async () => {
      operation.progress();
      operation.progress();
      await workGate.promise;
    }).catch((err) => err);
    await until(() => sent.length === 1);
    if (cancelled) controller.abort();
    workGate.resolve();
    await result;
    sendGate.resolve();
    await tick();
    operation.progress();
    await tick();
    ok(sent.length === 1, `operations: queued progress stops after ${cancelled ? "abort" : "completion"}`);
  }
}

async function sdkTests(root, ok) {
  const gate = deferred();
  let uploads = 0;
  let context;
  const progress = [];
  const server = new McpServer({ name: "operations-server", version: "1.0.0" });
  registerTools(server, config(root), { openAdapter: async (_server, operation) => {
    context = operation;
    return adapter({ async uploadFile() { uploads += 1; await gate.promise; } });
  } });
  const client = new Client({ name: "operations-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, ...args) => {
    if (message.method === "notifications/progress") progress.push(message.params);
    return send(message, ...args);
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "ftp_test", arguments: {} });
    ok(progress.length === 0, "operations SDK: no progress without caller opt-in");
    const observed = [];
    await client.callTool({ name: "ftp_test", arguments: {} }, undefined, { onprogress: (value) => observed.push(value) });
    await tick();
    ok(observed.length > 0 && observed.every((value, index) => index === 0 || value.progress > observed[index - 1].progress) &&
      progress.every((value) => Object.keys(value).sort().join(",") === "progress,progressToken"),
    "operations SDK: opt-in progress is monotonic and contains no paths, credentials or free-form text");
    const controller = new AbortController();
    const request = client.callTool({ name: "ftp_deploy", arguments: { local_dir: "deploy" } }, undefined,
      { signal: controller.signal, onprogress: () => {} }).then(() => null, (error) => error);
    await until(() => uploads === 1);
    controller.abort();
    const error = await request;
    await until(() => context.signal.aborted);
    const count = progress.length;
    gate.resolve();
    const after = await client.callTool({ name: "ftp_mkdir", arguments: { path: "after-cancel" } });
    ok(error && !after.isError && uploads === 1 && progress.length === count,
      "operations SDK: real cancellation notification reaches the handler and stops deploy and progress");
  } finally {
    gate.resolve();
    await client.close();
    await server.close();
  }
}

async function transportAbortTests(ok) {
  for (const [protocol, module] of [["ftp", ftp], ["sftp", sftp]]) {
    const sockets = new Set();
    const listening = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const operation = createOperation({ signal: controller.signal });
    let settled = false;
    const result = operation.run(async () => {
      try {
        return await module.connect({ protocol, host: "127.0.0.1", port: listening.address().port,
          user: "test", password: SECRET, root: "/", allowInsecure: true, allowUnknownHostKey: true }, operation);
      } finally { settled = true; }
    }).catch((err) => err);
    try {
      await until(() => sockets.size === 1);
      controller.abort();
      const error = await result;
      await until(() => settled && sockets.size === 0);
      ok(error?.code === "CANCELLED", `operations: ${protocol} cancellation closes a pending native handshake`);
    } finally {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => listening.close(resolve));
    }
  }
}
