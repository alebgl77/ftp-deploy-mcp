import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createI18n, CATALOGS } from "../src/i18n.js";
import { ERROR_CODES, appError, renderError, nativeError } from "../src/errors.js";
import { registerTools } from "../src/tools.js";
import { createToolRegistry, ERROR_SCHEMA, utf8Size, addNotices } from "../src/tool-registry.js";
import { createRedactor } from "../src/redact.js";
import { virtualTransferAdapter } from "./transfers.js";
import { loadConfig, configHelpText, configRedactor } from "../src/config.js";
import { parseSiteManager, runImport } from "../src/filezilla.js";

const PIN = `SHA256:${Buffer.alloc(32, 21).toString("base64").replace(/=+$/, "")}`;
const SECRET = "error_contract_secret_934";
const asText = (result) => result.content.map((item) => item.text).join("\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-errors-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ftp-errors-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function config(root, extra = {}) {
  return { found: true, error: null, serverNames: ["test"], invalidServerNames: [], serverErrors: {}, defaultServer: "test",
    config: { servers: { test: { protocol: "sftp", host: "contract.invalid", user: "fixture", password: SECRET,
      root: "/", localRoot: root, hostKeySha256: PIN, ...extra } } } };
}
function validError(result, code) {
  assert.equal(result.isError, true);
  assert.ok(ERROR_SCHEMA.safeParse(result.structuredContent).success);
  if (code) assert.equal(result.structuredContent.error.code, code);
  assert.ok(utf8Size(result) <= 25000);
  assert.equal(result.structuredContent.error.retryable, false);
  assert.equal(Object.hasOwn(result.structuredContent.error, "operation_id"), false);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  return result.structuredContent.error;
}
async function clientFixture(t, loaded, openAdapter, locale = "en") {
  const server = new McpServer({ name: "error-contract-server", version: "1.0.0" });
  const registry = registerTools(server, loaded, { openAdapter, i18n: createI18n(locale) });
  const client = new Client({ name: "error-contract-client", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  t.after(() => client.close());
  const listed = await client.listTools();
  return { client, registry, listed };
}

for (const locale of ["en", "fr"]) {
  test(`real SDK accepts every strict success/error union after listTools (${locale})`, async (t) => {
    const root = scratch(t);
    fs.writeFileSync(path.join(root, "source.txt"), "source");
    fs.mkdirSync(path.join(root, "deploy"));
    fs.writeFileSync(path.join(root, "deploy", "a.txt"), "a");
    let opens = 0;
    const adapter = virtualTransferAdapter();
    const loaded = config(root);
    const { client, registry, listed } = await clientFixture(t, loaded, async () => { opens++; return adapter; }, locale);
    assert.equal(listed.tools.length, 10);
    assert.equal(listed.tools.filter((tool) => tool.outputSchema).length, 9);
    const cases = { ftp_list_servers: {}, ftp_test: {}, ftp_list: {}, ftp_read: { path: "source.txt" },
      ftp_upload: { local_path: "source.txt", remote_path: "upload.txt" }, ftp_deploy: { local_dir: "deploy" },
      ftp_download: { remote_path: "upload.txt", local_path: "download.txt" }, ftp_mkdir: { path: "dir" },
      ftp_rename: { from_path: "upload.txt", to_path: "renamed.txt" }, ftp_delete: { path: "renamed.txt" } };
    for (const tool of listed.tools) {
      assert.equal(tool.title, createI18n(locale).t(`mcp.${tool.name}.title`));
      assert.ok(tool.annotations);
      if (tool.outputSchema) {
        assert.equal(tool.outputSchema.$schema, "http://json-schema.org/draft-07/schema#");
        assert.equal(tool.outputSchema.oneOf.length, 2);
        for (const branch of tool.outputSchema.oneOf) assert.equal(branch.additionalProperties, false);
        assert.equal(tool.outputSchema.oneOf[1].properties.error.additionalProperties, false);
      }
      const success = await client.callTool({ name: tool.name, arguments: cases[tool.name] });
      assert.notEqual(success.isError, true, tool.name + ": " + asText(success));
      assert.ok(registry.validate(tool.name, success));
      if (tool.name === "ftp_read") assert.equal(success.structuredContent, undefined);
      const before = opens;
      if (tool.name === "ftp_list_servers") loaded.serverNames = null;
      const invalid = await client.callTool({ name: tool.name, arguments: { server: 42 } });
      loaded.serverNames = ["test"];
      assert.equal(validError(invalid, tool.name === "ftp_list_servers" ? "INTERNAL_ERROR" : "INVALID_ARGUMENT").effects, "none");
      assert.equal(validError(await registry.call(tool.name, []), "INVALID_ARGUMENT").effects, "none");
      assert.equal(opens, before);
      assert.equal(registry.validate(tool.name, { content: [], structuredContent: {} }), false);
      if (success.structuredContent) assert.equal(registry.validate(tool.name, {
        content: [], structuredContent: { ...success.structuredContent, ...invalid.structuredContent },
      }), false);
    }
    assert.equal(fs.readFileSync(path.join(root, "download.txt"), "utf8"), "source");
    await assert.rejects(client.callTool({ name: SECRET.repeat(10000), arguments: {} }), (error) => {
      assert.equal(error.code, -32602); assert.ok(error.message.length < 300); assert.ok(!error.message.includes(SECRET)); return true;
    });
    await assert.rejects(client.request({ method: "tools/call", params: { name: 99 } }, CallToolResultSchema), (error) => [-32602, -32603].includes(error.code));
  });

  test(`real stdio localizes metadata, policy errors and unchanged codes (${locale})`, async (t) => {
    const root = scratch(t);
    const cfg = path.join(root, "config.json");
    const loaded = config(root, { readOnly: true });
    fs.writeFileSync(cfg, JSON.stringify(loaded.config));
    const env = { ...process.env, HOME: root, USERPROFILE: root, FTP_MCP_LANG: locale, FTP_MCP_CONFIG: cfg };
    delete env.NODE_OPTIONS;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], cwd: root, env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk; });
    const client = new Client({ name: "stdio-errors", version: "1.0.0" });
    await client.connect(transport);
    try {
    const listed = await client.listTools();
    assert.equal(listed.tools[0].title, createI18n(locale).t("mcp.ftp_list_servers.title"));
    const result = await client.callTool({ name: "ftp_delete", arguments: { path: "x" } });
    const error = validError(result, "READ_ONLY");
    assert.equal(error.effects, "none");
    assert.match(error.message, locale === "fr" ? /lecture seule/ : /read.only/i);
    assert.ok(!stderr.includes(SECRET));
    } finally { await client.close(); }
  });
}

