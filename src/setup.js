// One-command installer / wizard (`setup`) and a read-only diagnostic
// (`doctor`). Lazy-imported by index.js so the pure MCP server startup stays
// lean (this file pulls in readline, the adapters and clients.js).
//
// Everything a test drives goes through --yes (non-interactive). The
// interactive path uses node:readline/promises with sane defaults; Ctrl+C is a
// clean abort. --home isolates ALL filesystem access (client detection, config
// destination, FileZilla lookup) under one directory and disables external
// CLIs (clipboard) so tests never touch the real machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";

import {
  configCandidates,
  normalizeServer,
  insecureTransport,
  insecureLabel,
  unsafeRemoteRoot,
  unsafeRemoteRootBlockedMessage,
  unsafeRemoteRootWarningText,
  unknownHostKeyBlockedMessage,
  unknownHostKeyWarningText,
  isValidHostKeySha256,
} from "./config.js";
import { parseSiteManager, buildConfig } from "./filezilla.js";
import { resolveRemote } from "./remote-path.js";
import { getClients, buildEntry, applyClient, mergeConfigFile } from "./clients.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { createRedactor } from "./redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to THIS package's src/index.js, resolved from our own module
// URL (not cwd), forward-slashed even on Windows.
function getAbsIndexJs() {
  return path.join(__dirname, "index.js").replace(/\\/g, "/");
}

function forwardSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function nonEmpty(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function nodeMajor() {
  const m = /^v?(\d+)/.exec(process.version || "");
  return m ? Number(m[1]) : 0;
}

// ---- argv ------------------------------------------------------------------

// Hand-rolled parser for the setup/doctor flags. `argv` is process.argv.slice(2)
// (may lead with the "setup"/"doctor" token, which we skip).
export function parseSetupArgs(argv) {
  const o = {
    yes: false,
    clients: null,
    fromFilezilla: null,
    fromFilezillaGiven: false,
    configDest: null,
    home: null,
    skipTest: false,
    dryRun: false,
    force: false,
  };
  const args = argv[0] === "setup" || argv[0] === "doctor" ? argv.slice(1) : argv.slice(0);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--yes":
      case "-y":
        o.yes = true;
        break;
      case "--force":
        o.force = true;
        break;
      case "--skip-test":
        o.skipTest = true;
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--clients":
        o.clients = args[++i];
        break;
      case "--config-dest":
        o.configDest = args[++i];
        break;
      case "--home":
        o.home = args[++i];
        break;
      case "--from-filezilla":
        o.fromFilezillaGiven = true;
        // Optional path: consume the next token only if it is not another flag.
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) o.fromFilezilla = args[++i];
        break;
      default:
        // ignore unknown tokens / positionals
        break;
    }
  }
  return o;
}

// ---- context ---------------------------------------------------------------

// Build the client-detection context. When `isolated` (--home given), appData
// is pinned UNDER home so nothing outside home is ever read or written.
function buildCtx(home, isolated) {
  const appData = isolated
    ? path.join(home, "AppData", "Roaming")
    : process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return { home, platform: process.platform, appData };
}

// FileZilla default sitemanager.xml locations, derived from ctx so --home
// isolation applies.
function fileZillaDefaultPaths(ctx) {
  const paths = [];
  if (ctx.platform === "win32") {
    paths.push(path.join(ctx.appData, "FileZilla", "sitemanager.xml"));
  }
  paths.push(path.join(ctx.home, ".config", "filezilla", "sitemanager.xml"));
  return paths;
}

function firstExistingFile(candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ---- config source ---------------------------------------------------------

// Import a FileZilla sitemanager.xml into a config object.
//   pathOrNull null -> search the default locations (ctx-aware)
// Returns { config, warnings, sourceFile } or { error }.
function importFileZilla(pathOrNull, ctx) {
  const file = pathOrNull ? path.resolve(pathOrNull) : firstExistingFile(fileZillaDefaultPaths(ctx));
  if (!file) {
    return { error: "no FileZilla sitemanager.xml found at the default location" };
  }
  const xml = safeRead(file);
  if (xml == null) return { error: `cannot read ${file}` };
  const parsed = parseSiteManager(xml);
  if (Object.keys(parsed.servers).length === 0) {
    return { error: `no importable servers found in ${file}` };
  }
  return { config: buildConfig(parsed), warnings: parsed.warnings, sourceFile: file };
}

// Find an existing config with >=1 server. In isolated mode ONLY the given
// configDest is consulted (never the real cwd/home/env).
function findExistingConfig(ctx, isolated, configDest) {
  const candidates = isolated ? [configDest] : configCandidates();
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || !fs.statSync(c).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(c, "utf8"));
      if (parsed && parsed.servers && Object.keys(parsed.servers).length >= 1) {
        return { path: c, config: parsed };
      }
    } catch {
      /* skip unreadable/unparseable candidate */
    }
  }
  return null;
}

