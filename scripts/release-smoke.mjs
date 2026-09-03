import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readRelease } from "./release-gate.mjs";

// The installation directory is created by the workflow, outside the checkout.
const { release } = readRelease();
assert.equal(process.argv.length, 3, "Usage: node scripts/release-smoke.mjs <isolated-install>");
const root = path.resolve(process.argv[2]);
const packageRoot = path.join(root, "node_modules", release.name);
const entry = path.join(packageRoot, "src", "index.js");
const installed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
for (const key of ["name", "version", "mcpName"]) assert.equal(installed[key], release[key], `Installed ${key} mismatch`);
assert.equal(execFileSync(process.execPath, [entry, "--version"], { cwd: root, encoding: "utf8", timeout: 15000 }).trim(), release.version);
assert.match(execFileSync(process.execPath, [entry, "--help"], { cwd: root, encoding: "utf8", timeout: 15000 }), /Usage:/);

// Resolve the client from the installation too: no dependency on checkout files.
const requireInstalled = createRequire(path.join(packageRoot, "package.json"));
const { Client } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
const fixtureRoot = path.join(root, "fixture");
mkdirSync(fixtureRoot);
writeFileSync(path.join(fixtureRoot, "smoke.txt"), "isolated release smoke\n", { flag: "wx" });
const config = path.join(root, "smoke-config.json");
writeFileSync(config, JSON.stringify({
  defaultServer: "release-smoke",
  servers: {
    "release-smoke": {
      protocol: "sftp", host: "127.0.0.1", port: 1, user: "fixture", password: "fixture-only",
      root: "/", localRoot: fixtureRoot, readOnly: true,
      hostKeySha256: `SHA256:${Buffer.alloc(32, 7).toString("base64").replace(/=+$/, "")}`,
    },
  },
}), { flag: "wx", mode: 0o600 });

const client = new Client({ name: "release-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--config", config], cwd: root, stderr: "pipe" });
// Drain diagnostics without ever printing potential configuration content.
transport.stderr?.resume();
try {
  await client.connect(transport, { timeout: 15000 });
  assert.equal(client.getServerVersion()?.version, release.version, "MCP runtime version mismatch");
  const tools = await client.listTools({}, { timeout: 15000 });
  assert.ok(tools.tools.some((tool) => tool.name === "ftp_deploy"));
  const servers = await client.callTool({ name: "ftp_list_servers", arguments: {} }, undefined, { timeout: 15000 });
  assert.notEqual(servers.isError, true, "Installed list-servers failed");
  const dryRun = await client.callTool({ name: "ftp_deploy", arguments: { local_dir: ".", dry_run: true } }, undefined, { timeout: 15000 });
  assert.notEqual(dryRun.isError, true, "Installed dry-run failed");
  assert.equal(dryRun.structuredContent?.mode, "dry_run");
  console.log(`Installed artifact smoke passed: ${release.name}@${release.version} (no remote connection)`);
} finally {
  await client.close();
  await transport.close();
}
