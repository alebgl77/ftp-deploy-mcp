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

import { loadConfig, normalizeServer, insecureTransport, configRedactor } from "./config.js";
import { registerTools } from "./tools.js";
import { runImport } from "./filezilla.js";
import { createRedactor } from "./redact.js";
import { createI18n, extractLanguage } from "./i18n.js";
import { isAppError, renderError } from "./errors.js";
import { withZeroCancellation } from "./zero-cancellation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const VERSION = pkg.version;
let outputRedactor = createRedactor();
const E = (message) => console.error(outputRedactor.strictText(message));

// Minimal hand-rolled argv parsing.
function parseArgs(argv, t) {
  const opts = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--file" || a === "--out") {
      if (a === "--config" && (argv[i + 1] === undefined || argv[i + 1].startsWith("-"))) {
        throw new Error(t("cli.configPath"));
      }
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

async function startServer(configFlag, i18n) {
  const { t } = i18n;
  const loaded = loadConfig(configFlag);
  outputRedactor = configRedactor(loaded);

  const configDesc = loaded.found
    ? loaded.error
      ? t("cli.configError", { path: loaded.path })
      : loaded.path
    : t("cli.noneFound");
  const serversDesc = loaded.serverNames.length ? loaded.serverNames.join(",") : "-";
  E(t("cli.started", { version: VERSION, config: configDesc, servers: serversDesc }));
  if (loaded.error) {
    E(t("cli.configProblem", { error: loaded.failure ? renderError(loaded.failure, i18n) : loaded.error }));
  }
  if (loaded.config) {
    for (const name of loaded.serverNames) {
      const s = normalizeServer(name, loaded.config.servers[name]);
      const reason = insecureTransport(s);
      if (!reason) continue;
      const risk = t(reason === "plain-ftp" ? "security.ftpRisk" : "security.tlsRisk", { name });
      if (s.allowInsecure) {
        E(t("cli.allowed", { risk }));
      } else {
        E(t("cli.refused", { risk }));
      }
    }
  }

  const server = new McpServer({ name: "ftp-deploy-mcp", version: VERSION });
  const transport = withZeroCancellation(new StdioServerTransport());
  registerTools(server, loaded, { i18n, transportContext: transport });

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

async function run(argv, i18n) {
  const { t } = i18n;
  const opts = parseArgs(argv, t);

  if (opts.flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (opts.flags.help) {
    const help = { setup: "help.setup", doctor: "help.doctor", "import-filezilla": "help.import" }[opts._[0]] ?? "help.main";
    process.stdout.write(t(help, { version: VERSION }));
    return;
  }

  const sub = opts._[0];
  if (sub === "import-filezilla") {
    const code = runImport({
      file: opts.flags.file,
      out: opts.flags.out,
      force: opts.flags.force,
    }, undefined, i18n);
    process.exitCode = code;
    return;
  }
  if (sub === "setup") {
    // Lazy-import so pure server startup never pulls in readline/adapters.
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(argv, i18n);
    return;
  }
  if (sub === "doctor") {
    const { runDoctor } = await import("./setup.js");
    process.exitCode = await runDoctor(argv, i18n);
    return;
  }
  if (sub) {
    E(t("cli.unknown", { command: sub }));
    E(t("help.main", { version: VERSION }));
    process.exitCode = 1;
    return;
  }

  await startServer(opts.flags.config, i18n);
}

async function main() {
  let i18n = createI18n(process.env.FTP_MCP_LANG === "fr" ? "fr" : "en");
  try {
    const selected = extractLanguage(process.argv.slice(2));
    i18n = createI18n(selected.locale);
    await run(selected.argv, i18n);
  } catch (err) {
    E(i18n.t("cli.fatal", { error: isAppError(err) ? renderError(err, i18n) : err && err.stack ? err.stack : err }));
    process.exitCode = 1;
  }
}
void main();