// Write the config to dest. If dest exists, merge servers BY NAME: existing
// entries win, incoming duplicates are skipped (never overwrite credentials).
// Returns { path, finalConfig, skipped: [names], wrote }.
function writeConfigDest(destPath, newConfig, { dryRun, platform }) {
  const dir = path.dirname(destPath);
  const skipped = [];
  let finalConfig = newConfig;
  const destExists = fs.existsSync(destPath);

  if (destExists) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(destPath, "utf8"));
    } catch {
      existing = null;
    }
    if (existing && existing.servers && typeof existing.servers === "object") {
      const mergedServers = { ...existing.servers };
      for (const [name, srv] of Object.entries(newConfig.servers || {})) {
        if (Object.prototype.hasOwnProperty.call(mergedServers, name)) {
          skipped.push(name);
          continue;
        }
        mergedServers[name] = srv;
      }
      finalConfig = { ...existing, servers: mergedServers };
      if (
        !finalConfig.defaultServer &&
        newConfig.defaultServer &&
        mergedServers[newConfig.defaultServer]
      ) {
        finalConfig.defaultServer = newConfig.defaultServer;
      }
    }
  }

  const json = JSON.stringify(finalConfig, null, 2) + "\n";
  const result = { path: destPath, finalConfig, skipped, wrote: false };
  if (dryRun) return result;

  if (destExists && safeRead(destPath) === json) return result; // unchanged

  atomicWriteFileSync(destPath, json, { _platform: platform });
  result.wrote = true;
  return result;
}

// ---- connection tests ------------------------------------------------------

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "timed out")), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
}