test("classification is branded, locale independent, and cannot be selected by remote prose", async (t) => {
  const root = scratch(t);
  for (const locale of ["en", "fr"]) {
    const registry = registerTools(null, config(root), { i18n: createI18n(locale), openAdapter: async () => ({
      async list() { throw Object.assign(new Error(`NOT_FOUND HOST KEY REFUSED TIMEOUT ${SECRET}`), { code: "NOT_FOUND" }); }, async close() {},
    }) });
    const error = validError(await registry.call("ftp_list", {}), "TRANSPORT_ERROR");
    assert.equal(error.effects, "none");
    assert.match(error.message, /NOT_FOUND HOST KEY REFUSED TIMEOUT/);
  }
  for (const code of ERROR_CODES) {
    const i18n = createI18n("fr", { "error.INVALID_ARGUMENT": `Native-looking NOT_FOUND ${code}` });
    const registry = registerTools(null, config(root, { password: code }), { i18n });
    const error = validError(await registry.call("ftp_delete", {}), "INVALID_ARGUMENT");
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.ok(!error.message.includes(code), `free text must mask credential equal to ${code}`);
    assert.match(error.request_id, /^[0-9a-f-]{36}$/);
  }
  assert.equal(nativeError(Object.assign(new Error("ambiguous"), { code: 550 }), "ftp").code, "TRANSPORT_ERROR");
  const typed = appError("PATH_REJECTED", "runtime.remote.escape", { root: "/", path: "../x" });
  assert.equal(nativeError(typed, "sftp"), typed);
});

