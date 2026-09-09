import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { scenarios } from "./scenarios.mjs";
import { verifyMetadata, verifyBusinessSample } from "./localization.mjs";
import { inside, localSnapshot, MemoryRemote, MUTATORS, TEST_SECRET } from "./fixture.mjs";

const [repo, caseRoot, id, locale, probe = "", verifyLocale = "false"] = process.argv.slice(2);
const started = performance.now();
const scenario = scenarios.find((item) => item.id === id);
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error("FIXTURE_NETWORK_DISABLED"); };
net.Socket.prototype.connect = denyNetwork;
net.connect = denyNetwork;
net.createConnection = denyNetwork;
http.request = denyNetwork;
https.request = denyNetwork;
globalThis.fetch = denyNetwork;

const report = {
  schema_version: 1, scenarioID: id, locale, scenario_locale: locale, requested_locale: locale, runtime_locale_verified: false,
  pre_connection_refusal: scenario?.pre_connection_refusal ?? null, connections_opened: 0,
  status: "FAIL", executor: "scripted", agentDecision: "NOT_EVALUATED",
  title: scenario?.title, relatedSpecIDs: scenario?.relatedSpecIDs ?? [], source: scenario?.source,
  scopeNote: scenario?.scopeNote ?? null, assertions: [], failureCode: null,
  mutationAttempts: 0, effectsCount: 0, mutationMetricScope: "remote adapter journal only",
  localAdapterWriteCount: 0, localTerminalChangeCount: null, mcpMutatorCallAttempts: 0,
  metrics: { durationMs: null, listToolsCalls: 0, listToolsResultJsonBytes: null, toolCalls: 0, requestJsonBytes: 0, responseJsonBytes: 0, wireJsonBytes: { clientToServer: 0, serverToClient: 0 }, wireMessages: { clientToServer: 0, serverToClient: 0 }, transferBytes: { upload: 0, download: 0, verificationRead: 0, textRead: 0 }, tokens: null, providerUsage: null },
  negotiatedProtocolVersion: null, advertisedToolIDs: [], networkAttempts: 0,
  localizationEvidence: { requested: verifyLocale === "true", metadataVerified: false, successSamples: [], errorSamples: [] },
};
class AssertionFailure extends Error {}
class PreconditionFailure extends Error {}
class UnsupportedFixture extends Error {}
let client;
let server;
let c;
try {
  if (!scenario || !["en", "fr"].includes(locale) || !fs.statSync(caseRoot).isDirectory()) throw new PreconditionFailure("RUN_ARGUMENTS");
  const require = createRequire(path.join(repo, "package.json"));
  const sdkImport = (specifier) => import(pathToFileURL(require.resolve(specifier)).href);
  const [{ McpServer }, { Client }, { InMemoryTransport }, { registerTools }, { loadConfig }, primitives, { createI18n, CATALOGS }] = await Promise.all([
    sdkImport("@modelcontextprotocol/sdk/server/mcp.js"), sdkImport("@modelcontextprotocol/sdk/client/index.js"), sdkImport("@modelcontextprotocol/sdk/inMemory.js"),
    import(pathToFileURL(path.join(repo, "src/tools.js")).href), import(pathToFileURL(path.join(repo, "src/config.js")).href),
    import(pathToFileURL(path.join(repo, "src/transfers.js")).href), import(pathToFileURL(path.join(repo, "src/i18n.js")).href),
  ]);
  const catalogs = probe === "missing-localization-catalog" ? { en: {}, fr: {} } : CATALOGS;
  if (verifyLocale === "true" && (!catalogs.en["mcp.ftp_upload.title"] || !catalogs.fr["error.result"])) throw new PreconditionFailure("LOCALIZATION_CATALOG_MISSING");
  const selectedI18n = createI18n(locale);
  const localRoot = path.join(caseRoot, "local");
  const outsideRoot = path.join(caseRoot, "outside");
  fs.mkdirSync(localRoot, { recursive: true }); fs.mkdirSync(outsideRoot, { recursive: true });
  const journal = [];
  const primary = new MemoryRemote("primary", journal);
  const sourceBytes = Buffer.from("TEST_ONLY source bytes\n");
  const priorBytes = Buffer.from("TEST_ONLY prior target\n");
  primary.seed("/target.txt", priorBytes);
  const configuration = { defaultServer: "alpha", servers: { alpha: {
    protocol: "sftp", host: "primary.evaluation.invalid", port: 22, user: "TEST_ONLY_user", password: TEST_SECRET,
    root: "/", localRoot, hostKeySha256: "SHA256:" + Buffer.alloc(32, 7).toString("base64").replace(/=+$/, ""), operationTimeoutMs: 3000,
  } } };
  const endpoints = new Map([["alpha", primary]]);
  let toolListComplete = false;
  c = {
    caseRoot, caseID: id, localRoot, outsideRoot, primary, configuration, entry: configuration.servers.alpha, journal, sourceBytes, priorBytes,
    calls: [], tools: [], beforeRemote: new Map(),
    localPath: (file) => inside(caseRoot, path.resolve(localRoot, file)),
    outsidePath: (file) => inside(outsideRoot, path.resolve(outsideRoot, file)),
    write(file, bytes) { const target = this.localPath(file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); },
    addSecondary() {
      this.configuration.servers.beta = { ...this.entry, host: "secondary.evaluation.invalid" };
      this.secondary = new MemoryRemote("secondary", journal);
      this.secondary.seed("/target.txt", priorBytes);
      endpoints.set("beta", this.secondary);
    },
    linkOutside(name) {
      try { fs.symlinkSync(outsideRoot, this.localPath(name), process.platform === "win32" ? "junction" : "dir"); }
      catch (error) { if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw new UnsupportedFixture("SYMLINK_UNAVAILABLE"); throw error; }
    },
    check(assertionID, label, passed, observed = passed, expected = true) {
      if (probe === "assertion-failure" && report.assertions.length === 0) { passed = false; observed = false; }
      if (!["boolean", "number"].includes(typeof observed) || !["boolean", "number"].includes(typeof expected)) throw new PreconditionFailure("UNSAFE_ASSERTION_DATA");
      report.assertions.push({ assertionID: `${assertionID}-${report.assertions.length + 1}`, label, passed: passed === true, observed, expected, observationType: "evaluated predicate with scalar evidence" });
      if (passed !== true) throw new AssertionFailure("ASSERTION_FAILED");
    },
    tool(name) { return this.tools.find((item) => item.name === name); },
    async call(name, args) {
      if (!toolListComplete) throw new PreconditionFailure("LIST_TOOLS_REQUIRED");
      if (!this.tools.some((tool) => tool.name === name)) throw new PreconditionFailure("UNADVERTISED_TOOL");
      if (this.calls.length >= 8) throw new PreconditionFailure("SCENARIO_CALL_BUDGET");
      const request = { name, arguments: args };
      const marker = { tool: name, kind: null };
      this.calls.push(marker);
      report.metrics.toolCalls++;
      report.metrics.requestJsonBytes += Buffer.byteLength(JSON.stringify(request), "utf8");
      if (MUTATORS.has(name)) report.mcpMutatorCallAttempts++;
      let result;
      try {
        result = await client.callTool(request);
      } catch (error) {
        if (error instanceof AssertionFailure || error instanceof PreconditionFailure) throw error;
        // Keep the rejected response in memory only. No message/content is copied
        // into the report; wire byte counters still measure received SDK frames.
        marker.kind = "sdk-rejection";
        return { kind: "sdk-rejection", error };
      }
      const jsonBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      report.metrics.responseJsonBytes += jsonBytes;
      marker.kind = result.isError === true ? "error-result" : "success-result";
      const outcome = { kind: "response", result, jsonBytes };
      // Harness/localization failures are not SDK rejections and must propagate.
      if (verifyLocale === "true") verifyBusinessSample(this, selectedI18n, name, args, outcome, report.localizationEvidence);
      return outcome;
    },
  };
  c.write("source.txt", sourceBytes); c.write("deploy/public.txt", "xx"); fs.writeFileSync(c.outsidePath("outside.txt"), "TEST_ONLY outside");
  scenario.configure(c);
  const configPath = path.join(caseRoot, "servers.json");
  if (c.configMode === "sensitive-invalid-json") fs.writeFileSync(configPath, c.configText);
  else if (c.configMode === "invalid-json" || probe === "invalid-fixture-config") fs.writeFileSync(configPath, "{ TEST_ONLY invalid JSON");
  else if (c.configMode !== "missing") fs.writeFileSync(configPath, JSON.stringify(configuration));
  const loaded = loadConfig(configPath);
  if (!scenario.expectedInvalidConfig && (!loaded.config || loaded.error)) throw new PreconditionFailure("FIXTURE_CONFIG_INVALID");
  if (scenario.expectedInvalidConfig && loaded.config) throw new PreconditionFailure("EXPECTED_INVALID_CONFIG_ACCEPTED");
  const beforeLocal = localSnapshot(caseRoot);
  for (const remote of endpoints.values()) c.beforeRemote.set(remote.id, remote.snapshot());
  server = new McpServer({ name: "scripted-evaluation-fixture", version: "1.0.0" });
  registerTools(server, loaded, {
    i18n: selectedI18n,
    openAdapter: async (normalizedServer, operation) => {
      const remote = endpoints.get(normalizedServer.name);
      if (!remote || normalizedServer.host !== configuration.servers[normalizedServer.name].host) throw new PreconditionFailure("FIXTURE_ENDPOINT_UNKNOWN");
      return remote.adapter(normalizedServer, operation, { ...primitives, caseRoot });
    },
  });
  client = new Client({ name: "scripted-evaluation-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  for (const [transport, direction] of [[clientTransport, "clientToServer"], [serverTransport, "serverToClient"]]) {
    const send = transport.send.bind(transport);
    transport.send = async (message, ...args) => {
      report.metrics.wireJsonBytes[direction] += Buffer.byteLength(JSON.stringify(message), "utf8");
      report.metrics.wireMessages[direction]++;
      if (typeof message.result?.protocolVersion === "string") report.negotiatedProtocolVersion = message.result.protocolVersion;
      return send(message, ...args);
    };
  }
  await server.connect(serverTransport); await client.connect(clientTransport);
  const listed = await client.listTools(); report.metrics.listToolsCalls++;
  report.metrics.listToolsResultJsonBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
  if (!Array.isArray(listed.tools) || listed.tools.length !== 10) throw new PreconditionFailure("TOOL_INVENTORY_MISMATCH");
  c.tools = listed.tools; toolListComplete = true;
  report.advertisedToolIDs = listed.tools.map((tool) => tool.name).sort();
  if (verifyLocale === "true") verifyMetadata(c, selectedI18n, CATALOGS, report.localizationEvidence);
  if (probe === "deadline") { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (probe === "unavailable-fixture") throw new UnsupportedFixture("TEST_FIXTURE_UNAVAILABLE");
  await scenario.run(c);
  if (!report.assertions.length) throw new PreconditionFailure("NO_ASSERTIONS");
  c.check("network-denied", { en: "No network connection was attempted", fr: "Aucune connexion réseau n’a été tentée" }, networkAttempts === 0, networkAttempts, 0);
  const afterLocal = localSnapshot(caseRoot);
  const before = new Map(beforeLocal.map((entry) => [entry[0], JSON.stringify(entry)]));
  const after = new Map(afterLocal.map((entry) => [entry[0], JSON.stringify(entry)]));
  report.localTerminalChangeCount = [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).length;
  report.status = "PASS";
  report.runtime_locale_verified = report.localizationEvidence.metadataVerified && (report.localizationEvidence.successSamples.length + report.localizationEvidence.errorSamples.length > 0);
} catch (error) {
  if (error instanceof UnsupportedFixture) { report.status = "NOT_RUN"; report.failureCode = error.message; }
  else { report.status = "FAIL"; report.failureCode = error instanceof AssertionFailure ? "ASSERTION_FAILED" : error instanceof PreconditionFailure ? error.message : "HARNESS_OR_RUNTIME_EXCEPTION"; }
} finally {
  try { await client?.close(); await server?.close(); }
  catch { report.status = "FAIL"; report.failureCode = "SDK_CLEANUP_FAILED"; }
  const journal = c?.journal ?? [];
  report.mutationAttempts = journal.filter((event) => event.actor === "sut" && event.kind === "attempt").length;
  report.connections_opened = journal.filter((event) => event.method === "connect").length;
  report.effectsCount = journal.filter((event) => event.actor === "sut" && event.kind === "effect").length;
  report.localAdapterWriteCount = journal.filter((event) => event.kind === "local_adapter_write").length;
  report.metrics.transferBytes.upload = journal.filter((event) => event.kind === "bytes" && event.method === "uploadFile").reduce((sum, event) => sum + event.bytes, 0);
  report.metrics.transferBytes.download = journal.filter((event) => event.kind === "bytes" && event.method === "downloadFile").reduce((sum, event) => sum + event.bytes, 0);
  report.metrics.transferBytes.verificationRead = journal.filter((event) => event.kind === "bytes" && event.method === "hashFile").reduce((sum, event) => sum + event.bytes, 0);
  report.metrics.transferBytes.textRead = journal.filter((event) => event.kind === "bytes" && event.method === "readFile").reduce((sum, event) => sum + event.bytes, 0);
  report.networkAttempts = networkAttempts;
  report.metrics.durationMs = performance.now() - started;
  // Per-operation counts are safe aggregates; paths, messages, credentials,
  // payloads and the raw fixture journal never leave this process.
  report.remoteEffectsByMethod = Object.fromEntries([...new Set(journal.filter((e) => e.kind === "effect").map((e) => e.method))].map((method) => [method, journal.filter((e) => e.kind === "effect" && e.method === method).length]));
  process.stdout.write(JSON.stringify(report));
  process.exitCode = report.status === "FAIL" ? 1 : 0;
}
