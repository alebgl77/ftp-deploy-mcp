import { isAppError, renderError } from "./errors.js";
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
import { createI18n, affirmative, negative } from "./i18n.js";

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
function importFileZilla(pathOrNull, ctx, i18n) {
  const { t } = i18n;
  const file = pathOrNull ? path.resolve(pathOrNull) : firstExistingFile(fileZillaDefaultPaths(ctx));
  if (!file) {
    return { error: t("setup.filezillaMissing") };
  }
  const xml = safeRead(file);
  if (xml == null) return { error: t("setup.cannotRead", { file }) };
  const parsed = parseSiteManager(xml, i18n);
  if (Object.keys(parsed.servers).length === 0) {
    return { error: t("setup.noImportable", { file }) };
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
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "ETIMEDOUT" })), ms);
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

async function testOneServer(name, srv, { t }) {
  const normalized = normalizeServer(name, srv);
  const mod =
    normalized.protocol === "sftp"
      ? await import("./adapters/sftp.js")
      : await import("./adapters/ftp.js");
  let adapter = null;
  const budget = 10000;
  const start = Date.now();
  try {
    adapter = await withTimeout(mod.connect(normalized), budget, t("connection.timeout"));
    const remaining = Math.max(1000, budget - (Date.now() - start));
    await withTimeout(adapter.list(resolveRemote(normalized.root, "")), remaining, t("connection.listTimeout"));
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

export function connectionHint(err, { t } = createI18n()) {
  if (isAppError(err) && err.code === "TRANSPORT_POLICY") return t("connection.insecureHint");
  const msg = err && err.message ? err.message : String(err);
  if (/INSECURE CONNECTION REFUSED/.test(msg)) {
    return t("connection.insecureHint");
  }
  if (/auth/i.test(msg)) return t("connection.authHint");
  if (err?.code === "ETIMEDOUT" || /timed out|timeout|firewall|passive|délai/i.test(msg)) return t("connection.timeoutHint");
  if (err?.code === "ENOTFOUND" || /not found|ENOTFOUND|getaddrinfo/i.test(msg)) return t("connection.hostHint");
  if (err?.code === "ECONNREFUSED" || /refused|refusée?/i.test(msg)) return t("connection.refusedHint");
  return t("connection.otherHint");
}

async function runConnectionTests(servers, W, i18n) {
  const { t } = i18n;
  W("");
  W(t("connection.header"));
  for (const [name, srv] of Object.entries(servers || {})) {
    const missing = unresolvedEnvVars(srv);
    if (missing.length) {
      W(t("connection.skipped", { name, variables: missing.map((v) => `ENV ${v}`).join(", ") }));
      continue;
    }
    const proto = srv.protocol || "?";
    const res = await testOneServer(name, srv, i18n);
    if (res.ok) {
      const insecure = insecureTransport(normalizeServer(name, srv));
      W(`  ✓ ${name} (${proto}://${srv.host})${insecure ? t("connection.insecure") : ""}`);
    } else {
      const short = (isAppError(res.error) ? renderError(res.error, i18n) : res.error?.message ?? String(res.error)).split("[")[0].trim();
      W(`  ✗ ${name} — ${short} — ${connectionHint(res.error, i18n)}`);
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
function renderResult(W, client, res, { t }) {
  switch (res.status) {
    case "created":
      W(t("client.created", { name: client.name, path: res.path }));
      return false;
    case "updated":
      W(t("client.updated", { name: client.name, path: res.path,
        backup: res.backupPath ? t("client.backup", { path: res.backupPath }) : "" }));
      return false;
    case "already":
      W(t("client.already", { name: client.name, path: res.path }));
      return false;
    case "skipped-different":
      W(t("client.kept", { name: client.name, entry: entryOneLiner(res.existing), path: res.path }));
      return true;
    case "unparseable":
      W(t("client.invalid", { name: client.name, path: res.path }));
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
async function askMasked(rl, query, { t }) {
  if (!process.stdin.isTTY) {
    process.stdout.write(t("prompt.visible"));
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
export async function manualEntry(rl, W, i18n = createI18n()) {
  const { t } = i18n;
  const servers = {};
  let first = null;
  for (;;) {
    const name = await ask(rl, t("prompt.server"), `server-${Object.keys(servers).length + 1}`);
    let protocol = (await ask(rl, t("prompt.protocol"), "sftp")).toLowerCase();
    let allowInsecure = false;
    if (protocol === "ftp") {
      // Plain FTP needs an explicit, deliberate confirmation — SFTP is the default.
      W("");
      W(t("prompt.ftpWarning1"));
      W(t("prompt.ftpWarning2"));
      const confirm = (
        await ask(rl, t("prompt.keepFtp"), "sftp")
      ).toLowerCase();
      if (confirm === "insecure") {
        allowInsecure = true;
      } else {
        protocol = "sftp";
        W(t("prompt.usingSftp"));
      }
    }
    const host = await ask(rl, t("prompt.host"), "");
    const defPort = protocol === "sftp" ? "22" : "21";
    const portStr = await ask(rl, t("prompt.port"), defPort);
    const user = await ask(rl, t("prompt.user"), "");
    const authKind = (await ask(rl, t("prompt.auth"), t("answer.password"))).toLowerCase();
    const entry = { protocol, host, user };
    if (allowInsecure) entry.allowInsecure = true;
    const port = Number(portStr);
    if (Number.isInteger(port) && String(port) !== defPort) entry.port = port;
    if (authKind.startsWith("k") || authKind === "clé" || authKind === "cle") {
      entry.privateKeyPath = await ask(rl, t("prompt.keyPath"), "~/.ssh/id_ed25519");
      const passphrase = await askMasked(rl, t("prompt.passphrase"), i18n);
      if (nonEmpty(passphrase)) entry.passphrase = passphrase;
    } else {
      entry.password = await askMasked(rl, t("prompt.password"), i18n);
    }
    const root = await ask(rl, t("prompt.root"), "/");
    if (nonEmpty(root)) entry.root = root;
    const ro = await ask(rl, t("prompt.readOnly"), t("answer.noLower"));
    if (affirmative(ro)) entry.readOnly = true;
    servers[name] = entry;
    if (!first) first = name;
    const more = await ask(rl, t("prompt.more"), t("answer.noUpper"));
    if (!affirmative(more)) break;
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
export async function reviewInsecureServers(config, rl, W, i18n = createI18n()) {
  const { t } = i18n;
  const label = (reason) => t(reason === "plain-ftp" ? "security.ftpLabel" : "security.tlsLabel");
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
    W(t("security.allowedHeader"));
    for (const { name, reason } of allowed) {
      W(t("security.prefer", { name, label: label(reason) }));
    }
  }
  if (insecure.length === 0) return 0;
  W("");
  W(t("security.insecureHeader"));
  for (const { name, reason } of insecure) {
    W(`  - ${name}: ${label(reason)}`);
  }
  W(t("security.intercepted"));
  W(t("security.refusedDefault"));
  if (!rl) {
    W(t("security.acceptHint"));
    return 0;
  }
  let granted = 0;
  for (const { name, srv } of insecure) {
    const a = (
      await ask(rl, t("security.confirm", { name }), t("answer.noWord"))
    ).toLowerCase();
    if (a === "insecure") {
      srv.allowInsecure = true;
      granted += 1;
    }
  }
  return granted;
}

// ---- setup -----------------------------------------------------------------

export async function runSetup(argv, i18n = createI18n()) {
  const { t } = i18n;
  const opts = parseSetupArgs(argv);
  const redactor = createRedactor();
  const W = (s = "") => process.stdout.write(`${redactor.strictText(s)}\n`);
  const E = (s = "") => process.stderr.write(`${redactor.strictText(s)}\n`);

  for (const line of ["", t("setup.banner"), "==========================", ""]) W(line);

  if (nodeMajor() < 22) {
    E(t("setup.node", { version: process.version }));
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
      W(t("setup.aborted"));
      rl.close();
      process.exit(130);
    });
  }

  try {
    // --- Step 2 + 3: determine the config source, write it to dest ----------
    let produced = null; // { config, warnings? } newly built (FileZilla / manual)
    let keptPath = null; // path of an existing config we keep as-is

    if (opts.fromFilezillaGiven) {
      const imp = importFileZilla(opts.fromFilezilla, ctx, i18n);
      if (imp.error) {
        E(t("common.error", { error: imp.error }));
        return 1;
      }
      produced = imp;
      redactor.add(imp.config);
      for (const w of imp.warnings || []) E(t("common.warning", { warning: w }));
      E(t("setup.importWarning"));
    } else {
      const existing = findExistingConfig(ctx, isolated, configDest);
      if (existing) {
        W(t("setup.found", { count: Object.keys(existing.config.servers).length, path: existing.path }));
        if (interactive) {
          const choice = (await ask(rl, t("prompt.existing"), t("answer.keep"))).toLowerCase();
          if (choice.startsWith("a")) {
            produced = await manualEntry(rl, W, i18n);
          } else if (choice.startsWith("r")) {
            const imp = importFileZilla(null, ctx, i18n);
            if (imp.error) {
              E(t("setup.keepError", { error: imp.error }));
              keptPath = existing.path;
            } else {
              produced = imp;
              redactor.add(imp.config);
              for (const w of imp.warnings || []) E(t("common.warning", { warning: w }));
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
          const yn = await ask(rl, t("prompt.import", { path: fzDefault }), t("answer.yesUpper"));
          if (!negative(yn)) {
            const imp = importFileZilla(fzDefault, ctx, i18n);
            if (imp.error) {
              E(t("common.error", { error: imp.error }));
              produced = await manualEntry(rl, W, i18n);
            } else {
              produced = imp;
              redactor.add(imp.config);
              for (const w of imp.warnings || []) E(t("common.warning", { warning: w }));
              E(t("setup.importWarningInteractive"));
            }
          } else {
            produced = await manualEntry(rl, W, i18n);
          }
        } else {
          produced = await manualEntry(rl, W, i18n);
        }
      } else {
        // Non-interactive with no source at all.
        E(t("setup.noSource"));
        E(t("setup.sourceHint"));
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
        W(t("setup.keptServer", { name, path: configDest }));
      }
      W(t(opts.dryRun ? "setup.wouldWrite" : "setup.wrote", { path: configDest }));
    } else {
      keptPath = keptPath || configDest;
      const raw = safeRead(keptPath);
      effectiveConfig = raw ? safeParse(raw) || { servers: {} } : { servers: {} };
      redactor.add(effectiveConfig);
      configPathForEntry = keptPath;
      W(t("setup.using", { path: keptPath }));
    }

    // Loudly review insecure transports on the config that will actually be
    // used (post-merge — the merge keeps existing entries, so a grant taken on
    // the pre-merge input would be silently discarded). Interactive users can
    // explicitly accept the risk per server; grants are persisted immediately.
    const granted = await reviewInsecureServers(
      effectiveConfig,
      interactive && !opts.dryRun ? rl : null,
      W,
      i18n
    );
    if (granted > 0 && !opts.dryRun) {
      atomicWriteFileSync(configPathForEntry, JSON.stringify(effectiveConfig, null, 2) + "\n");
    }

    const isDefaultDest = path.resolve(configPathForEntry) === path.resolve(defaultDest);
    const envPath = isDefaultDest ? null : forwardSlash(configPathForEntry);
    const entry = buildEntry({ absIndexJs, configPath: envPath, locale: i18n.locale });

    // --- Step 4: connection tests -------------------------------------------
    if (!opts.skipTest && !opts.dryRun) {
      await runConnectionTests(effectiveConfig.servers, W, i18n);
    }

    // --- Step 5: clients -----------------------------------------------------
    W("");
    W(t("setup.clients"));
    const clients = getClients(ctx);
    const fileClients = clients.filter((c) => c.kind === "file");
    for (const c of fileClients) {
      W(`  ${t(c.detected ? "setup.detected" : "setup.notFound")} ${c.name} — ${c.targets.join(", ")}`);
    }

    let selected;
    if (interactive) {
      const detected = fileClients.filter((c) => c.detected);
      const yn = await ask(rl, t("prompt.allClients"), t("answer.yesUpper"));
      if (!negative(yn)) {
        selected = detected;
      } else {
        selected = [];
        for (const c of detected) {
          const a = await ask(rl, t("prompt.client", { name: c.name }), t("answer.yesLower"));
          if (affirmative(a)) selected.push(c);
        }
      }
    } else {
      selected = selectClients(opts.clients, fileClients);
    }

    W("");
    W(t(opts.dryRun ? "setup.planned" : "setup.configuring"));
    const forceWrite = opts.force === true;
    const manualNeeded = [];
    let configuredCount = 0;
    for (const c of selected) {
      let results = applyClient(c, entry, { force: forceWrite, dryRun: opts.dryRun });
      for (let i = 0; i < results.length; i++) {
        let res = results[i];
        // Interactive: offer to overwrite a differing entry.
        if (res.status === "skipped-different" && interactive && !opts.dryRun) {
          const a = await ask(rl, t("prompt.overwrite", { name: c.name }), t("answer.noUpper"));
          if (affirmative(a)) {
            res = mergeConfigFile(res.path, entry, { force: true });
          }
        }
        const wantsSnippet = renderResult(W, c, res, i18n);
        if (res.status === "created" || res.status === "updated") configuredCount++;
        if (wantsSnippet) manualNeeded.push(c);
      }
    }
    if (selected.length === 0) W(t("setup.noClients"));

    // Manual snippets for clients we could not safely write.
    for (const c of manualNeeded) {
      W("");
      W(t("setup.manual", { name: c.name }));
      W(manualSnippet(entry));
    }

    // --- Trae: always print the paste-ready block ---------------------------
    W("");
    W(t("setup.trae"));
    W(t("setup.traeSteps"));
    W(manualSnippet(entry));
    if (!isolated && !opts.dryRun) {
      if (copyToClipboard(manualSnippet(entry), ctx.platform)) {
        W(t("setup.clipboard"));
      }
    }

    // --- Step 6: summary -----------------------------------------------------
    const serverNames = Object.keys(effectiveConfig.servers || {});
    W("");
    W(t("setup.summary"));
    W("-------");
    W(t("setup.summaryConfig", { path: configPathForEntry }));
    W(t("setup.summaryServers", { servers: serverNames.length ? serverNames.join(", ") : t("common.none") }));
    W(t("setup.summaryClients", { configured: configuredCount, unchanged: selected.length - configuredCount }));
    W("");
    W(t("setup.restart"));
    W(t("setup.doctorHint"));
    return 0;
  } catch (err) {
    throw redactor.error(isAppError(err) ? renderError(err, i18n) : err);
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

export async function runDoctor(argv, i18n = createI18n()) {
  const { t } = i18n;
  const opts = parseSetupArgs(argv);
  const redactor = createRedactor();
  const W = (s = "") => process.stdout.write(`${redactor.strictText(s)}\n`);

  const isolated = opts.home != null;
  const home = isolated ? path.resolve(opts.home) : os.homedir();
  const ctx = buildCtx(home, isolated);
  const absIndexJs = getAbsIndexJs();

  W(t("doctor.banner"));
  W(`  Node:      ${process.version}`);
  W(t("doctor.install", { path: absIndexJs }));
  W("");

  // Config discovery (respect --home isolation).
  const candidates = isolated ? [path.join(home, ".ftp-mcp", "servers.json")] : configCandidates();
  const winner = firstExistingFile(candidates);
  if (winner) {
    W(t("doctor.config", { path: winner }));
    const parsed = safeParse(safeRead(winner) || "");
    if (parsed && parsed.servers && typeof parsed.servers === "object") {
      redactor.add(parsed);
      const names = Object.keys(parsed.servers);
      W(t("doctor.servers", { count: names.length }));
      for (const name of names) {
        const s = parsed.servers[name];
        const proto = s.protocol || "?";
        const port = s.port ?? (proto === "sftp" ? 22 : s.implicitTLS ? 990 : 21);
        const root = nonEmpty(s.root) ? s.root : "/";
        const ro = t(s.readOnly === true ? "doctor.readOnly" : "doctor.readWrite");
        const auth = t(nonEmpty(s.privateKeyPath) ? "doctor.key" : nonEmpty(s.password) ? "doctor.password" : "doctor.none");
        W(`    - ${name}: ${proto}://${s.host}:${port}  root=${root}  ${ro}  auth=${auth}`);
        const normalized = normalizeServer(name, s);
        const insecure = insecureTransport(normalized);
        if (insecure) {
          W(t("doctor.insecure", {
            label: t(insecure === "plain-ftp" ? "security.ftpLabel" : "security.tlsLabel"),
            policy: t(s.allowInsecure === true ? "doctor.insecureAllowed" : "doctor.insecureRefused"),
          }));
        }
        if (unsafeRemoteRoot(normalized)) {
          W(
            s.allowUnsafeRemoteRoot === true
              ? t("doctor.rootOverride", { message: unsafeRemoteRootWarningText(normalized, i18n) })
              : t("doctor.rootRefused", { message: unsafeRemoteRootBlockedMessage(name, normalized.root, i18n) })
          );
        }
        const invalidHostKey =
          normalized.protocol === "sftp" &&
          normalized.hostKeySha256.length > 0 &&
          normalized.hostKeySha256.some((pin) => !isValidHostKeySha256(pin));
        if (invalidHostKey) {
          W(t("doctor.keyInvalid", { name }));
        } else if (normalized.protocol === "sftp" && normalized.hostKeySha256.length === 0) {
          W(
            s.allowUnknownHostKey === true
              ? t("doctor.keyOverride", { message: unknownHostKeyWarningText(normalized, i18n) })
              : t("doctor.keyRefused", { message: unknownHostKeyBlockedMessage(name, i18n) })
          );
        }
        for (const varName of unresolvedEnvVars(s)) {
          W(t("doctor.envMissing", { name: varName }));
        }
      }
    } else {
      W(t("doctor.noServers"));
    }
  } else {
    W(t("doctor.noConfig"));
    for (const c of candidates) W(`  - ${c}`);
  }
  W("");

  // Per-client status.
  W(t("doctor.clients", { home }));
  for (const c of getClients(ctx)) {
    if (c.kind === "manual") {
      W(t("doctor.manual", { name: c.name }));
      continue;
    }
    W(`  ${c.name}: ${t(c.detected ? "doctor.detected" : "doctor.notDetected")}`);
    for (const target of c.targets) {
      if (!fs.existsSync(target)) {
        W(t("doctor.noFile", { path: target }));
        continue;
      }
      const obj = safeParse(safeRead(target) || "");
      if (!obj) {
        W(t("doctor.invalidFile", { path: target }));
        continue;
      }
      const e = obj.mcpServers && obj.mcpServers.ftp;
      if (!e) {
        W(t("doctor.noEntry", { path: target }));
        continue;
      }
      const a1 = e.args && e.args[1];
      if (a1 && forwardSlash(a1) === forwardSlash(absIndexJs)) {
        W(t("doctor.thisInstall", { path: target }));
      } else {
        W(t("doctor.otherInstall", { path: target, target: a1 }));
      }
    }
  }
  W("");
  W(t("doctor.setupHint"));
  return 0;
}
