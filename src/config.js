// Configuration discovery, parsing and validation.
//
// A guiding principle: loading NEVER throws. The MCP server must always start
// and expose its tools even when the config is missing or broken, so clients
// don't see a dead server. Any problem is captured in the returned object and
// surfaced later, per tool call, as a helpful message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeRoot } from "./remote-path.js";
import { DEFAULT_OPERATION_TIMEOUT_MS } from "./operations.js";
import { TRANSFER_LIMITS } from "./transfers.js";
import { SCAN_LIMITS } from "./scanner.js";
import { appError, isAppError, messageList, messageSpec, renderError, renderMessage, protectError } from "./errors.js";
import { createI18n } from "./i18n.js";
import { createRedactor } from "./redact.js";

const PROTOCOLS = new Set(["ftp", "ftps", "sftp"]);
const loadedRedactors = new WeakMap();

// Credentials from rejected entries must still protect their diagnostics.
// This channel retains only the redactor, never a rejected config object.
export function configRedactor(loaded) {
  let redactor = loadedRedactors.get(loaded);
  if (!redactor) {
    redactor = createRedactor(loaded?.config);
    if (loaded && typeof loaded === "object") loadedRedactors.set(loaded, redactor);
  }
  return redactor;
}

// Expand a leading "~" to the user's home directory.
export function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// An explicit selector is authoritative, even when it is empty or invalid.
// Discovery is only used when neither --config nor FTP_MCP_CONFIG is present.
export function configCandidates(configFlag) {
  const explicit = configFlag ?? process.env.FTP_MCP_CONFIG;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || explicit.length === 0) {
      throw appError("CONFIG_INVALID", "runtime.config.explicitEmpty");
    }
    return [path.resolve(explicit)];
  }
  return [
    path.resolve(process.cwd(), "ftp-servers.json"),
    path.join(os.homedir(), ".ftp-mcp", "servers.json"),
  ];
}

// Replace ${ENV:NAME} occurrences in a string. Unset variables are recorded in
// `errors` and left as empty strings.
function substituteEnv(value, errors, ctx) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{ENV:([^}]+)\}/g, (_m, rawName) => {
    const name = rawName.trim();
    const v = process.env[name];
    if (v === undefined) {
      errors.push(appError("CONFIG_INVALID", "runtime.config.envMissing", { name, context: ctx }));
      return "";
    }
    return v;
  });
}

function walkSubstitute(obj, errors, ctx) {
  if (Array.isArray(obj)) {
    return obj.map((v, i) => walkSubstitute(v, errors, `${ctx}[${i}]`));
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walkSubstitute(v, errors, ctx ? `${ctx}.${k}` : k);
    }
    return out;
  }
  return substituteEnv(obj, errors, ctx);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

const HOST_KEY_SHA256_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function isValidHostKeySha256(value) {
  if (typeof value !== "string" || !HOST_KEY_SHA256_RE.test(value)) return false;
  const encoded = value.slice("SHA256:".length);
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === encoded;
  } catch {
    return false;
  }
}