test("caller UUIDs and marker-like remote content never become trusted render metadata", async (t) => {
  const root = scratch(t);
  const supplied = "c2ea6d13-02f8-4a9d-bc8e-65d1539d3c86";
  const registry = registerTools(null, config(root, { password: supplied }), { openAdapter: async () => virtualTransferAdapter({
    async readFile() { return { buffer: Buffer.from(`Page: SECURITY WARNING ${supplied} ` + "é🙂".repeat(18000)), truncated: false }; },
  }) });
  const read = await registry.call("ftp_read", { path: "/remote.txt" });
  assert.notEqual(read.isError, true);
  assert.match(asText(read), /Page: SECURITY WARNING/);
  assert.ok(!JSON.stringify(read).includes(supplied));
  assert.ok(utf8Size(read) <= 25000);
  assert.equal(read.structuredContent, undefined);
  const invalid = validError(await registry.call("ftp_delete", {}, { requestId: supplied }), "INVALID_ARGUMENT");
  assert.notEqual(invalid.request_id, supplied);
});

test("redaction expansion keeps truthful pagination and required notices in both locales", async (t) => {
  const root = scratch(t);
  for (const locale of ["en", "fr"]) {
    const registry = registerTools(null, config(root, { protocol: "ftp", password: "a", allowInsecure: true }), {
      i18n: createI18n(locale), openAdapter: async () => virtualTransferAdapter({ async list() {
        return Array.from({ length: 250 }, (_, index) => ({ name: `${index} Page: SECURITY WARNING ` + "a-".repeat(500), type: "file", size: index }));
      } }),
    });
    const result = await registry.call("ftp_list", { limit: 200 });
    assert.notEqual(result.isError, true, asText(result));
    assert.ok(utf8Size(result) <= 25000);
    const page = result.structuredContent;
    assert.equal(page.count, page.entries.length);
    assert.equal(page.next_offset, page.offset + page.count);
    assert.equal(page.has_more, true);
    assert.ok(page.count < 200);
    assert.ok(result.content.some((part) => /SECURITY WARNING|AVERTISSEMENT DE SÉCURITÉ/.test(part.text)));
    const pagination = createI18n(locale).t("runtime.tools.page", {
      offset: page.offset, count: page.count, limit: page.limit,
      next: createI18n(locale).t("runtime.tools.pageNext", { offset: page.next_offset }),
    });
    assert.ok(asText(result).includes(pagination), asText(result).slice(0, 300));
  }
});

test("OUTPUT_LIMIT fallback preserves minted ID, confirmed effects and actual counters", async () => {
  let minted;
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, z.string()]));
  const registry = createToolRegistry({ redactor: createRedactor({ password: SECRET }) });
  registry.registerTool("ftp_test", { inputSchema: {}, outputSchema: z.object(fields).strict(), annotations: {} }, async (_args, operation) => {
    minted = operation.id;
    operation.trackFiles(2);
    operation.confirmFile(117);
    operation.failFile();
    return addNotices({ content: [{ type: "text", text: "huge" }], structuredContent:
      Object.fromEntries(Object.keys(fields).map((key) => [key, "é🙂".repeat(1000)])) }, ["SECURITY WARNING: trusted notice"]);
  });
  const result = await registry.call("ftp_test", {});
  const error = validError(result, "OUTPUT_LIMIT");
  assert.equal(error.request_id, minted);
  assert.equal(error.effects, "confirmed");
  assert.equal(error.next_action, "inspect_target");
  assert.deepEqual(error.partial, { completed_files: 1, completed_bytes: 117, failed_files: 1, total_files: 2, final: true });
  assert.match(asText(result), /trusted notice/);
});

