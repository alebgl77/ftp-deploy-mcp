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

const PROTOCOLS = new Set(["ftp", "ftps", "sftp"]);

// Expand a leading "~" to the user's home directory.
export function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Ordered list of candidate config locations. `configFlag` is the value of the
// --config CLI option, if any.
export function configCandidates(configFlag) {
  const out = [];
  if (configFlag) out.push(path.resolve(configFlag));
  if (process.env.FTP_MCP_CONFIG) out.push(path.resolve(process.env.FTP_MCP_CONFIG));
  out.push(path.resolve(process.cwd(), "ftp-servers.json"));
  out.push(path.join(os.homedir(), ".ftp-mcp", "servers.json"));
  return out;
}

// Replace ${ENV:NAME} occurrences in a string. Unset variables are recorded in
// `errors` and left as empty strings.
function substituteEnv(value, errors, ctx) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{ENV:([^}]+)\}/g, (_m, rawName) => {
    const name = rawName.trim();
    const v = process.env[name];
    if (v === undefined) {
      errors.push(`environment variable "${name}" is not set (referenced by ${ctx})`);
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
  const prefix = `server "${name}":`;
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return `${prefix} must be a JSON object`;
  }
  if (!nonEmptyString(s.protocol)) {
    return `${prefix} missing required field "protocol" (one of ftp, ftps, sftp)`;
  }
  const protocol = s.protocol;
  if (!PROTOCOLS.has(protocol)) {
    return `${prefix} unknown protocol "${s.protocol}" (use ftp, ftps or sftp)`;
  }
  if (!nonEmptyString(s.host)) return `${prefix} missing required field "host"`;
  if (!nonEmptyString(s.user)) return `${prefix} missing required field "user"`;
  if (s.port !== undefined && (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port <= 0)) {
    return `${prefix} field "port" must be a positive integer`;
  }
  const hasPassword = nonEmptyString(s.password);
  const hasKey = nonEmptyString(s.privateKeyPath);
  if (!hasPassword && !hasKey) {
    return `${prefix} no authentication method — provide "password" or "privateKeyPath"`;
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
      return `${prefix} field "${flag}" must be true or false (got ${JSON.stringify(s[flag])})`;
    }
  }

  if (s.hostKeySha256 !== undefined) {
    if (protocol !== "sftp") return `${prefix} field "hostKeySha256" is only valid for sftp`;
    const pins = typeof s.hostKeySha256 === "string" ? [s.hostKeySha256] : s.hostKeySha256;
    if (!Array.isArray(pins) || pins.length === 0) {
      return `${prefix} field "hostKeySha256" must be a fingerprint string or a non-empty array`;
    }
    const badIndex = pins.findIndex((pin) => !isValidHostKeySha256(pin));
    if (badIndex !== -1) {
      return (
        `${prefix} field "hostKeySha256" entry ${badIndex + 1} must use ` +
        `SHA256:<43-character unpadded base64> format`
      );
    }
  }
  if (s.allowUnknownHostKey !== undefined && protocol !== "sftp") {
    return `${prefix} field "allowUnknownHostKey" is only valid for sftp`;
  }
  if (s.allowUnknownHostKey !== undefined && s.hostKeySha256 !== undefined) {
    return `${prefix} fields "allowUnknownHostKey" and "hostKeySha256" cannot be used together`;
  }
  if (s.allowUnsafeRemoteRoot !== undefined && protocol === "sftp") {
    return `${prefix} field "allowUnsafeRemoteRoot" is only valid for ftp or ftps`;
  }
  return null;
}

