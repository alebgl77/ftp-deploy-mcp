#!/usr/bin/env node
// ftp-deploy-mcp entry point.
//
// Default (no subcommand): start the MCP stdio server.
//   CRITICAL: in server mode, stdout carries ONLY JSON-RPC. Every diagnostic
//   goes to stderr (console.error).
// Subcommand `import-filezilla`: import FileZilla sites into ftp-servers.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, normalizeServer, insecureTransport, insecureRiskText } from "./config.js";
import { registerTools } from "./tools.js";
import { runImport } from "./filezilla.js";
import { createRedactor } from "./redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const VERSION = pkg.version;
const outputRedactor = createRedactor();
const E = (message) => console.error(outputRedactor.strictText(message));

// Minimal hand-rolled argv parsing.
function parseArgs(argv) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--file" || a === "--out") {
      opts.flags[a.slice(2)] = argv[++i];
    } else if (a === "--force") {
      opts.flags.force = true;
    } else if (a === "--help" || a === "-h") {
      opts.flags.help = true;
    } else if (a === "--version" || a === "-v") {
      opts.flags.version = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const USAGE = `ftp-deploy-mcp v${VERSION}
An MCP stdio server exposing FTP/FTPS/SFTP deploy tools to AI coding agents.

Usage:
  ftp-deploy-mcp [--config <path>]
      Start the MCP server on stdio (default). Configure your MCP client to run
      this command. Reads server definitions from (first found wins):
        --config <path>, $FTP_MCP_CONFIG,
        ./ftp-servers.json, ~/.ftp-mcp/servers.json

  ftp-deploy-mcp import-filezilla [--file <sitemanager.xml>] [--out <path>] [--force]
      Convert a FileZilla Site Manager export into ftp-servers.json.
      Without --out, prints the JSON to stdout.

  ftp-deploy-mcp setup [--yes] [--clients <all|none|id,id>] [--from-filezilla [path]]
                       [--config-dest <path>] [--skip-test] [--dry-run] [--force]
      Interactive one-command installer: build/import the server config, test
      connections, and write your MCP clients' config files automatically
      (Claude Code/Desktop, Cursor, Windsurf, Antigravity) with backups, plus a
      paste-ready block for Trae. --yes runs non-interactively.

  ftp-deploy-mcp doctor
      Read-only diagnostic: Node version, which config won, servers (no secrets),
      and per-client wiring status.

  ftp-deploy-mcp --version
  ftp-deploy-mcp --help
`;

async function startServer(configFlag) {
  const loaded = loadConfig(configFlag);
  outputRedactor.add(loaded.config);

  const configDesc = loaded.found
    ? loaded.error
      ? `${loaded.path} (ERROR)`
      : loaded.path
    : "none found";
  const serversDesc = loaded.serverNames.length ? loaded.serverNames.join(",") : "-";
  E(`ftp-deploy-mcp v${VERSION} — config: ${configDesc}, servers: ${serversDesc}`);
  if (loaded.error) {
    E(`ftp-deploy-mcp: configuration problem — ${loaded.error}`);
  }
  if (loaded.config) {
    for (const name of loaded.serverNames) {
      const s = normalizeServer(name, loaded.config.servers[name]);
      const reason = insecureTransport(s);
      if (!reason) continue;
      if (s.allowInsecure) {
        E(
          `ftp-deploy-mcp: ⚠ SECURITY WARNING — ${insecureRiskText(name, reason)}. ` +
            `Explicitly allowed by "allowInsecure": true — switch to sftp as soon as possible.`
        );
      } else {
        E(
          `ftp-deploy-mcp: ⚠ ${insecureRiskText(name, reason)}. ` +
            `Connections to this server will be REFUSED — switch it to sftp, or set "allowInsecure": true to accept the risk.`
        );
      }
    }
  }

  const server = new McpServer({ name: "ftp-deploy-mcp", version: VERSION });
  registerTools(server, loaded);

  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (code) => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  // When the client closes stdin, the session is over.
  process.stdin.on("close", () => shutdown(0));

  await server.connect(transport);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (opts.flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const sub = opts._[0];
  if (sub === "import-filezilla") {
    const code = runImport({
      file: opts.flags.file,
      out: opts.flags.out,
      force: opts.flags.force,
    });
    process.exitCode = code;
    return;
  }
  if (sub === "setup") {
    // Lazy-import so pure server startup never pulls in readline/adapters.
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(process.argv.slice(2));
    return;
  }
  if (sub === "doctor") {
    const { runDoctor } = await import("./setup.js");
    process.exitCode = await runDoctor(process.argv.slice(2));
    return;
  }
  if (sub) {
    E(`Unknown command: ${sub}`);
    E(USAGE);
    process.exitCode = 1;
    return;
  }

  await startServer(opts.flags.config);
}

main().catch((err) => {
  E(`ftp-deploy-mcp fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
