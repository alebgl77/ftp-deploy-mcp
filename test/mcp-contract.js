import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../src/tools.js";

const PIN = `SHA256:${Buffer.alloc(32, 11).toString("base64").replace(/=+$/, "")}`;
const SECRET = "contract-secret-never-return";

function loadedConfig(localRoot) {
  return {
    found: true,
    error: null,
    config: {
      defaultServer: "test",
      servers: {
        test: {
          protocol: "sftp",
          host: "test.invalid",
          user: "tester",
          password: SECRET,
          root: "/",
          localRoot,
          hostKeySha256: PIN,
        },
      },
    },
    serverNames: ["test"],
    invalidServerNames: [],
    serverErrors: {},
    defaultServer: "test",
  };
}

function resultText(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function resultBytes(result) {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function makeFiles(dir, count, prefix, longNames = false) {
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const suffix = longNames ? `-${"é🙂".repeat(18)}` : "";
    fs.writeFileSync(path.join(dir, `${prefix}-${String(index).padStart(3, "0")}${suffix}.txt`), `${index}`);
  }
}

async function withClient(loaded, openAdapter, run) {
  const server = new McpServer({ name: "ftp-contract-test", version: "1.0.0" });
  registerTools(server, loaded, { openAdapter });
  const client = new Client({ name: "ftp-contract-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

export async function runMcpContractTests({ root, ok, contains, notContains }) {
  fs.mkdirSync(root, { recursive: true });
  const uploadPath = path.join(root, "upload.txt");
  const downloadPath = path.join(root, "download.txt");
  const deployMany = path.join(root, "deploy-many");
  const deployMixed = path.join(root, "deploy-mixed");
  const deployEmpty = path.join(root, "deploy-empty");
  fs.writeFileSync(uploadPath, "upload");
  makeFiles(deployMany, 121, "ok");
  makeFiles(deployMixed, 210, "mix", true);
  fs.mkdirSync(deployEmpty, { recursive: true });

  const entries = Array.from({ length: 251 }, (_unused, index) => ({
    name: `entry-${String(index).padStart(3, "0")}.txt`,
    type: "file",
    size: index,
    modifiedAt: "2026-09-03T00:00:00.000Z",
    ignored_adapter_field: "must-not-be-projected",
  }));
  entries[0].name = `entry-${SECRET}.txt`;
  let mixedFailures = false;

  const openAdapter = async () => ({
    async list(remotePath) {
      if (remotePath === "/fail") throw new Error(`list failed with ${SECRET}`);
      if (remotePath === "/empty") return [];
      return entries.map((entry) => ({ ...entry }));
    },
    async readFile() {
      return { buffer: Buffer.from("🙂".repeat(30000)), truncated: false };
    },
    async uploadFile(localPath) {
      if (!mixedFailures) return;
      const match = /mix-(\d{3})/.exec(path.basename(localPath));
      if (match && Number(match[1]) % 2 === 1) throw new Error(`mixed failure ${match[1]} ${"é🙂".repeat(20)}`);
    },
    async downloadFile(_remotePath, localPath) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, "downloaded");
    },
    async mkdirp() {},
    async rename() {},
    async stat(remotePath) {
      return { type: remotePath.endsWith("delete-dir") ? "dir" : "file", size: 0 };
    },
    async deleteDir() {},
    async deleteFile() {},
    async close() {},
  });

  await withClient(loadedConfig(root), openAdapter, async (client) => {
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const expectedAnnotations = {
      ftp_list_servers: [true, false, true, false],
      ftp_test: [true, false, true, true],
      ftp_list: [true, false, true, true],
      ftp_read: [true, false, true, true],
      ftp_upload: [false, true, false, true],
      ftp_deploy: [false, true, false, true],
      ftp_download: [false, true, false, true],
      ftp_mkdir: [false, false, true, true],
      ftp_rename: [false, true, false, true],
      ftp_delete: [false, true, true, true],
    };
    for (const [name, values] of Object.entries(expectedAnnotations)) {
      const actual = tools.get(name).annotations || {};
      ok(
        actual.readOnlyHint === values[0] &&
          actual.destructiveHint === values[1] &&
          actual.idempotentHint === values[2] &&
          actual.openWorldHint === values[3],
        `MCP contract: ${name} exposes exact annotations`,
        JSON.stringify(actual)
      );
    }
    for (const name of [
      "ftp_list_servers",
      "ftp_test",
      "ftp_list",
      "ftp_upload",
      "ftp_deploy",
      "ftp_download",
      "ftp_mkdir",
      "ftp_rename",
      "ftp_delete",
    ]) {
      ok(tools.get(name).outputSchema && tools.get(name).outputSchema.type === "object", `MCP contract: ${name} advertises outputSchema`);
    }
    ok(!tools.get("ftp_read").outputSchema, "MCP contract: ftp_read deliberately has no outputSchema");
    ok(
      tools.get("ftp_list").inputSchema.properties.limit.maximum === 200 &&
        tools.get("ftp_list").inputSchema.properties.offset.minimum === 0,
      "MCP contract: ftp_list advertises pagination bounds"
    );

    const successes = [];
    successes.push(await client.callTool({ name: "ftp_list_servers", arguments: {} }));
    successes.push(await client.callTool({ name: "ftp_test", arguments: {} }));
    successes.push(await client.callTool({ name: "ftp_upload", arguments: { local_path: "upload.txt" } }));
    successes.push(await client.callTool({ name: "ftp_deploy", arguments: { local_dir: "deploy-empty" } }));
    successes.push(await client.callTool({ name: "ftp_download", arguments: { remote_path: "source.txt", local_path: "download.txt" } }));
    successes.push(await client.callTool({ name: "ftp_download", arguments: { remote_path: "source.txt", local_path: "download.txt", overwrite: true } }));
    successes.push(await client.callTool({ name: "ftp_mkdir", arguments: { path: "made" } }));
    successes.push(await client.callTool({ name: "ftp_rename", arguments: { from_path: "a", to_path: "b" } }));
    successes.push(await client.callTool({ name: "ftp_delete", arguments: { path: "delete-file" } }));
    successes.push(await client.callTool({ name: "ftp_delete", arguments: { path: "delete-dir", recursive: true } }));
    for (const result of successes) {
      ok(result.isError !== true && result.structuredContent, "MCP contract: schema-bearing success has structuredContent", resultText(result));
      ok(resultBytes(result) <= 25000, "MCP contract: success CallToolResult stays within 25,000 UTF-8 bytes", String(resultBytes(result)));
    }

    const firstPage = await client.callTool({ name: "ftp_list", arguments: { path: "", limit: 200 } });
    ok(
      firstPage.structuredContent.total === 251 &&
        firstPage.structuredContent.count === 200 &&
        firstPage.structuredContent.next_offset === 200 &&
        firstPage.structuredContent.has_more === true,
      "MCP contract: ftp_list returns the first 200/251 page",
      JSON.stringify(firstPage.structuredContent)
    );
    contains(resultText(firstPage), "Contents of / (251 entries):", "MCP contract: ftp_list preserves the historical header");
    contains(resultText(firstPage), "next offset 200", "MCP contract: ftp_list text announces the next offset");
    ok(resultBytes(firstPage) <= 25000, "MCP contract: 200-entry list result respects UTF-8 cap", String(resultBytes(firstPage)));
    ok(
      !Object.hasOwn(firstPage.structuredContent.entries[0], "ignored_adapter_field"),
      "MCP contract: ftp_list projects strict entry fields"
    );
    notContains(JSON.stringify(firstPage.structuredContent), SECRET, "MCP contract: structured list output is redacted");

    const secondPage = await client.callTool({ name: "ftp_list", arguments: { path: "", limit: 200, offset: 200 } });
    ok(
      secondPage.structuredContent.count === 51 &&
        secondPage.structuredContent.next_offset === null &&
        secondPage.structuredContent.has_more === false,
      "MCP contract: ftp_list returns the final 51-entry page",
      JSON.stringify(secondPage.structuredContent)
    );
    const outsidePage = await client.callTool({ name: "ftp_list", arguments: { path: "", offset: 999 } });
    ok(
      outsidePage.structuredContent.count === 0 && outsidePage.structuredContent.next_offset === null,
      "MCP contract: ftp_list normalizes an offset beyond the end",
      JSON.stringify(outsidePage.structuredContent)
    );
    const emptyPage = await client.callTool({ name: "ftp_list", arguments: { path: "empty" } });
    ok(emptyPage.structuredContent.total === 0 && emptyPage.structuredContent.entries.length === 0, "MCP contract: empty list success remains schema-conformant");

    const dryRun = await client.callTool({ name: "ftp_deploy", arguments: { local_dir: "deploy-many", dry_run: true } });
    ok(
      dryRun.structuredContent.mode === "dry_run" &&
        dryRun.structuredContent.total_files === 121 &&
        dryRun.structuredContent.planned.length === 100 &&
        dryRun.structuredContent.planned_omitted === 21,
      "MCP contract: large dry-run exposes bounded planned samples and counters",
      JSON.stringify(dryRun.structuredContent)
    );
    const deployed = await client.callTool({ name: "ftp_deploy", arguments: { local_dir: "deploy-many" } });
    ok(
      deployed.structuredContent.complete === true &&
        deployed.structuredContent.uploaded_count === 121 &&
        deployed.structuredContent.uploaded.length === 100 &&
        deployed.structuredContent.uploaded_omitted === 21,
      "MCP contract: large deploy exposes bounded uploaded samples and counters",
      JSON.stringify(deployed.structuredContent)
    );
    ok(resultBytes(deployed) <= 25000, "MCP contract: large deploy success respects UTF-8 cap", String(resultBytes(deployed)));

    mixedFailures = true;
    const mixed = await client.callTool({ name: "ftp_deploy", arguments: { local_dir: "deploy-mixed" } });
    ok(mixed.isError === true && !mixed.structuredContent, "MCP contract: mixed deploy failure has no structuredContent", resultText(mixed));
    contains(resultText(mixed), "Deployed 105/210", "MCP contract: mixed deploy text preserves aggregate counters");
    contains(resultText(mixed), "Failures (105)", "MCP contract: mixed deploy text preserves failure count");
    ok(resultBytes(mixed) <= 25000, "MCP contract: mixed UTF-8 deploy error respects 25,000-byte cap", String(resultBytes(mixed)));

    const failed = await client.callTool({ name: "ftp_list", arguments: { path: "fail" } });
    ok(failed.isError === true && !failed.structuredContent, "MCP contract: tool error never has structuredContent", resultText(failed));
    notContains(resultText(failed), SECRET, "MCP contract: error remains redacted");

    const read = await client.callTool({ name: "ftp_read", arguments: { path: "large.txt" } });
    ok(!read.structuredContent, "MCP contract: ftp_read result has no structuredContent");
    ok(resultBytes(read) <= 25000, "MCP contract: large ftp_read rendering respects UTF-8 cap", String(resultBytes(read)));
    contains(resultText(read), "File /large.txt", "MCP contract: capped ftp_read preserves its historical header");
  });

  const expandingConfig = loadedConfig(root);
  expandingConfig.config.servers.test.password = "a";
  const expandingEntries = Array.from({ length: 200 }, (_unused, index) => ({
    name: `${"a-".repeat(100)}${index}`,
    type: "file",
    size: index,
    modifiedAt: null,
  }));
  const expandingAdapter = async () => ({
    async list() {
      return expandingEntries.map((entry) => ({ ...entry }));
    },
    async close() {},
  });
  await withClient(expandingConfig, expandingAdapter, async (client) => {
    const result = await client.callTool({ name: "ftp_list", arguments: { limit: 200 } });
    const structured = result.structuredContent;
    ok(result.isError !== true && structured, "MCP contract: post-redaction cap keeps the list success schema");
    ok(resultBytes(result) <= 25000, "MCP contract: exact one-character secret expansion respects the full-result cap", String(resultBytes(result)));
    ok(
      structured.count === structured.entries.length &&
        structured.has_more === (structured.count < structured.total) &&
        structured.next_offset === (structured.has_more ? structured.count : null),
      "MCP contract: post-redaction list trimming keeps counters coherent",
      JSON.stringify(structured)
    );
    ok(
      resultText(result).startsWith("Contents of / (200 entries):"),
      "MCP contract: post-redaction cap preserves the historical list header"
    );
  });

  const insecureConfig = loadedConfig(root);
  Object.assign(insecureConfig.config.servers.test, {
    protocol: "ftp",
    port: 21,
    allowInsecure: true,
  });
  delete insecureConfig.config.servers.test.hostKeySha256;
  const failingInsecureAdapter = async () => ({
    async list() {
      throw new Error("untrusted adapter detail ".repeat(5000));
    },
    async close() {},
  });
  await withClient(insecureConfig, failingInsecureAdapter, async (client) => {
    const result = await client.callTool({ name: "ftp_list", arguments: {} });
    ok(result.isError === true && !result.structuredContent, "MCP contract: huge insecure adapter failure remains an unstructured MCP error");
    contains(resultText(result), "SECURITY WARNING", "MCP contract: huge insecure adapter failure preserves its warning prefix");
    ok(resultBytes(result) <= 25000, "MCP contract: huge insecure adapter failure respects the full-result cap", String(resultBytes(result)));
  });

  const smallEntries = [
    { name: "dir-a", type: "dir", size: 0, modifiedAt: null },
    { name: "file.txt", type: "file", size: 5, modifiedAt: null },
  ];
  const smallAdapter = async () => ({
    async list() {
      return smallEntries.map((entry) => ({ ...entry }));
    },
    async close() {},
  });
  await withClient(loadedConfig(root), smallAdapter, async (client) => {
    const historical = await client.callTool({ name: "ftp_list", arguments: {} });
    ok(
      resultText(historical) ===
        "Contents of / (2 entries):\n\n[DIR] dir-a\n[FILE] file.txt (5 B)",
      "MCP contract: default small ftp_list text remains exactly historical",
      resultText(historical)
    );
    const explicit = await client.callTool({ name: "ftp_list", arguments: { limit: 50 } });
    contains(resultText(explicit), "Page: offset 0, count 2, limit 50", "MCP contract: explicit pagination is announced for a small list");
  });

  const missing = {
    found: false,
    path: null,
    searched: [path.join(root, "missing.json")],
    error: null,
    config: null,
    serverNames: [],
    invalidServerNames: [],
    serverErrors: {},
    defaultServer: null,
  };
  await withClient(missing, openAdapter, async (client) => {
    const result = await client.callTool({ name: "ftp_list_servers", arguments: {} });
    ok(
      result.isError !== true &&
        result.structuredContent.status === "missing" &&
        result.structuredContent.configured_count === 0,
      "MCP contract: missing config list_servers success is normalized to its schema",
      JSON.stringify(result.structuredContent)
    );
  });

  const invalid = {
    ...missing,
    found: true,
    path: path.join(root, "invalid.json"),
    error: "Invalid configuration containing password=contract-secret",
    invalidServerNames: ["broken"],
    serverErrors: { broken: "Invalid server password=contract-secret" },
  };
  await withClient(invalid, openAdapter, async (client) => {
    const result = await client.callTool({ name: "ftp_list_servers", arguments: {} });
    ok(
      result.isError !== true &&
        result.structuredContent.status === "invalid" &&
        result.structuredContent.configured_count === 1 &&
        result.structuredContent.invalid_count === 1,
      "MCP contract: invalid config list_servers success is normalized to its schema",
      JSON.stringify(result.structuredContent)
    );
    notContains(JSON.stringify(result), SECRET, "MCP contract: invalid config structured output is redacted");
  });
}