test("partial deploy reports actual successful promotions and sanitized failed attempts", async (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "deploy"));
  fs.writeFileSync(path.join(root, "deploy", "a"), "first");
  fs.writeFileSync(path.join(root, "deploy", "b"), "second");
  const adapter = virtualTransferAdapter({ async uploadFile(local) { if (local.endsWith("b")) throw new Error(`partial ${SECRET}`); } });
  const registry = registerTools(null, config(root), { openAdapter: async () => adapter });
  const error = validError(await registry.call("ftp_deploy", { local_dir: "deploy" }), "DEPLOY_PARTIAL");
  assert.deepEqual(error.partial, { completed_files: 1, completed_bytes: 5, failed_files: 1, total_files: 2, final: true });
  assert.equal(error.effects, "confirmed");
  assert.equal(error.next_action, "inspect_target");
});

for (const tool of ["ftp_upload", "ftp_download"]) {
  test(`close failure after ${tool} promotion retains confirmed bytes`, async (t) => {
    const root = scratch(t);
    fs.writeFileSync(path.join(root, "source"), "five!");
    const files = new Map([["/source", Buffer.from("five!")]]);
    const adapter = virtualTransferAdapter({ async close() { throw new Error(`close ${SECRET}`); } }, files);
    const registry = registerTools(null, config(root), { openAdapter: async () => adapter });
    const args = tool === "ftp_upload" ? { local_path: "source", remote_path: "target" } : { local_path: "target", remote_path: "source" };
    const error = validError(await registry.call(tool, args), "TRANSPORT_ERROR");
    assert.equal(error.effects, "confirmed");
    assert.deepEqual(error.partial, { completed_files: 1, completed_bytes: 5, failed_files: 0, total_files: 1, final: true });
    assert.equal(tool === "ftp_upload" ? files.get("/target").toString() : fs.readFileSync(path.join(root, "target"), "utf8"), "five!");
  });
}

test("cleanup failures retain the typed primary cause and never claim no effects", async (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, "source"), "source");
  const adapter = virtualTransferAdapter({ async hashFile() { throw appError("TRANSFER_VERIFY", "runtime.transfer.digestMismatch"); },
    async deleteFile() { throw new Error(SECRET); } });
  const registry = registerTools(null, config(root), { openAdapter: async () => adapter });
  const error = validError(await registry.call("ftp_upload", { local_path: "source", remote_path: "target" }), "TRANSFER_VERIFY");
  assert.equal(error.effects, "confirmed");
  assert.equal(error.partial.completed_files, 0);
  assert.match(error.message, /temporary file may remain/i);
});

test("early timeout snapshots keep uncertainty until noncooperative mutation settles", async (t) => {
  const root = scratch(t);
  const entered = deferred(), release = deferred();
  let operation, opens = 0;
  const registry = registerTools(null, config(root, { operationTimeoutMs: 100 }), { openAdapter: async (_server, current) => {
    opens++; operation = current;
    return virtualTransferAdapter({ async deleteFile() { entered.resolve(); await release.promise; } });
  } });
  const resultPromise = registry.call("ftp_delete", { path: "target" });
  await entered.promise;
  const error = validError(await resultPromise, "TIMEOUT");
  assert.equal(error.effects, "possible");
  assert.equal(error.next_action, "inspect_target");
  let settled = false;
  operation.settlement.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  release.resolve(); await operation.settlement;
  assert.equal(operation.snapshot().effects, "confirmed");
  assert.equal(opens, 1);
});

