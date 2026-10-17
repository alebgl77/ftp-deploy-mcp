import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));

function fixture(durable = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-mcp-protocol-"));
  const localRoot = durable ? path.join(root, "local") : root;
  if (durable) fs.mkdirSync(localRoot);
  if (durable) fs.mkdirSync(path.join(root, "state"));
  const config = path.join(root, "ftp-servers.json");
  fs.writeFileSync(config, JSON.stringify({ ...(durable ? { stateDir: path.join(root, "state"), requirePlan: true } : {}), servers: { test: {
    protocol: "ftp", host: "127.0.0.1", port: 21, user: "user", password: "pass",
    localRoot, root: "/", readOnly: true, allowInsecure: true,
  } } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, FTP_MCP_CONFIG: config };
  delete env.NODE_OPTIONS;
  return { root, env };
}

async function connect(t, clientOptions, durable = false) {
  const { root, env } = fixture(durable);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: root, env, stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({ name: "protocol-compatibility-test", version: "1.0.0" }, clientOptions);
  t.after(async () => {
    await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.connect(transport, { timeout: 15000 });
  return client;
}

async function assertDurableContract(client) {
  const listed = await client.listTools({}, { timeout: 15000 });
  assert.equal(listed.tools.length, 14);
  for (const name of ["ftp_plan_deploy", "ftp_apply_deploy", "ftp_deploy_status", "ftp_rollback_deploy"]) {
    assert.ok(listed.tools.some((tool) => tool.name === name), name);
  }
}

async function assertPublicContract(client) {
  const listed = await client.listTools({}, { timeout: 15000 });
  assert.equal(listed.tools.length, 10);
  assert.deepEqual(listed.tools.map(({ name }) => name).sort(), [
    "ftp_delete", "ftp_deploy", "ftp_download", "ftp_list", "ftp_list_servers",
    "ftp_mkdir", "ftp_read", "ftp_rename", "ftp_test", "ftp_upload",
  ]);
  const servers = await client.callTool({ name: "ftp_list_servers", arguments: {} }, { timeout: 15000 });
  assert.notEqual(servers.isError, true);
  assert.equal(servers.structuredContent.configured_count, 1);
}

test("stdio negotiates the modern 2026-07-28 protocol revision", { timeout: 30000 }, async (t) => {
  const client = await connect(t, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  await assertPublicContract(client);
});

test("stdio remains compatible with an older 2024-11-05 client path", { timeout: 30000 }, async (t) => {
  const client = await connect(t, {
    supportedProtocolVersions: ["2024-11-05"], versionNegotiation: { mode: "legacy" },
  });
  assert.equal(client.getProtocolEra(), "legacy");
  assert.equal(client.getNegotiatedProtocolVersion(), "2024-11-05");
  await assertPublicContract(client);
});

test("durable configuration advertises 14 tools on the modern revision", { timeout: 30000 }, async (t) => {
  const client = await connect(t, { versionNegotiation: { mode: { pin: "2026-07-28" } } }, true);
  await assertDurableContract(client);
});

test("durable configuration advertises the same 14 tools to a legacy client", { timeout: 30000 }, async (t) => {
  const client = await connect(t, { supportedProtocolVersions: ["2024-11-05"], versionNegotiation: { mode: "legacy" } }, true);
  await assertDurableContract(client);
});