function validateServer(name, s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return appError("CONFIG_INVALID", "runtime.config.server.object", { name });
  }
  if (!nonEmptyString(s.protocol)) {
    return appError("CONFIG_INVALID", "runtime.config.server.protocolRequired", { name });
  }
  const protocol = s.protocol;
  if (!PROTOCOLS.has(protocol)) {
    return appError("CONFIG_INVALID", "runtime.config.server.protocolUnknown", { name, protocol: s.protocol });
  }
  if (!nonEmptyString(s.host)) return appError("CONFIG_INVALID", "runtime.config.server.hostRequired", { name });
  if (!nonEmptyString(s.user)) return appError("CONFIG_INVALID", "runtime.config.server.userRequired", { name });
  if (s.port !== undefined && (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port <= 0)) {
    return appError("CONFIG_INVALID", "runtime.config.server.port", { name });
  }
  if (s.operationTimeoutMs !== undefined && (!Number.isInteger(s.operationTimeoutMs) ||
      s.operationTimeoutMs < 100 || s.operationTimeoutMs > 3600000)) {
    return appError("CONFIG_INVALID", "runtime.config.server.timeout", { name });
  }
  const hasPassword = nonEmptyString(s.password);
  for (const [field, limit] of Object.entries({ ...TRANSFER_LIMITS, ...SCAN_LIMITS })) {
    if (s[field] !== undefined && (!Number.isSafeInteger(s[field]) || s[field] <= 0 || s[field] > limit.maximum)) {
      return appError("CONFIG_INVALID", "runtime.config.server.transferLimit", { name, field, maximum: limit.maximum });
    }
  }
  const hasKey = nonEmptyString(s.privateKeyPath);
  if (!hasPassword && !hasKey) {
    return appError("CONFIG_INVALID", "runtime.config.server.authRequired", { name });
  }
  for (const flag of [
    "readOnly",
    "insecureTLS",
    "implicitTLS",
    "allowInsecure",
    "allowUnknownHostKey",
    "allowUnsafeRemoteRoot",
  ]) {
    if (s[flag] !== undefined && typeof s[flag] !== "boolean") {
      // Rejected objects may carry credentials in keys as well as values.
      // Report the expected type without serializing any rejected input.
      return appError("CONFIG_INVALID", "runtime.config.server.boolean", { name, field: flag });
    }
  }

  if (s.hostKeySha256 !== undefined) {
    if (protocol !== "sftp") return appError("CONFIG_INVALID", "runtime.config.server.pinProtocol", { name });
    const pins = typeof s.hostKeySha256 === "string" ? [s.hostKeySha256] : s.hostKeySha256;
    if (!Array.isArray(pins) || pins.length === 0) {
      return appError("CONFIG_INVALID", "runtime.config.server.pinType", { name });
    }
    const badIndex = pins.findIndex((pin) => !isValidHostKeySha256(pin));
    if (badIndex !== -1) {
      return appError("CONFIG_INVALID", "runtime.config.server.pinFormat", { name, index: badIndex + 1 });
    }
  }
  if (s.allowUnknownHostKey !== undefined && protocol !== "sftp") {
    return appError("CONFIG_INVALID", "runtime.config.server.unknownKeyProtocol", { name });
  }
  if (s.allowUnknownHostKey !== undefined && s.hostKeySha256 !== undefined) {
    return appError("CONFIG_INVALID", "runtime.config.server.pinConflict", { name });
  }
  if (s.allowUnsafeRemoteRoot !== undefined && protocol === "sftp") {
    return appError("CONFIG_INVALID", "runtime.config.server.unsafeRootProtocol", { name });
  }
  return null;
}

// Validate the config envelope. Individual server errors are handled
// separately so one bad entry never disables unrelated valid servers.
function validateEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return appError("CONFIG_INVALID", "runtime.config.envelope.object");
  }
  const servers = parsed.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return appError("CONFIG_INVALID", "runtime.config.envelope.servers");
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    return appError("CONFIG_INVALID", "runtime.config.envelope.empty");
  }
  if (parsed.defaultServer !== undefined) {
    if (!nonEmptyString(parsed.defaultServer)) {
      return appError("CONFIG_INVALID", "runtime.config.envelope.defaultEmpty");
    }
    if (!names.includes(parsed.defaultServer)) {
      return appError("CONFIG_INVALID", "runtime.config.envelope.defaultUnknown", { name: parsed.defaultServer, available: names.join(", ") });
    }
  }
  return null;
}