test("pre-aborted calls have no effects, callbacks, progress or native diagnostics", async (t) => {
  const controller = new AbortController(); controller.abort(new Error(SECRET));
  let opens = 0, notifications = 0;
  const registry = registerTools(null, config(scratch(t)), { openAdapter: async () => { opens++; return virtualTransferAdapter(); } });
  const error = validError(await registry.call("ftp_delete", { path: "target" }, {
    signal: controller.signal, _meta: { progressToken: 7 }, sendNotification() { notifications++; },
  }), "CANCELLED");
  assert.equal(error.effects, "none");
  assert.equal(opens, 0); assert.equal(notifications, 0);
});

test("early deploy timeout reports a non-final observed partial and stops later files", async (t) => {
  const root = scratch(t);
  const folder = path.join(root, "deploy"); fs.mkdirSync(folder);
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(folder, name), "five!");
  const entered = deferred(), release = deferred(); let operation; const attempts = [];
  const registry = registerTools(null, config(root, { operationTimeoutMs: 100 }), { openAdapter: async (_server, current) => {
    operation = current;
    return virtualTransferAdapter({ async uploadFile(local) {
      attempts.push(path.basename(local));
      if (local.endsWith("b")) { entered.resolve(); await release.promise; }
    } });
  } });
  const pending = registry.call("ftp_deploy", { local_dir: "deploy" });
  await entered.promise;
  const error = validError(await pending, "TIMEOUT");
  assert.equal(error.effects, "confirmed");
  assert.deepEqual(error.partial, { completed_files: 1, completed_bytes: 5, failed_files: 0, total_files: 3, final: false });
  release.resolve(); await operation.settlement;
  assert.deepEqual(attempts, ["a", "b"]);
  assert.equal(operation.snapshot().partial.final, true);
  assert.equal(operation.snapshot().partial.completed_files, 1);
});

test("every runtime catalog key has literal EN/FR placeholder parity", () => {
  const keys = Object.keys(CATALOGS.en).filter((key) => /^(runtime|error|mcp)\./.test(key));
  assert.ok(keys.length > 220);
  for (const key of keys) {
    const placeholders = (text) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((item) => item[1]).sort();
    assert.deepEqual(placeholders(CATALOGS.en[key]), placeholders(CATALOGS.fr[key]), key);
  }
  assert.notEqual(renderError(appError("INVALID_ARGUMENT", "error.INVALID_ARGUMENT"), createI18n("fr")), renderError(appError("INVALID_ARGUMENT", "error.INVALID_ARGUMENT")));
});

async function stdioConfigDiagnostics(root, file, locale) {
  const env = { ...process.env, HOME: root, USERPROFILE: root, FTP_MCP_LANG: locale, FTP_MCP_CONFIG: file };
  delete env.NODE_OPTIONS;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], cwd: root, env, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "config-confidentiality", version: "1.0.0" });
  try {
    await client.connect(transport); await client.listTools();
    const listed = await client.callTool({ name: "ftp_list_servers", arguments: {} });
    const rejected = await client.callTool({ name: "ftp_delete", arguments: { server: "bad", path: "x" } });
    const rejectedEnv = await client.callTool({ name: "ftp_delete", arguments: { server: "badEnv", path: "x" } });
    validError(rejected, "CONFIG_INVALID");
    validError(rejectedEnv, "CONFIG_INVALID");
    return { listed, rejected, rejectedEnv, stderr };
  } finally { await client.close(); }
}

