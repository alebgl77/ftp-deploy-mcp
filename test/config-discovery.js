import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { configCandidates, loadConfig } from "../src/config.js";

const entryPoint = fileURLToPath(new URL("../src/index.js", import.meta.url));

export async function runConfigDiscoveryTests({ root, ok }) {
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, ".ftp-mcp"), { recursive: true });
  const writeConfig = (file, name) => {
    fs.writeFileSync(file, JSON.stringify({ servers: {
      [name]: { protocol: "sftp", host: "test.invalid", user: "tester", password: "config-test-secret" },
    } }));
    return file;
  };
  const cwdFile = writeConfig(path.join(cwd, "ftp-servers.json"), "cwd");
  const homeFile = writeConfig(path.join(home, ".ftp-mcp", "servers.json"), "home");
  const envFile = writeConfig(path.join(root, "env.json"), "env");
  const cliFile = writeConfig(path.join(root, "cli.json"), "cli");
  const spacedFile = writeConfig(path.join(root, " spaced config.json"), "spaces");
  const invalidFile = path.join(root, "invalid.json");
  const missingFile = path.join(root, "missing.json");
  fs.writeFileSync(invalidFile, "{ invalid json");
  const saved = {
    cwd: process.cwd(), env: process.env.FTP_MCP_CONFIG, homedir: os.homedir,
    statSync: fs.statSync, readFileSync: fs.readFileSync,
  };
  const reads = [];
  const stats = [];
  try {
    process.chdir(cwd);
    os.homedir = () => home;
    fs.readFileSync = (file, ...args) => {
      reads.push(file);
      return saved.readFileSync(file, ...args);
    };
    fs.statSync = (file, ...args) => {
      stats.push(file);
      return saved.statSync(file, ...args);
    };
    const rejectsExplicit = (flag, label, expectedPath) => {
      reads.length = 0;
      stats.length = 0;
      const loaded = loadConfig(flag);
      ok(loaded.found && loaded.error && loaded.config === null && loaded.serverNames.length === 0,
        `config selection: ${label} reports an unusable explicit configuration`, loaded.error);
      ok(!reads.includes(cwdFile) && !reads.includes(homeFile) && !reads.includes(envFile) &&
        !stats.includes(cwdFile) && !stats.includes(homeFile) && !stats.includes(envFile),
      `config selection: ${label} never probes or reads a fallback`);
      ok(expectedPath ? loaded.path === expectedPath && loaded.searched.length === 1 &&
        loaded.searched[0] === expectedPath : loaded.path === null && loaded.searched.length === 0,
      `config selection: ${label} records only its explicit candidate`);
    };

    process.env.FTP_MCP_CONFIG = envFile;
    rejectsExplicit(missingFile, "missing CLI path with valid env/CWD/home", missingFile);
    rejectsExplicit(root, "directory CLI path", root);
    rejectsExplicit(invalidFile, "invalid JSON CLI path", invalidFile);
    for (const flag of ["", false, 42, {}, []]) {
      rejectsExplicit(flag, `invalid CLI selector ${JSON.stringify(flag)}`, null);
    }
    ok(loadConfig(cliFile).serverNames[0] === "cli" && configCandidates(cliFile).length === 1,
      "config selection: valid CLI path takes priority over valid env");
    ok(loadConfig(spacedFile).serverNames[0] === "spaces",
      "config selection: explicit paths preserve significant spaces");
    ok(loadConfig(null).serverNames[0] === "env", "config selection: null CLI selector uses explicit env");
    process.env.FTP_MCP_CONFIG = missingFile;
    rejectsExplicit(undefined, "missing env path with valid CWD/home", missingFile);
    process.env.FTP_MCP_CONFIG = "";
    rejectsExplicit(undefined, "empty env selector", null);
    ok(loadConfig(cliFile).serverNames[0] === "cli", "config selection: valid CLI overrides empty env");
    process.env.FTP_MCP_CONFIG = envFile;
    for (const operation of ["statSync", "readFileSync"]) {
      const original = fs[operation];
      try {
        fs[operation] = (file, ...args) => {
          if (file === cliFile) throw Object.assign(new Error(`EACCES: denied ${operation}`), { code: "EACCES" });
          return original(file, ...args);
        };
        rejectsExplicit(cliFile, `explicit ${operation} EACCES`, cliFile);
      } finally {
        fs[operation] = original;
      }
    }

    delete process.env.FTP_MCP_CONFIG;
    ok(JSON.stringify(configCandidates()) === JSON.stringify([cwdFile, homeFile]),
      "config selection: absent selectors discover CWD then home");
    ok(loadConfig().serverNames[0] === "cwd", "config selection: implicit discovery prefers CWD");
    fs.renameSync(cwdFile, `${cwdFile}.saved`);
    try {
      ok(loadConfig().serverNames[0] === "home", "config selection: implicit discovery falls back to home");
    } finally {
      fs.renameSync(`${cwdFile}.saved`, cwdFile);
    }
    const originalStat = fs.statSync;
    fs.statSync = (file, ...args) => {
      if (file === cwdFile) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return originalStat(file, ...args);
    };
    ok(loadConfig().serverNames[0] === "home", "config selection: implicit discovery still skips inaccessible CWD");
  } finally {
    process.chdir(saved.cwd);
    os.homedir = saved.homedir;
    fs.statSync = saved.statSync;
    fs.readFileSync = saved.readFileSync;
    if (saved.env === undefined) delete process.env.FTP_MCP_CONFIG;
    else process.env.FTP_MCP_CONFIG = saved.env;
  }

  const env = { ...process.env, FTP_MCP_CONFIG: envFile };
  for (const args of [["--config"], ["--config", "--help"], ["--config", "-v"]]) {
    const child = spawnSync(process.execPath, [entryPoint, ...args], { cwd, env, encoding: "utf8", timeout: 10000 });
    ok(child.status === 1 && child.stdout === "" && child.stderr.includes("--config requires a path value"),
      `config selection: CLI rejects ${args.join(" ")} before discovery`, child.stderr);
  }
  const client = new Client({ name: "config-selection-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entryPoint, "--config", missingFile], cwd, env, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    ok(tools.tools.length === 10, "config selection: invalid explicit CLI path keeps all MCP tools available");
    const listed = await client.callTool({ name: "ftp_list_servers", arguments: {} });
    ok(listed.isError !== true && listed.structuredContent.status === "invalid" &&
      listed.structuredContent.configured_count === 0 && listed.structuredContent.servers.length === 0,
    "config selection: real MCP server rejects missing CLI file despite valid env and CWD");
    const refused = await client.callTool({ name: "ftp_test", arguments: {} });
    ok(refused.isError === true && stderr.includes("configuration problem"),
      "config selection: invalid explicit path refuses operations and exposes diagnostics");
  } finally {
    await client.close();
    await transport.close();
  }
}