// Normalize a server entry into what adapters expect (default ports, expanded
// key path, effective root). The protocol is canonicalized to lowercase: every
// downstream comparison (adapter routing, TLS mode, the insecure-transport
// gate) is case-sensitive, and setup/doctor feed raw JSON.parse'd entries in
// here without going through validate() — a case-variant "FTP" must not slip
// past the gate onto a plaintext connection.
export function normalizeServer(name, s) {
  const protocol = typeof s.protocol === "string" ? s.protocol.trim().toLowerCase() : s.protocol;
  const implicitTLS = protocol === "ftps" && s.implicitTLS === true;
  const defaultPort = protocol === "sftp" ? 22 : implicitTLS ? 990 : 21;
  const port = s.port ?? defaultPort;
  return {
    name,
    protocol,
    host: s.host,
    port,
    operationTimeoutMs: s.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    maxTransferBytes: s.maxTransferBytes ?? TRANSFER_LIMITS.maxTransferBytes.default,
    maxDeployFiles: s.maxDeployFiles ?? TRANSFER_LIMITS.maxDeployFiles.default,
    maxDeployBytes: s.maxDeployBytes ?? TRANSFER_LIMITS.maxDeployBytes.default,
    maxScanEntries: s.maxScanEntries ?? SCAN_LIMITS.maxScanEntries.default,
    maxScanDepth: s.maxScanDepth ?? SCAN_LIMITS.maxScanDepth.default,
    user: s.user,
    password: nonEmptyString(s.password) ? s.password : undefined,
    privateKeyPath: nonEmptyString(s.privateKeyPath) ? expandHome(s.privateKeyPath) : undefined,
    passphrase: nonEmptyString(s.passphrase) ? s.passphrase : undefined,
    localRoot: nonEmptyString(s.localRoot) ? expandHome(s.localRoot) : undefined,
    root: nonEmptyString(s.root) ? s.root : "/",
    readOnly: s.readOnly === true,
    insecureTLS: s.insecureTLS === true,
    implicitTLS,
    allowInsecure: s.allowInsecure === true,
    hostKeySha256:
      typeof s.hostKeySha256 === "string"
        ? [s.hostKeySha256]
        : Array.isArray(s.hostKeySha256)
          ? [...s.hostKeySha256]
          : [],
    allowUnknownHostKey: s.allowUnknownHostKey === true,
    allowUnsafeRemoteRoot: s.allowUnsafeRemoteRoot === true,
  };
}

// FTP has no portable REALPATH/LSTAT primitives, so a client-side sub-root is
// path organization, not a security boundary. Only the account-visible root is
// safe by default; sub-roots require an explicit risk acceptance.
export function unsafeRemoteRoot(server) {
  return (server.protocol === "ftp" || server.protocol === "ftps") && normalizeRoot(server.root) !== "/";
}

export function unsafeRemoteRootBlockedMessage(name, root, i18n = createI18n()) {
  return i18n.t("runtime.config.remoteRootBlocked", { name, root: normalizeRoot(root) });
}

export function unsafeRemoteRootWarningText(server, i18n = createI18n()) {
  if (!unsafeRemoteRoot(server) || server.allowUnsafeRemoteRoot !== true) return null;
  return i18n.t("runtime.config.remoteRootWarning", { name: server.name, root: normalizeRoot(server.root) });
}

export function unknownHostKeyBlockedMessage(name, i18n = createI18n()) {
  return i18n.t("runtime.config.hostKeyRequired", { name });
}

export function unknownHostKeyWarningText(server, i18n = createI18n()) {
  if (server.protocol !== "sftp" || server.allowUnknownHostKey !== true) return null;
  return i18n.t("runtime.config.hostKeyWarning", { name: server.name });
}

// ---- insecure-transport policy --------------------------------------------
// Plain FTP sends credentials and files in cleartext; FTPS with certificate
// verification disabled lets any network attacker impersonate the server.
// Both are REFUSED at connection time unless the server entry explicitly opts
// in with "allowInsecure": true — and even then, every surface (startup log,
// tool results, ftp_list_servers, doctor) shows a loud warning.

// Why a server's transport is insecure: "plain-ftp", "unverified-tls", or null.
export function insecureTransport(server) {
  if (server.protocol === "ftp") return "plain-ftp";
  if (server.protocol === "ftps" && server.insecureTLS === true) return "unverified-tls";
  return null;
}

// Short label for listings (ftp_list_servers, doctor, setup).
export function insecureLabel(reason, i18n = createI18n()) {
  return i18n.t(reason === "plain-ftp" ? "runtime.config.ftpLabel" : "runtime.config.tlsLabel");
}

// One sentence describing the concrete risk, shared by refusals and warnings.
export function insecureRiskText(name, reason, i18n = createI18n()) {
  if (reason === "plain-ftp") {
    return i18n.t("runtime.config.ftpRisk", { name });
  }
  return i18n.t("runtime.config.tlsRisk", { name });
}