for (const locale of ["en", "fr"]) {
  for (const partial of [false, true]) {
    test(`invalid config credentials remain private in loader/MCP/stdio (${locale}, partial=${partial})`, async (t) => {
      const root = scratch(t);
      const file = path.join(root, "invalid.json");
      const rawSecret = "raw_config_secret_951";
      const envSecret = "resolved_config_secret_952";
      const variable = "FTP_ERRORS_PRIVATE_ENV_952";
      const previous = process.env[variable]; process.env[variable] = envSecret;
      t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
      const bad = { ...config(root).config.servers.test, password: rawSecret, readOnly: rawSecret };
      const badEnv = { ...config(root).config.servers.test,
        password: `prefix-\${ENV:${variable}}`, readOnly: `prefix-\${ENV:${variable}}` };
      const servers = { bad, badEnv, ...(partial ? { good: config(root).config.servers.test } : {}) };
      fs.writeFileSync(file, JSON.stringify({ servers }));
      const loaded = loadConfig(file);
      assert.equal(loaded.config === null, !partial);
      assert.equal(loaded.config?.servers.bad, undefined);
      assert.equal(loaded.config?.servers.badEnv, undefined);
      const i18n = createI18n(locale);
      const diagnostics = [loaded.error, loaded.serverErrors.bad, loaded.failure?.message,
        loaded.serverFailures.bad.message, renderError(loaded.serverFailures.bad, i18n),
        loaded.serverErrors.badEnv, loaded.serverFailures.badEnv.message,
        renderError(loaded.serverFailures.badEnv, i18n), configHelpText(loaded, i18n)];
      const rawBefore = JSON.stringify({ servers });
      const registry = registerTools(null, loaded, { i18n, openAdapter: async () => { throw new Error("must not connect"); } });
      const listed = await registry.call("ftp_list_servers", {});
      const rejected = await registry.call("ftp_delete", { server: "bad", path: "x" });
      validError(rejected, "CONFIG_INVALID");
      const wire = await stdioConfigDiagnostics(root, file, locale);
      for (const secret of [rawSecret, envSecret, `prefix-${envSecret}`]) {
        assert.ok(!JSON.stringify(diagnostics).includes(secret));
        assert.ok(!JSON.stringify([listed, rejected, wire]).includes(secret));
        assert.ok(!JSON.stringify(loaded).includes(secret));
      }
      assert.equal(renderError(loaded.serverFailures.bad, i18n),
        i18n.t("runtime.config.server.boolean", { name: "bad", field: "readOnly" }));
      assert.equal(JSON.stringify({ servers }), rawBefore, "redaction must not mutate caller data");
      assert.equal(Object.values(loaded).includes(configRedactor(loaded)), false, "redactor is not a public loaded field");
    });
  }

  test(`malformed JSON never exposes native parser excerpts (${locale})`, async (t) => {
    const root = scratch(t);
    const secret = "SECRET42";
    const file = path.join(root, "syntax.json");
    fs.writeFileSync(file, `{"servers":{"bad":{"readOnly":${secret},"password":"${secret}"}}}`);
    const loaded = loadConfig(file);
    const i18n = createI18n(locale);
    assert.equal(loaded.config, null);
    assert.equal(renderError(loaded.failure, i18n), i18n.t("runtime.config.invalidJson", { path: file }));
    const wire = await stdioConfigDiagnostics(root, file, locale);
    const output = JSON.stringify([loaded, loaded.failure.message, renderError(loaded.failure, i18n), configHelpText(loaded, i18n), wire]);
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("readOnly"));
    assert.equal(loaded.failure.cause, undefined);
  });

  test(`all four server policy warnings use the selected catalog (${locale})`, async (t) => {
    const root = scratch(t);
    const loaded = config(root);
    loaded.serverNames = ["rootAllowed", "rootRefused", "keyAllowed", "keyRefused"];
    loaded.defaultServer = null;
    const base = loaded.config.servers.test;
    loaded.config.servers = {
      rootAllowed: { ...base, protocol: "ftp", root: "/site", allowInsecure: true, allowUnsafeRemoteRoot: true },
      rootRefused: { ...base, protocol: "ftp", root: "/site", allowInsecure: true },
      keyAllowed: { ...base, hostKeySha256: undefined, allowUnknownHostKey: true },
      keyRefused: { ...base, hostKeySha256: undefined },
    };
    const i18n = createI18n(locale);
    const registry = registerTools(null, loaded, { i18n });
    const result = await registry.call("ftp_list_servers", {});
    assert.notEqual(result.isError, true);
    for (const key of loaded.serverNames) {
      const rendered = i18n.t(`runtime.tools.servers.${key}`);
      assert.ok(asText(result).includes(rendered), key);
      if (locale === "fr") assert.ok(!asText(result).includes(createI18n().t(`runtime.tools.servers.${key}`)), key);
    }
  });

  test(`rejected FileZilla blocks never echo untrusted name/protocol (${locale})`, (t) => {
    const root = scratch(t); const secret = "FILEZILLA_REJECTED_SECRET_953";
    const cases = [
      `<Server><Name>bad</Name><Protocol>bad<Pass>${secret}</Pass></Protocol></Server>`,
      `<Server><Name>${secret}</Name><Pass>${secret}</Pass><Protocol>99</Protocol></Server>`,
      `<Server><Name>${secret}</Name><Pass>${secret}</Pass><Protocol>1</Protocol></Server>`,
    ];
    const i18n = createI18n(locale);
    for (let index = 0; index < cases.length; index++) {
      const xml = `<FileZilla3><Servers>${cases[index]}</Servers></FileZilla3>`;
      const parsed = parseSiteManager(xml, i18n);
      assert.deepEqual(parsed.servers, {});
      assert.equal(parsed.warnings.length, 1);
      assert.equal(parsed.warnings[0], i18n.t(index === 2 ? "filezilla.noHost" : "filezilla.unsupported", { index: 1 }));
      assert.ok(!JSON.stringify(parsed).includes(secret));
      const file = path.join(root, `sites-${index}.xml`), out = path.join(root, `out-${index}.json`), logs = [];
      fs.writeFileSync(file, xml);
      assert.equal(runImport({ file, out }, (line) => logs.push(line), i18n), 1);
      assert.ok(!logs.join("\n").includes(secret));
      assert.equal(fs.existsSync(out), false);
    }
  });
}