// Validate the config envelope. Individual server errors are handled
// separately so one bad entry never disables unrelated valid servers.
function validateEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "config root must be a JSON object with a `servers` field";
  }
  const servers = parsed.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return "config is missing a `servers` object";
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    return "no servers configured (the `servers` object is empty)";
  }
  if (parsed.defaultServer !== undefined) {
    if (!nonEmptyString(parsed.defaultServer)) {
      return `"defaultServer" must be a non-empty string`;
    }
    if (!names.includes(parsed.defaultServer)) {
      return `"defaultServer" is "${parsed.defaultServer}" but that server is not configured (available: ${names.join(", ")})`;
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

export function unsafeRemoteRootBlockedMessage(name, root) {
  return (
    `UNSAFE REMOTE ROOT REFUSED: server "${name}" uses FTP/FTPS root "${normalizeRoot(root)}", ` +
    `but FTP cannot reliably detect symlink escapes from a client-side sub-root. ` +
    `Use a dedicated server-side chroot/account whose visible root is "/", or explicitly set ` +
    `"allowUnsafeRemoteRoot": true to accept this risk.`
  );
}

export function unsafeRemoteRootWarningText(server) {
  if (!unsafeRemoteRoot(server) || server.allowUnsafeRemoteRoot !== true) return null;
  return (
    `⚠ SECURITY WARNING: FTP/FTPS root "${normalizeRoot(server.root)}" on server "${server.name}" ` +
    `is not a reliable anti-symlink jail. Allowed because "allowUnsafeRemoteRoot": true is set; ` +
    `use a dedicated server-side chroot/account for a real boundary.`
  );
}

export function unknownHostKeyBlockedMessage(name) {
  return (
    `SFTP HOST KEY VERIFICATION REQUIRED: server "${name}" has no "hostKeySha256" pin. ` +
    `Add a SHA256 fingerprint verified through a trusted channel, or explicitly set ` +
    `"allowUnknownHostKey": true to accept impersonation risk.`
  );
}

export function unknownHostKeyWarningText(server) {
  if (server.protocol !== "sftp" || server.allowUnknownHostKey !== true) return null;
  return (
    `⚠ SECURITY WARNING: the identity of SFTP server "${server.name}" is NOT verified. ` +
    `Allowed because "allowUnknownHostKey": true is set; configure "hostKeySha256" as soon as possible.`
  );
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
export function insecureLabel(reason) {
  return reason === "plain-ftp"
    ? "plain FTP (unencrypted)"
    : 'FTPS certificate verification disabled ("insecureTLS")';
}

// One sentence describing the concrete risk, shared by refusals and warnings.
export function insecureRiskText(name, reason) {
  if (reason === "plain-ftp") {
    return (
      `server "${name}" uses plain FTP — the connection is NOT encrypted, so credentials ` +
      `and files can be read or altered by anyone on the network path`
    );
  }
  return (
    `server "${name}" disables FTPS certificate verification ("insecureTLS": true) — the ` +
    `server's identity is NOT checked, so a network attacker can impersonate it and ` +
    `capture credentials and files`
  );
}

// The error message used when an insecure transport has no explicit opt-in.
export function insecureBlockedMessage(name, reason) {
  return (
    `INSECURE CONNECTION REFUSED: ${insecureRiskText(name, reason)}. ` +
    `Use "sftp" (recommended) or "ftps" with a valid certificate instead. ` +
    `If you fully accept this risk, explicitly set "allowInsecure": true on server "${name}" in your config.`
  );
}

// Warning shown when the user HAS opted in; null for secure servers.
// Takes a normalized server (needs .name / .protocol / .insecureTLS / .allowInsecure).
export function insecureWarningText(server) {
  const reason = insecureTransport(server);
  if (!reason || server.allowInsecure !== true) return null;
  return (
    `⚠ SECURITY WARNING: ${insecureRiskText(server.name, reason)}. ` +
    `Allowed because "allowInsecure": true is set — switch to SFTP (or FTPS with a valid certificate) as soon as possible.`
  );
}

// Load configuration. Always returns an object; never throws.
//   { found, path, searched, error, config, serverNames, defaultServer }
export function loadConfig(configFlag) {
  const searched = configCandidates(configFlag);
  let filePath = null;
  for (const c of searched) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        filePath = c;
        break;
      }
    } catch {
      // ignore inaccessible candidates
    }
  }

  if (!filePath) {
    return {
      found: false,
      path: null,
      searched,
      error: null,
      config: null,
      serverNames: [],
      invalidServerNames: [],
      serverErrors: {},
      defaultServer: null,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return errorResult(filePath, searched, `cannot read config file: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return errorResult(filePath, searched, `invalid JSON in config file ${filePath}: ${err.message}`);
  }

  const envErrors = [];
  const substituted = walkSubstitute(parsed, envErrors, "");
  if (envErrors.length > 0) {
    return errorResult(filePath, searched, envErrors.join("; "));
  }

  const validationError = validateEnvelope(substituted);
  if (validationError) {
    return errorResult(filePath, searched, validationError);
  }

  const serverErrors = {};
  const validServers = {};
  for (const [name, server] of Object.entries(substituted.servers)) {
    const error = validateServer(name, server);
    if (error) serverErrors[name] = error;
    else validServers[name] = server;
  }
  const serverNames = Object.keys(validServers);
  const invalidServerNames = Object.keys(serverErrors);
  if (serverNames.length === 0) {
    return errorResult(filePath, searched, invalidServerNames.map((name) => serverErrors[name]).join("; "), serverErrors);
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
    config,
    serverNames,
    invalidServerNames,
    serverErrors,
    defaultServer: config.defaultServer,
  };
}

function errorResult(filePath, searched, message, serverErrors = {}) {
  return {
    found: true,
    path: filePath,
    searched,
    error: message,
    config: null,
    serverNames: [],
    invalidServerNames: Object.keys(serverErrors),
    serverErrors,
    defaultServer: null,
  };
}

// Resolve which server a tool call should use.
//   requested -> config.defaultServer -> the sole server -> error
// Returns { server } (normalized) or throws with a helpful message.
export function resolveServer(loaded, requested) {
  if (!loaded.config) {
    // Caller should have handled the no-config case already; be defensive.
    throw new Error("no usable configuration is loaded");
  }
  const names = loaded.serverNames;
  let name;
  if (nonEmptyString(requested)) {
    if (loaded.serverErrors && loaded.serverErrors[requested]) {
      throw new Error(loaded.serverErrors[requested]);
    }
    if (!names.includes(requested)) {
      throw new Error(
        `unknown server "${requested}". Available servers: ${names.join(", ")}`
      );
    }
    name = requested;
  } else if (loaded.defaultServer) {
    if (loaded.serverErrors && loaded.serverErrors[loaded.defaultServer]) {
      throw new Error(loaded.serverErrors[loaded.defaultServer]);
    }
    name = loaded.defaultServer;
  } else if (names.length === 1) {
    name = names[0];
  } else {
    throw new Error(
      `no server specified and no default set. Pass "server" as one of: ${names.join(", ")}`
    );
  }
  return { name, server: normalizeServer(name, loaded.config.servers[name]) };
}

// The text shown when no config is found (or it failed to load). Explains the
// lookup locations and provides a minimal example.
export function configHelpText(loaded) {
  const lines = [];
  if (loaded.error) {
    lines.push(`The configuration at ${loaded.path} could not be loaded:`);
    lines.push(`  ${loaded.error}`);
    lines.push("");
    lines.push("Fix the file, then retry.");
  } else {
    lines.push("No FTP/SFTP server configuration was found.");
    lines.push("");
    lines.push("Create a JSON config at one of these locations (first found wins):");
  }
  lines.push("");
  lines.push("Searched locations:");
  for (const p of loaded.searched) lines.push(`  - ${p}`);
  lines.push("  (or pass --config <path> / set FTP_MCP_CONFIG=<path>)");
  lines.push("");
  lines.push("Minimal example (ftp-servers.json):");
  lines.push(EXAMPLE_CONFIG);
  return lines.join("\n");
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