// The error message used when an insecure transport has no explicit opt-in.
export function insecureBlockedMessage(name, reason, i18n = createI18n()) {
  return renderMessage(messageSpec("runtime.config.insecureBlocked", {
    name: String(name),
    risk: messageSpec(reason === "plain-ftp" ? "runtime.config.ftpRisk" : "runtime.config.tlsRisk", { name: String(name) }),
  }), i18n);
}

// Warning shown when the user HAS opted in; null for secure servers.
// Takes a normalized server (needs .name / .protocol / .insecureTLS / .allowInsecure).
export function insecureWarningText(server, i18n = createI18n()) {
  const reason = insecureTransport(server);
  if (!reason || server.allowInsecure !== true) return null;
  return renderMessage(messageSpec("runtime.config.insecureWarning", {
    risk: messageSpec(reason === "plain-ftp" ? "runtime.config.ftpRisk" : "runtime.config.tlsRisk", { name: String(server.name) }),
  }), i18n);
}

// Load configuration. Always returns an object; never throws.
//   { found, path, searched, error, config, serverNames, defaultServer }
export function loadConfig(configFlag) {
  const redactor = createRedactor();
  const loaded = loadConfigWithRedactor(configFlag, redactor);
  loadedRedactors.set(loaded, redactor);
  for (const failure of Object.values(loaded.serverFailures)) protectError(failure, redactor);
  protectError(loaded.failure, redactor);
  if (loaded.error) loaded.error = redactor.strictText(loaded.error);
  loaded.serverErrors = Object.fromEntries(Object.entries(loaded.serverErrors)
    .map(([name, error]) => [name, redactor.strictText(error)]));
  return loaded;
}