for (const tool of ["ftp_upload", "ftp_download"]) {
  test(`${tool} counts only launched failed attempts, not preflight or close`, async (t) => {
    const root = scratch(t); fs.writeFileSync(path.join(root, "source"), "source");
    const args = tool === "ftp_upload" ? { local_path: "source", remote_path: "target" } : { local_path: "target", remote_path: "source" };
    let opens = 0;
    const hooks = tool === "ftp_upload" ? { async uploadFile() { throw new Error("upload rejected"); } } :
      { async downloadFile() { throw new Error("download rejected"); } };
    const registry = registerTools(null, config(root), { openAdapter: async () => { opens++; return virtualTransferAdapter(hooks); } });
    const failed = validError(await registry.call(tool, args), "TRANSPORT_ERROR");
    assert.deepEqual(failed.partial, { completed_files: 0, completed_bytes: 0, failed_files: 1, total_files: 1, final: true });
    assert.notEqual(failed.effects, "none");
    assert.equal(opens, 1);
    const preflight = validError(await registry.call(tool, { ...args, local_path: "../outside" }), "PATH_REJECTED");
    assert.equal(preflight.partial.failed_files, 0);
    assert.equal(preflight.effects, "none"); assert.equal(opens, 1);
    const invalid = validError(await registry.call(tool, {}), "INVALID_ARGUMENT");
    assert.equal(invalid.partial, undefined); assert.equal(opens, 1);
    const controller = new AbortController(); controller.abort();
    const cancelled = validError(await registry.call(tool, args, { signal: controller.signal }), "CANCELLED");
    assert.equal(cancelled.partial, undefined); assert.equal(opens, 1);
  });

  test(`${tool} early cancellation keeps a non-final snapshot until failed attempt settles`, async (t) => {
    const root = scratch(t); fs.writeFileSync(path.join(root, "source"), "source");
    const controller = new AbortController(), entered = deferred(), release = deferred(); let operation;
    const blocked = async () => { entered.resolve(); await release.promise; throw new Error("late failure"); };
    const hooks = tool === "ftp_upload" ? { uploadFile: blocked } : { downloadFile: blocked };
    const registry = registerTools(null, config(root), { openAdapter: async (_server, current) => {
      operation = current; return virtualTransferAdapter(hooks);
    } });
    const args = tool === "ftp_upload" ? { local_path: "source", remote_path: "target" } : { local_path: "target", remote_path: "source" };
    const pending = registry.call(tool, args, { signal: controller.signal });
    await entered.promise; controller.abort();
    const cancelled = validError(await pending, "CANCELLED");
    assert.equal(cancelled.partial.final, false); assert.equal(cancelled.partial.failed_files, 0);
    assert.notEqual(cancelled.effects, "none");
    release.resolve(); await operation.settlement;
    assert.equal(operation.snapshot().partial.failed_files, 1);
    assert.equal(operation.snapshot().partial.final, true);
    assert.equal(operation.snapshot().partial.completed_files, 0);
  });
}