// Env-placeholder var names still present (and unset) in a server entry.
function unresolvedEnvVars(srv) {
  const names = new Set();
  const re = /\$\{ENV:([^}]+)\}/g;
  const walk = (v) => {
    if (typeof v === "string") {
      let m;
      while ((m = re.exec(v)) !== null) {
        const name = m[1].trim();
        if (process.env[name] === undefined) names.add(name);
      }
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(srv);
  return [...names];
}

async function testOneServer(name, srv) {
  const normalized = normalizeServer(name, srv);
  const mod =
    normalized.protocol === "sftp"
      ? await import("./adapters/sftp.js")
      : await import("./adapters/ftp.js");
  let adapter = null;
  const budget = 10000;
  const start = Date.now();
  try {
    adapter = await withTimeout(mod.connect(normalized), budget, "connection timed out");
    const remaining = Math.max(1000, budget - (Date.now() - start));
    await withTimeout(adapter.list(resolveRemote(normalized.root, "")), remaining, "listing timed out");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function connectionHint(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/INSECURE CONNECTION REFUSED/.test(msg)) {
    return 'switch this server to sftp, or explicitly set "allowInsecure": true to accept the risk';
  }
  if (/auth/i.test(msg)) return "check the user / password / key";
  if (/timed out|timeout|firewall|passive/i.test(msg)) return "check the firewall or passive-mode settings";
  if (/not found|ENOTFOUND|getaddrinfo/i.test(msg)) return "check the host name";
  if (/refused/i.test(msg)) return "is the server reachable on that port?";
  return "see the message above";
}

async function runConnectionTests(servers, W) {
  W("");
  W("Testing connections (10s each):");
  for (const [name, srv] of Object.entries(servers || {})) {
    const missing = unresolvedEnvVars(srv);
    if (missing.length) {
      W(`  - ${name}: skipped (set ${missing.map((v) => `ENV ${v}`).join(", ")} first)`);
      continue;
    }
    const proto = srv.protocol || "?";
    const res = await testOneServer(name, srv);
    if (res.ok) {
      const insecure = insecureTransport(normalizeServer(name, srv));
      W(`  ✓ ${name} (${proto}://${srv.host})${insecure ? "  ⚠ INSECURE transport" : ""}`);
    } else {
      const short = (res.error && res.error.message ? res.error.message : String(res.error)).split("[")[0].trim();
      W(`  ✗ ${name} — ${short} — ${connectionHint(res.error)}`);
    }
  }
}

// ---- clipboard -------------------------------------------------------------

function copyToClipboard(text, platform) {
  try {
    let cmd;
    let args = [];
    if (platform === "win32") cmd = "clip";
    else if (platform === "darwin") cmd = "pbcopy";
    else {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    }
    const r = spawnSync(cmd, args, { input: text });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

// ---- clients ---------------------------------------------------------------

function selectClients(clientsFlag, fileClients) {
  if (clientsFlag === "none") return [];
  if (!clientsFlag || clientsFlag === "all") return fileClients.filter((c) => c.detected);
  const ids = clientsFlag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // An explicitly named client is configured even if not auto-detected.
  return fileClients.filter((c) => ids.includes(c.id));
}

function entryOneLiner(entry) {
  if (!entry || typeof entry !== "object") return String(entry);
  const args = Array.isArray(entry.args) ? entry.args.join(" ") : "";
  return `${entry.command || "?"} ${args}`.trim();
}

function manualSnippet(entry) {
  return JSON.stringify({ mcpServers: { ftp: entry } }, null, 2);
}

// Render one merge result line and return whether a manual snippet is warranted.
function renderResult(W, client, res) {
  switch (res.status) {
    case "created":
      W(`  ✓ ${client.name}: created ${res.path}`);
      return false;
    case "updated":
      W(`  ✓ ${client.name}: updated ${res.path}${res.backupPath ? ` (backup: ${res.backupPath})` : ""}`);
      return false;
    case "already":
      W(`  = ${client.name}: already up to date (${res.path})`);
      return false;
    case "skipped-different":
      W(
        `  ! ${client.name}: kept existing ftp entry (${entryOneLiner(res.existing)}) at ${res.path} — re-run with --force to overwrite`
      );
      return true;
    case "unparseable":
      W(`  ✗ ${client.name}: ${res.path} is not valid JSON — left untouched`);
      return true;
    default:
      W(`  ? ${client.name}: ${res.status} (${res.path})`);
      return false;
  }
}

// ---- interactive helpers ---------------------------------------------------

async function ask(rl, query, def) {
  const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
  const answer = (await rl.question(`${query}${suffix}: `)).trim();
  return answer === "" && def !== undefined ? String(def) : answer;
}

// Masked question: mute the echoed characters on a TTY; fall back to visible
// input (with a notice) when stdin is not a TTY.
async function askMasked(rl, query) {
  if (!process.stdin.isTTY) {
    process.stdout.write("(input is not a TTY — the value will be visible)\n");
    return (await rl.question(`${query}: `)).trim();
  }
  const output = rl.output;
  const origWrite = output.write.bind(output);
  let muted = false;
  output.write = (chunk, ...rest) => (muted ? true : origWrite(chunk, ...rest));
  try {
    const p = rl.question(`${query}: `);
    muted = true;
    const answer = await p;
    return answer.trim();
  } finally {
    output.write = origWrite;
    output.write("\n");
  }
}

// Manual server-entry loop. Returns { config: { defaultServer?, servers } },
// the same shape importFileZilla produces.
async function manualEntry(rl, W) {
  const servers = {};
  let first = null;
  for (;;) {
    const name = await ask(rl, "Server name", `server-${Object.keys(servers).length + 1}`);
    let protocol = (await ask(rl, "Protocol (sftp/ftp/ftps)", "sftp")).toLowerCase();
    let allowInsecure = false;
    if (protocol === "ftp") {
      // Plain FTP needs an explicit, deliberate confirmation — SFTP is the default.
      W("");
      W("  ⚠ SECURITY WARNING: plain FTP is NOT encrypted — credentials and files can be");
      W("  intercepted or altered by anyone on the network. SFTP is strongly recommended.");
      const confirm = (
        await ask(rl, '  Type "insecure" to keep plain FTP anyway, or press Enter to use sftp', "sftp")
      ).toLowerCase();
      if (confirm === "insecure") {
        allowInsecure = true;
      } else {
        protocol = "sftp";
        W("  → using sftp.");
      }
    }
    const host = await ask(rl, "Host", "");
    const defPort = protocol === "sftp" ? "22" : "21";
    const portStr = await ask(rl, "Port", defPort);
    const user = await ask(rl, "User", "");
    const authKind = (await ask(rl, "Auth (password/key)", "password")).toLowerCase();
    const entry = { protocol, host, user };
    if (allowInsecure) entry.allowInsecure = true;
    const port = Number(portStr);
    if (Number.isInteger(port) && String(port) !== defPort) entry.port = port;
    if (authKind.startsWith("k")) {
      entry.privateKeyPath = await ask(rl, "Private key path", "~/.ssh/id_ed25519");
      const passphrase = await askMasked(rl, "Key passphrase (blank if none)");
      if (nonEmpty(passphrase)) entry.passphrase = passphrase;
    } else {
      entry.password = await askMasked(rl, "Password");
    }
    const root = await ask(rl, "Root directory", "/");
    if (nonEmpty(root)) entry.root = root;
    const ro = (await ask(rl, "Read-only?", "n")).toLowerCase();
    if (ro.startsWith("y")) entry.readOnly = true;
    servers[name] = entry;
    if (!first) first = name;
    const more = (await ask(rl, "Add another server?", "N")).toLowerCase();
    if (!more.startsWith("y")) break;
  }
  return { config: { defaultServer: first, servers } };
}

// The effective config may contain insecure transports: plain FTP, or FTPS
// with certificate checks disabled. Those connections are refused at runtime
// unless the server entry carries "allowInsecure": true — surface all of that
// NOW, loudly, and let an interactive user explicitly accept the risk per
// server. Non-interactive runs only warn (fail closed: nothing is ever
// auto-allowed). Must run on the config that will actually be USED (after any
// merge), because grants mutate the entries in place. Returns the number of
// servers the user explicitly allowed.
async function reviewInsecureServers(config, rl, W) {
  const entries = Object.entries((config && config.servers) || {});
  const insecure = [];
  const allowed = [];
  for (const [name, srv] of entries) {
    const n = normalizeServer(name, srv);
    const reason = insecureTransport(n);
    if (!reason) continue;
    (n.allowInsecure ? allowed : insecure).push({ name, srv, reason });
  }
  if (allowed.length > 0) {
    W("");
    W('⚠ SECURITY WARNING — insecure transports explicitly allowed ("allowInsecure": true):');
    for (const { name, reason } of allowed) {
      W(`  - ${name}: ${insecureLabel(reason)} — prefer switching to sftp`);
    }
  }
  if (insecure.length === 0) return 0;
  W("");
  W("⚠ SECURITY WARNING — insecure server transport(s) in this config:");
  for (const { name, reason } of insecure) {
    W(`  - ${name}: ${insecureLabel(reason)}`);
  }
  W("  Credentials and files on these connections can be intercepted on the network,");
  W("  so they are REFUSED by default. Prefer switching them to sftp (or verified ftps).");
  if (!rl) {
    W('  To accept the risk for a server anyway, set "allowInsecure": true on it in the config file.');
    return 0;
  }
  let granted = 0;
  for (const { name, srv } of insecure) {
    const a = (
      await ask(rl, `  Allow INSECURE connections to "${name}" anyway? Type "insecure" to accept the risk`, "no")
    ).toLowerCase();
    if (a === "insecure") {
      srv.allowInsecure = true;
      granted += 1;
    }
  }
  return granted;
}

// ---- setup -----------------------------------------------------------------

const BANNER = [
  "",
  "ftp-deploy-mcp — setup",
  "==========================",
  "",
];

export async function runSetup(argv) {
  const opts = parseSetupArgs(argv);
  const redactor = createRedactor();
  const W = (s = "") => process.stdout.write(`${redactor.strictText(s)}\n`);
  const E = (s = "") => process.stderr.write(`${redactor.strictText(s)}\n`);

  for (const line of BANNER) W(line);

  if (nodeMajor() < 18) {
    E(`Node.js >= 18 is required (found ${process.version}). Please upgrade Node and retry.`);
    return 1;
  }

  const isolated = opts.home != null;
  const home = isolated ? path.resolve(opts.home) : os.homedir();
  const ctx = buildCtx(home, isolated);
  const absIndexJs = getAbsIndexJs();

  const defaultDest = path.join(home, ".ftp-mcp", "servers.json");
  const configDest = opts.configDest ? path.resolve(opts.configDest) : defaultDest;

  const interactive = !opts.yes && process.stdin.isTTY;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  if (rl) {
    rl.on("SIGINT", () => {
      W("\nAborted.");
      rl.close();
      process.exit(130);
    });
  }

  try {
    // --- Step 2 + 3: determine the config source, write it to dest ----------
    let produced = null; // { config, warnings? } newly built (FileZilla / manual)
    let keptPath = null; // path of an existing config we keep as-is

    if (opts.fromFilezillaGiven) {
      const imp = importFileZilla(opts.fromFilezilla, ctx);
      if (imp.error) {
        E(`Error: ${imp.error}`);
        return 1;
      }
      produced = imp;
      for (const w of imp.warnings || []) E(`Warning: ${w}`);
      E(
        "Warning: any imported plaintext passwords are stored in the config file — keep it out of version control and restrict its permissions."
      );
    } else {
      const existing = findExistingConfig(ctx, isolated, configDest);
      if (existing) {
        W(`Found ${Object.keys(existing.config.servers).length} server(s) at ${existing.path}`);
        if (interactive) {
          const choice = (await ask(rl, "(K)eep / (A)dd a server / (R)e-import from FileZilla", "K")).toLowerCase();
          if (choice.startsWith("a")) {
            produced = await manualEntry(rl, W);
          } else if (choice.startsWith("r")) {
            const imp = importFileZilla(null, ctx);
            if (imp.error) {
              E(`Error: ${imp.error} — keeping the existing config.`);
              keptPath = existing.path;
            } else {
              produced = imp;
              for (const w of imp.warnings || []) E(`Warning: ${w}`);
            }
          } else {
            keptPath = existing.path;
          }
        } else {
          keptPath = existing.path;
        }
      } else if (interactive) {
        const fzDefault = firstExistingFile(fileZillaDefaultPaths(ctx));
        if (fzDefault) {
          const yn = (await ask(rl, `Import your FileZilla sites from ${fzDefault}?`, "Y")).toLowerCase();
          if (!yn.startsWith("n")) {
            const imp = importFileZilla(fzDefault, ctx);
            if (imp.error) {
              E(`Error: ${imp.error}`);
              produced = await manualEntry(rl, W);
            } else {
              produced = imp;
              for (const w of imp.warnings || []) E(`Warning: ${w}`);
              E(
                "Warning: imported plaintext passwords are stored in the config file — keep it out of version control and restrict its permissions."
              );
            }
          } else {
            produced = await manualEntry(rl, W);
          }
        } else {
          produced = await manualEntry(rl, W);
        }
      } else {
        // Non-interactive with no source at all.
        E("No existing configuration was found and no --from-filezilla was given.");
        E("Re-run interactively, or pass --from-filezilla [path], or create a config first.");
        return 2;
      }
    }

    // Write / locate the effective config.
    let effectiveConfig;
    let configPathForEntry;
    if (produced) {
      redactor.add(produced.config);
      const wres = writeConfigDest(configDest, produced.config, {
        dryRun: opts.dryRun,
        platform: ctx.platform,
      });
      effectiveConfig = wres.finalConfig;
      configPathForEntry = configDest;
      for (const name of wres.skipped) {
        W(`Note: server "${name}" already exists in ${configDest} — kept the existing entry.`);
      }
      W(opts.dryRun ? `Would write config to ${configDest}` : `Config written to ${configDest}`);
    } else {
      keptPath = keptPath || configDest;
      const raw = safeRead(keptPath);
      effectiveConfig = raw ? safeParse(raw) || { servers: {} } : { servers: {} };
      redactor.add(effectiveConfig);
      configPathForEntry = keptPath;
      W(`Using existing config at ${keptPath}`);
    }

    // Loudly review insecure transports on the config that will actually be
    // used (post-merge — the merge keeps existing entries, so a grant taken on
    // the pre-merge input would be silently discarded). Interactive users can
    // explicitly accept the risk per server; grants are persisted immediately.
    const granted = await reviewInsecureServers(
      effectiveConfig,
      interactive && !opts.dryRun ? rl : null,
      W
    );
    if (granted > 0 && !opts.dryRun) {
      atomicWriteFileSync(configPathForEntry, JSON.stringify(effectiveConfig, null, 2) + "\n");
    }

    const isDefaultDest = path.resolve(configPathForEntry) === path.resolve(defaultDest);
    const envPath = isDefaultDest ? null : forwardSlash(configPathForEntry);
    const entry = buildEntry({ absIndexJs, configPath: envPath });

    // --- Step 4: connection tests -------------------------------------------
    if (!opts.skipTest && !opts.dryRun) {
      await runConnectionTests(effectiveConfig.servers, W);
    }

    // --- Step 5: clients -----------------------------------------------------
    W("");
    W("MCP clients:");
    const clients = getClients(ctx);
    const fileClients = clients.filter((c) => c.kind === "file");
    for (const c of fileClients) {
      W(`  ${c.detected ? "[detected]" : "[not found]"} ${c.name} — ${c.targets.join(", ")}`);
    }

    let selected;
    if (interactive) {
      const detected = fileClients.filter((c) => c.detected);
      const yn = (await ask(rl, "Configure all detected clients?", "Y")).toLowerCase();
      if (!yn.startsWith("n")) {
        selected = detected;
      } else {
        selected = [];
        for (const c of detected) {
          const a = (await ask(rl, `Configure ${c.name}?`, "y")).toLowerCase();
          if (a.startsWith("y")) selected.push(c);
        }
      }
    } else {
      selected = selectClients(opts.clients, fileClients);
    }

    W("");
    W(opts.dryRun ? "Planned client changes (dry-run, nothing written):" : "Configuring clients:");
    const forceWrite = opts.force === true;
    const manualNeeded = [];
    let configuredCount = 0;
    for (const c of selected) {
      let results = applyClient(c, entry, { force: forceWrite, dryRun: opts.dryRun });
      for (let i = 0; i < results.length; i++) {
        let res = results[i];
        // Interactive: offer to overwrite a differing entry.
        if (res.status === "skipped-different" && interactive && !opts.dryRun) {
          const a = (await ask(rl, `Overwrite existing ftp entry for ${c.name}?`, "N")).toLowerCase();
          if (a.startsWith("y")) {
            res = mergeConfigFile(res.path, entry, { force: true });
          }
        }
        const wantsSnippet = renderResult(W, c, res);
        if (res.status === "created" || res.status === "updated") configuredCount++;
        if (wantsSnippet) manualNeeded.push(c);
      }
    }
    if (selected.length === 0) W("  (no clients selected)");

    // Manual snippets for clients we could not safely write.
    for (const c of manualNeeded) {
      W("");
      W(`Add this to ${c.name} manually:`);
      W(manualSnippet(entry));
    }

    // --- Trae: always print the paste-ready block ---------------------------
    W("");
    W("Trae (UI-managed — no config file to write):");
    W(
      "  Trae → AI chat panel → Settings/gear → MCP → Add → Configure Manually → paste the JSON below → Confirm"
    );
    W(manualSnippet(entry));
    if (!isolated && !opts.dryRun) {
      if (copyToClipboard(manualSnippet(entry), ctx.platform)) {
        W("  (copied to your clipboard)");
      }
    }

    // --- Step 6: summary -----------------------------------------------------
    const serverNames = Object.keys(effectiveConfig.servers || {});
    W("");
    W("Summary");
    W("-------");
    W(`  Config:  ${configPathForEntry}`);
    W(`  Servers: ${serverNames.length ? serverNames.join(", ") : "(none)"}`);
    W(`  Clients: ${configuredCount} configured, ${selected.length - configuredCount} unchanged/skipped`);
    W("");
    W("Restart your IDE(s), then ask your agent e.g. « Liste mes serveurs FTP ».");
    W("Run `npm run doctor` (or `node src/index.js doctor`) any time to diagnose.");
    return 0;
  } catch (err) {
    throw redactor.error(err);
  } finally {
    if (rl) rl.close();
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- doctor ----------------------------------------------------------------

export async function runDoctor(argv) {
  const opts = parseSetupArgs(argv);
  const redactor = createRedactor();
  const W = (s = "") => process.stdout.write(`${redactor.strictText(s)}\n`);

  const isolated = opts.home != null;
  const home = isolated ? path.resolve(opts.home) : os.homedir();
  const ctx = buildCtx(home, isolated);
  const absIndexJs = getAbsIndexJs();

  W("ftp-deploy-mcp — doctor");
  W(`  Node:      ${process.version}`);
  W(`  Install:   ${absIndexJs}`);
  W("");

  // Config discovery (respect --home isolation).
  const candidates = isolated ? [path.join(home, ".ftp-mcp", "servers.json")] : configCandidates();
  const winner = firstExistingFile(candidates);
  if (winner) {
    W(`Config: ${winner}`);
    const parsed = safeParse(safeRead(winner) || "");
    if (parsed && parsed.servers && typeof parsed.servers === "object") {
      redactor.add(parsed);
      const names = Object.keys(parsed.servers);
      W(`  ${names.length} server(s):`);
      for (const name of names) {
        const s = parsed.servers[name];
        const proto = s.protocol || "?";
        const port = s.port ?? (proto === "sftp" ? 22 : s.implicitTLS ? 990 : 21);
        const root = nonEmpty(s.root) ? s.root : "/";
        const ro = s.readOnly === true ? "read-only" : "read-write";
        const auth = nonEmpty(s.privateKeyPath) ? "key" : nonEmpty(s.password) ? "password" : "none";
        W(`    - ${name}: ${proto}://${s.host}:${port}  root=${root}  ${ro}  auth=${auth}`);
        const normalized = normalizeServer(name, s);
        const insecure = insecureTransport(normalized);
        if (insecure) {
          W(
            `        ⚠ INSECURE: ${insecureLabel(insecure)} — ${
              s.allowInsecure === true
                ? 'explicitly allowed ("allowInsecure": true); prefer sftp'
                : 'connections are REFUSED (switch to sftp, or set "allowInsecure": true to accept the risk)'
            }`
          );
        }
        if (unsafeRemoteRoot(normalized)) {
          W(
            s.allowUnsafeRemoteRoot === true
              ? `        ⚠ UNSAFE ROOT explicit override: ${unsafeRemoteRootWarningText(normalized)}`
              : `        ⚠ UNSAFE ROOT REFUSED: ${unsafeRemoteRootBlockedMessage(name, normalized.root)}`
          );
        }
        const invalidHostKey =
          normalized.protocol === "sftp" &&
          normalized.hostKeySha256.length > 0 &&
          normalized.hostKeySha256.some((pin) => !isValidHostKeySha256(pin));
        if (invalidHostKey) {
          W(`        ⚠ HOST KEY INVALID: server "${name}" has an invalid "hostKeySha256" pin; connections are REFUSED`);
        } else if (normalized.protocol === "sftp" && normalized.hostKeySha256.length === 0) {
          W(
            s.allowUnknownHostKey === true
              ? `        ⚠ HOST KEY explicit override: ${unknownHostKeyWarningText(normalized)}`
              : `        ⚠ HOST KEY REFUSED: ${unknownHostKeyBlockedMessage(name)}`
          );
        }
        for (const varName of unresolvedEnvVars(s)) {
          W(`        ! env var ${varName} not set!`);
        }
      }
    } else {
      W("  (no servers object)");
    }
  } else {
    W("Config: none found. Searched:");
    for (const c of candidates) W(`  - ${c}`);
  }
  W("");

  // Per-client status.
  W(`Clients (home: ${home}):`);
  for (const c of getClients(ctx)) {
    if (c.kind === "manual") {
      W(`  ${c.name}: manual (UI) — run setup to reprint the snippet`);
      continue;
    }
    W(`  ${c.name}: ${c.detected ? "detected" : "not detected"}`);
    for (const t of c.targets) {
      if (!fs.existsSync(t)) {
        W(`      ${t}: no config file`);
        continue;
      }
      const obj = safeParse(safeRead(t) || "");
      if (!obj) {
        W(`      ${t}: exists but is not valid JSON`);
        continue;
      }
      const e = obj.mcpServers && obj.mcpServers.ftp;
      if (!e) {
        W(`      ${t}: no ftp entry`);
        continue;
      }
      const a1 = e.args && e.args[1];
      if (a1 && forwardSlash(a1) === forwardSlash(absIndexJs)) {
        W(`      ${t}: configured → this install`);
      } else {
        W(`      ${t}: configured but points to a different install: ${a1}`);
      }
    }
  }
  W("");
  W("Run `node src/index.js setup` to (re)configure.");
  return 0;
}