function loadConfigWithRedactor(configFlag, redactor) {
  let searched;
  try {
    searched = configCandidates(configFlag);
  } catch (err) {
    return errorResult(null, [], isAppError(err) ? err : appError("CONFIG_INVALID", "runtime.config.detail", { error: err.message }, { origin: "local" }));
  }
  const explicit = configFlag != null || process.env.FTP_MCP_CONFIG !== undefined;
  let filePath = null;
  for (const c of searched) {
    try {
      if ((explicit || fs.existsSync(c)) && fs.statSync(c).isFile()) {
        filePath = c;
        break;
      }
      if (explicit) return errorResult(c, searched, appError("CONFIG_INVALID", "runtime.config.explicitNotFile"));
    } catch (err) {
      if (explicit) return errorResult(c, searched, appError("CONFIG_INVALID", "runtime.config.explicitAccess", { error: err.message }, { origin: "local" }));
      // ignore inaccessible candidates
    }
  }

  if (!filePath) {
    return {
      found: false,
      path: null,
      searched,
      error: null,
      failure: null,
      config: null,
      serverNames: [],
      invalidServerNames: [],
      serverErrors: {},
      serverFailures: {},
      defaultServer: null,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return errorResult(filePath, searched, appError("CONFIG_INVALID", "runtime.config.readFailed", { error: err.message }, { origin: "local" }));
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Native JSON.parse messages can quote raw credentials. Do not retain
    // that message, exception, cause or any excerpt from malformed input.
    const shownPath = filePath.length > 512 ? `${filePath.slice(0, 512)}…` : filePath;
    return errorResult(filePath, searched, appError("CONFIG_INVALID", "runtime.config.invalidJson", { path: shownPath }, { origin: "local" }));
  }

  redactor.add(parsed);
  const envErrors = [];
  const substituted = walkSubstitute(parsed, envErrors, "");
  redactor.add(substituted);
  if (envErrors.length > 0) {
    return errorResult(filePath, searched, joinConfigFailures(envErrors));
  }

  const validationError = validateEnvelope(substituted);
  if (validationError) {
    return errorResult(filePath, searched, validationError);
  }

  const serverErrors = {};
  const serverFailures = {};
  const validServers = {};
  for (const [name, server] of Object.entries(substituted.servers)) {
    const error = validateServer(name, server);
    if (error) {
      serverErrors[name] = error.message;
      serverFailures[name] = error;
    } else validServers[name] = server;
  }
  const serverNames = Object.keys(validServers);
  const invalidServerNames = Object.keys(serverErrors);
  if (serverNames.length === 0) {
    return errorResult(filePath, searched, joinConfigFailures(invalidServerNames.map((name) => serverFailures[name])), serverFailures);
  }
  const config = {
    defaultServer: substituted.defaultServer ?? null,
    servers: validServers,
  };

  return {
    found: true,
    path: filePath,
    searched,
    error: null,
    failure: null,
    config,
    serverNames,
    invalidServerNames,
    serverErrors,
    serverFailures,
    defaultServer: config.defaultServer,
  };
}

function joinConfigFailures(failures) {
  return appError("CONFIG_INVALID", "runtime.config.detail", { error: messageList(failures) });
}

function errorResult(filePath, searched, failure, serverFailures = {}) {
  return {
    found: true,
    path: filePath,
    searched,
    error: failure.message,
    failure,
    config: null,
    serverNames: [],
    invalidServerNames: Object.keys(serverFailures),
    serverErrors: Object.fromEntries(Object.entries(serverFailures).map(([name, error]) => [name, error.message])),
    serverFailures,
    defaultServer: null,
  };
}

// Resolve which server a tool call should use.
//   requested -> config.defaultServer -> the sole server -> error
// Returns { server } (normalized) or throws with a helpful message.
export function resolveServer(loaded, requested) {
  if (!loaded.config) {
    // Caller should have handled the no-config case already; be defensive.
    throw appError("CONFIG_REQUIRED", "runtime.config.noUsable");
  }
  const names = loaded.serverNames;
  let name;
  if (nonEmptyString(requested)) {
    if (loaded.serverErrors && loaded.serverErrors[requested]) {
      throw loaded.serverFailures?.[requested] ?? appError("CONFIG_INVALID", "runtime.config.detail", { error: loaded.serverErrors[requested] });
    }
    if (!names.includes(requested)) {
      throw appError("SERVER_UNKNOWN", "runtime.config.unknownServer", { name: requested, available: names.join(", ") });
    }
    name = requested;
  } else if (loaded.defaultServer) {
    if (loaded.serverErrors && loaded.serverErrors[loaded.defaultServer]) {
      throw loaded.serverFailures?.[loaded.defaultServer] ?? appError("CONFIG_INVALID", "runtime.config.detail", { error: loaded.serverErrors[loaded.defaultServer] });
    }
    name = loaded.defaultServer;
  } else if (names.length === 1) {
    name = names[0];
  } else {
    throw appError("SERVER_REQUIRED", "runtime.config.serverRequired", { available: names.join(", ") });
  }
  return { name, server: normalizeServer(name, loaded.config.servers[name]) };
}

// The text shown when no config is found (or it failed to load). Explains the
// lookup locations and provides a minimal example.
export function configHelpText(loaded, i18n = createI18n()) {
  const lines = [];
  if (loaded.error) {
    lines.push(i18n.t("runtime.config.help.loadFailed", { path: loaded.path }));
    lines.push(`  ${loaded.failure ? renderError(loaded.failure, i18n) : loaded.error}`);
    lines.push("");
    lines.push(i18n.t("runtime.config.help.fix"));
  } else {
    lines.push(i18n.t("runtime.config.help.none"));
    lines.push("");
    lines.push(i18n.t("runtime.config.help.create"));
  }
  lines.push("");
  lines.push(i18n.t("runtime.config.help.locations"));
  for (const p of loaded.searched) lines.push(`  - ${p}`);
  lines.push(i18n.t("runtime.config.help.selector"));
  lines.push("");
  lines.push(i18n.t("runtime.config.help.example"));
  lines.push(EXAMPLE_CONFIG);
  return configRedactor(loaded).strictText(lines.join("\n"));
}

export const EXAMPLE_CONFIG = `{
  "defaultServer": "prod",
  "servers": {
    "prod": {
      "protocol": "sftp",
      "host": "ssh.example.com",
      "port": 22,
      "user": "deploy",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "localRoot": "~/projects/site",
      "root": "/var/www/site"
    },
    "ovh": {
      "protocol": "ftps",
      "host": "ftp.example.com",
      "user": "web",
      "password": "\${ENV:OVH_FTP_PASSWORD}",
      "localRoot": "~/projects/site",
      "root": "/www"
    }
  }
}`;