test("configuration diagnostics omit invalid values containing escaped credentials", (t) => {
  const root = scratch(t), file = path.join(root, "escaped.json");
  const secret = 'quoted"secret\nbackslash\\value_954';
  fs.writeFileSync(file, JSON.stringify({ servers: { bad: {
    ...config(root).config.servers.test, password: secret, readOnly: { nested: secret },
  } } }));
  const loaded = loadConfig(file);
  for (const locale of ["en", "fr"]) {
    const text = [loaded.error, loaded.serverErrors.bad, renderError(loaded.failure, createI18n(locale))].join("\n");
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(JSON.stringify(secret).slice(1, -1)));
    assert.equal(renderError(loaded.serverFailures.bad, createI18n(locale)),
      createI18n(locale).t("runtime.config.server.boolean", { name: "bad", field: "readOnly" }));
  }
});

for (const locale of ["en", "fr"]) {
  test(`invalid boolean object keys never enter loader or MCP diagnostics (${locale})`, async (t) => {
    const root = scratch(t), file = path.join(root, "key-secret.json");
    const secret = 'quoted"secret\nbackslash\\value_954';
    const bad = { ...config(root).config.servers.test, password: secret, readOnly: { [secret]: true } };
    fs.writeFileSync(file, JSON.stringify({ servers: { bad, badEnv: bad } }));
    const loaded = loadConfig(file), i18n = createI18n(locale);
    assert.equal(loaded.config, null);
    const { client } = await clientFixture(t, loaded, async () => { assert.fail("must not connect"); }, locale);
    const listed = await client.callTool({ name: "ftp_list_servers", arguments: {} });
    const rejected = await client.callTool({ name: "ftp_delete", arguments: { server: "bad", path: "x" } });
    assert.equal(validError(rejected, "CONFIG_INVALID").effects, "none");
    const wire = await stdioConfigDiagnostics(root, file, locale);
    const diagnostics = [loaded.error, loaded.serverErrors.bad, loaded.failure.message,
      renderError(loaded.serverFailures.bad, i18n), configHelpText(loaded, i18n),
      asText(listed), asText(rejected), rejected.structuredContent.error.message, wire.stderr];
    for (const text of diagnostics) {
      assert.ok(!text.includes(secret), "raw credential must remain private");
      assert.ok(!text.includes(JSON.stringify(secret).slice(1, -1)), "encoded object key must remain private");
    }
    assert.equal(renderError(loaded.serverFailures.bad, i18n), i18n.t("runtime.config.server.boolean", { name: "bad", field: "readOnly" }));
    assert.ok(!JSON.stringify(loaded).includes("value_954"));
    assert.ok(!JSON.stringify([listed, rejected, wire]).includes("value_954"));
  });
}
