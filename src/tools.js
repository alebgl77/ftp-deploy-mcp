// MCP tool definitions. Each tool:
//   - resolves which configured server to use,
//   - enforces the remote-path jail and readOnly flag,
//   - opens a fresh connection, runs the op, closes it in finally,
//   - never throws to the transport (errors become isError results),
//   - never leaks credentials.
//
// All user-facing tool output is English (the consuming agent may be any client).

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

import {
  resolveServer,
  configHelpText,
  normalizeServer,
  insecureTransport,
  insecureLabel,
  insecureWarningText,
  unsafeRemoteRoot,
  unsafeRemoteRootBlockedMessage,
  unsafeRemoteRootWarningText,
  unknownHostKeyBlockedMessage,
  unknownHostKeyWarningText,
} from "./config.js";
import { resolveRemote, isRootPath, normalizeRoot } from "./remote-path.js";
import { resolveLocalSource, resolveLocalDestination, localRootStatus } from "./local-path.js";
import { createRedactor } from "./redact.js";
import * as ftpAdapter from "./adapters/ftp.js";
import * as sftpAdapter from "./adapters/sftp.js";

const posix = path.posix;

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  ".env",
  ".env.*",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  "ftp-servers.json",
  "**/.ftp-mcp/**",
];

const READ_DEFAULT_BYTES = 262144;
const READ_MAX_BYTES = 1048576;
const MAX_RESULT_BYTES = 25000;
const DEPLOY_SAMPLE_LIMIT = 100;
const STRUCTURED_SAMPLE_BUDGET = 22000;

const securityWarningSchema = z.string().nullable();
const listEntrySchema = z
  .object({
    name: z.string(),
    type: z.enum(["dir", "file", "link"]),
    size_bytes: z.number().nonnegative(),
    modified_at: z.string().nullable(),
  })
  .strict();
const deploySampleSchema = z.object({ path: z.string(), size_bytes: z.number().nonnegative() }).strict();

const OUTPUT_SCHEMAS = {
  listServers: z
    .object({
      status: z.enum(["configured", "missing", "invalid"]),
      configured_count: z.number().int().nonnegative(),
      valid_count: z.number().int().nonnegative(),
      invalid_count: z.number().int().nonnegative(),
      default_server: z.string().nullable(),
      servers: z.array(
        z
          .object({
            name: z.string(),
            protocol: z.enum(["ftp", "ftps", "sftp"]),
            host: z.string(),
            port: z.number().int().positive(),
            root: z.string(),
            read_only: z.boolean(),
            auth: z.enum(["key", "password"]),
            is_default: z.boolean(),
            local_root_status: z.string(),
            connection_refused: z.boolean(),
            security_warning: securityWarningSchema,
          })
          .strict()
      ),
      servers_omitted: z.number().int().nonnegative(),
      errors: z.array(z.object({ server: z.string().nullable(), message: z.string() }).strict()),
      errors_omitted: z.number().int().nonnegative(),
    })
    .strict(),
  test: z
    .object({
      server: z.string(),
      protocol: z.enum(["ftp", "ftps", "sftp"]),
      host: z.string(),
      port: z.number().int().positive(),
      root: z.string(),
      entries_visible: z.number().int().nonnegative(),
      security_warning: securityWarningSchema,
    })
    .strict(),
  list: z
    .object({
      server: z.string(),
      path: z.string(),
      total: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(200),
      has_more: z.boolean(),
      next_offset: z.number().int().nonnegative().nullable(),
      entries: z.array(listEntrySchema),
      security_warning: securityWarningSchema,
    })
    .strict(),
  upload: z
    .object({
      server: z.string(),
      local_path: z.string(),
      remote_path: z.string(),
      size_bytes: z.number().nonnegative(),
      security_warning: securityWarningSchema,
    })
    .strict(),
  deploy: z
    .object({
      mode: z.enum(["dry_run", "deploy"]),
      server: z.string(),
      remote_base: z.string(),
      total_files: z.number().int().nonnegative(),
      total_bytes: z.number().nonnegative(),
      uploaded_count: z.number().int().nonnegative(),
      uploaded_bytes: z.number().nonnegative(),
      failed_count: z.number().int().nonnegative(),
      aborted_early: z.boolean(),
      complete: z.boolean(),
      duration_ms: z.number().int().nonnegative(),
      security_warning: securityWarningSchema,
      uploaded: z.array(deploySampleSchema),
      uploaded_omitted: z.number().int().nonnegative(),
      planned: z.array(deploySampleSchema),
      planned_omitted: z.number().int().nonnegative(),
      failures: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
      failures_omitted: z.number().int().nonnegative(),
    })
    .strict(),
  download: z
    .object({
      server: z.string(),
      remote_path: z.string(),
      local_path: z.string(),
      size_bytes: z.number().nonnegative(),
      overwritten: z.boolean(),
      security_warning: securityWarningSchema,
    })
    .strict(),
  mkdir: z
    .object({ server: z.string(), path: z.string(), created: z.boolean(), security_warning: securityWarningSchema })
    .strict(),
  rename: z
    .object({
      server: z.string(),
      from_path: z.string(),
      to_path: z.string(),
      moved: z.boolean(),
      security_warning: securityWarningSchema,
    })
    .strict(),
  delete: z
    .object({
      server: z.string(),
      path: z.string(),
      entry_type: z.enum(["file", "directory"]),
      recursive: z.boolean(),
      deleted: z.boolean(),
      security_warning: securityWarningSchema,
    })
    .strict(),
};

function annotations(readOnlyHint, destructiveHint, idempotentHint, openWorldHint) {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

// ---- small helpers --------------------------------------------------------

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function successResult(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function explicitErrorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function utf8Size(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(text, maxBytes) {
  const value = String(text);
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const marker = "\n… [output truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    let end = Math.min(marker.length, maxBytes);
    while (end > 0 && Buffer.byteLength(marker.slice(0, end), "utf8") > maxBytes) end -= 1;
    return marker.slice(0, end);
  }
  let low = 0;
  let high = value.length;
  const budget = maxBytes - markerBytes;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  return `${value.slice(0, end)}${marker}`;
}

function boundedString(value, maxBytes = 2048) {
  return truncateUtf8(value == null ? "" : value, maxBytes);
}

function redactStructured(value, redactor) {
  if (typeof value === "string") return boundedString(redactor.strictText(value));
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, redactor));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactStructured(item, redactor)])
  );
}

const STRUCTURED_SAMPLE_FIELDS = [
  ["entries", null],
  ["servers", "servers_omitted"],
  ["errors", "errors_omitted"],
  ["uploaded", "uploaded_omitted"],
  ["planned", "planned_omitted"],
  ["failures", "failures_omitted"],
];

function syncListPageCounters(result) {
  const structured = result.structuredContent;
  if (!structured || !Array.isArray(structured.entries)) return;
  structured.count = structured.entries.length;
  structured.has_more = structured.offset + structured.count < structured.total;
  structured.next_offset = structured.has_more ? structured.offset + structured.count : null;
  const pageLine = `Page: offset ${structured.offset}, count ${structured.count}, limit ${structured.limit}; ${
    structured.next_offset === null ? "no next offset" : `next offset ${structured.next_offset}`
  }.`;
  for (const item of result.content || []) {
    if (typeof item.text === "string" && /^Page: /m.test(item.text)) {
      item.text = item.text.replace(/^Page: .*$/m, pageLine);
      break;
    }
  }
}

function reduceStructuredSamples(result) {
  const structured = result.structuredContent;
  if (!structured) return;
  while (utf8Size(structured) > STRUCTURED_SAMPLE_BUDGET) {
    let selected = null;
    let selectedBytes = -1;
    for (const [field, omittedField] of STRUCTURED_SAMPLE_FIELDS) {
      const values = structured[field];
      if (!Array.isArray(values) || values.length === 0) continue;
      const candidateBytes = utf8Size(values[values.length - 1]);
      if (candidateBytes > selectedBytes) {
        selected = [field, omittedField];
        selectedBytes = candidateBytes;
      }
    }
    if (!selected) break;
    const [field, omittedField] = selected;
    structured[field].pop();
    if (omittedField) structured[omittedField] = (structured[omittedField] || 0) + 1;
  }
  syncListPageCounters(result);
}

function capToolResult(result) {
  if (!result) return result;
  const bounded = {
    ...result,
    content: Array.isArray(result.content) ? result.content.map((item) => ({ ...item })) : [],
  };
  if (result.structuredContent) {
    bounded.structuredContent = { ...result.structuredContent };
    for (const [field] of STRUCTURED_SAMPLE_FIELDS) {
      if (Array.isArray(result.structuredContent[field])) {
        bounded.structuredContent[field] = result.structuredContent[field].slice();
      }
    }
    reduceStructuredSamples(bounded);
  }
  while (utf8Size(bounded) > MAX_RESULT_BYTES) {
    let largest = -1;
    let largestBytes = 0;
    const unprotected = bounded.content.some(
      (item) => typeof item.text === "string" && !item.text.includes("SECURITY WARNING") && item.text.length > 0
    );
    for (let i = 0; i < bounded.content.length; i += 1) {
      const text = bounded.content[i] && bounded.content[i].text;
      if (typeof text !== "string") continue;
      if (unprotected && text.includes("SECURITY WARNING")) continue;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > largestBytes) {
        largest = i;
        largestBytes = bytes;
      }
    }
    if (largest === -1 || largestBytes === 0) break;
    const excess = utf8Size(bounded) - MAX_RESULT_BYTES;
    bounded.content[largest].text = truncateUtf8(
      bounded.content[largest].text,
      Math.max(0, largestBytes - excess - 128)
    );
  }
  if (utf8Size(bounded) <= MAX_RESULT_BYTES) return bounded;
  const firstText = bounded.content.find((item) => typeof item.text === "string")?.text || "Output";
  const header = firstText.split(/\r?\n/, 1)[0];
  const fallback = explicitErrorResult(
    `${header}\nOUTPUT LIMIT — ERROR: the safely redacted result exceeded ${MAX_RESULT_BYTES} UTF-8 bytes.`
  );
  fallback.content[0].text = truncateUtf8(fallback.content[0].text, MAX_RESULT_BYTES - 128);
  return fallback;
}

function formatSize(n) {
  if (typeof n !== "number" || n < 0) return "? B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function openAdapter(serverCfg) {
  const mod = serverCfg.protocol === "sftp" ? sftpAdapter : ftpAdapter;
  return mod.connect(serverCfg);
}

// Append a loud, visible security warning to a tool result when the server
// uses an explicitly-allowed insecure transport. Secure servers pass through.
function transportWarningTexts(server) {
  return [
    insecureWarningText(server),
    unsafeRemoteRootWarningText(server),
    unknownHostKeyWarningText(server),
  ].filter(Boolean);
}

function withTransportNotices(result, server) {
  const warnings = transportWarningTexts(server);
  if (warnings.length === 0 || !result || !Array.isArray(result.content)) return result;
  const existing = result.content.map((item) => item.text || "").join("\n");
  const additions = warnings
    .filter((warning) => !existing.includes(warning))
    .map((warning) => ({ type: "text", text: warning }));
  return additions.length ? { ...result, content: [...result.content, ...additions] } : result;
}

// Same for the error path: guard() renders thrown errors as isError results,
// so the warning must ride inside the message — an op that failed may still
// have sent credentials over the insecure transport.
function withTransportError(err, server) {
  const warnings = transportWarningTexts(server);
  if (warnings.length === 0) return err;
  const msg = err && err.message ? err.message : String(err);
  return new Error(`${warnings.join("\n\n")}\n\n${msg}`);
}

// Thrown when config is missing/broken; carries the help text.
class ConfigError extends Error {}

function requireConfig(loaded) {
  if (!loaded.found || loaded.error || !loaded.config) {
    throw new ConfigError(configHelpText(loaded));
  }
}

// Resolve server, optionally block writes on read-only servers, connect,
// run `run({ name, server, adapter })`, and always close.
async function withResolvedServer(name, server, opts, run, connectAdapter) {
  const write = opts && opts.write;
  try {
    if (write && server.readOnly) {
      throw new Error(
        `server "${name}" is read-only — upload, deploy, mkdir, rename and delete are blocked`
      );
    }
    const adapter = await connectAdapter(server);
    let result;
    let operationError = null;
    let operationFailed = false;
    try {
      result = await run({ name, server, adapter });
    } catch (err) {
      operationFailed = true;
      operationError = err;
    }
    let closeError = null;
    let closeFailed = false;
    try {
      await adapter.close();
    } catch (err) {
      closeFailed = true;
      closeError = err;
    }
    if (operationFailed) {
      if (closeFailed) {
        const primary = operationError && operationError.message ? operationError.message : String(operationError);
        const secondary = closeError && closeError.message ? closeError.message : String(closeError);
        throw new Error(`${primary}\n\nConnection close also failed: ${secondary}`, {
          cause: operationError,
        });
      }
      throw operationError;
    }
    if (closeFailed) throw closeError;
    return withTransportNotices(result, server);
  } catch (err) {
    throw withTransportError(err, server);
  }
}

async function withServer(loaded, requestedServer, opts, run, connectAdapter) {
  requireConfig(loaded);
  const { name, server } = resolveServer(loaded, requestedServer);
  return withResolvedServer(name, server, opts, run, connectAdapter);
}

// Wrap a handler so any throw becomes a clean isError result.
function guard(fn, redactor) {
  return async (args, _extra) => {
    try {
      const redacted = redactor.result(await fn(args || {}));
      if (redacted && redacted.isError === true) {
        const { structuredContent: _discarded, ...errorOnly } = redacted;
        return capToolResult(errorOnly);
      }
      if (redacted && redacted.structuredContent) {
        redacted.structuredContent = redactStructured(redacted.structuredContent, redactor);
      }
      return capToolResult(redacted);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return capToolResult(errorResult(redactor.strictText(msg)));
    }
  };
}

// ---- deploy helpers -------------------------------------------------------

// picomatch's `basename` option is global to the whole compiled matcher: it
// tests EVERY pattern's regex against only the basename of the input, even
// patterns that contain a "/". So a single matcher can't mix slash-less
// globs (".env", meant to match at any depth) with slash-anchored globs
// ("**/node_modules/**", which already matches any depth via its leading
// "**/") under one `{ basename: true }` call — that would make the
// slash-anchored patterns test against a bare basename and never match.
// Compile the two kinds separately and OR them: gitignore-like semantics
// (slash-less patterns match at any depth; slash patterns match the full
// relative path) without breaking directory pruning.
function compileMatcher(globs) {
  const list = Array.isArray(globs) ? globs : [];
  const withSlash = list.filter((g) => g.includes("/"));
  const withoutSlash = list.filter((g) => !g.includes("/"));
  const matchSlash = withSlash.length ? picomatch(withSlash, { dot: true }) : null;
  const matchBasename = withoutSlash.length ? picomatch(withoutSlash, { dot: true, basename: true }) : null;
  return (rel) => Boolean((matchSlash && matchSlash(rel)) || (matchBasename && matchBasename(rel)));
}

function selectDeployFiles(localDirAbs, include, exclude) {
  const excludeGlobs = [...DEFAULT_EXCLUDES, ...(Array.isArray(exclude) ? exclude : [])];
  const isExcluded = compileMatcher(excludeGlobs);
  const hasInclude = Array.isArray(include) && include.length > 0;
  const isIncluded = hasInclude ? compileMatcher(include) : null;

  // Prune whole directories whose subtree is excluded (e.g. node_modules/**),
  // so we don't stat thousands of files we'll throw away.
  const pruneDir = (relDir) => isExcluded(`${relDir}/__ftp_deploy_probe__`);

  const files = [];
  const walk = (absDir, relBase) => {
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`cannot read local directory "${absDir}": ${err.message}`);
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue; // never follow symlinks
      const abs = path.join(absDir, d.name);
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (pruneDir(rel)) continue;
        walk(abs, rel);
      } else if (d.isFile()) {
        if (isExcluded(rel)) continue;
        if (isIncluded && !isIncluded(rel)) continue;
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* leave size 0 */
        }
        files.push({ abs, rel, size });
      }
    }
  };
  walk(localDirAbs, "");
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}

function dryRunPolicyMessages(name, server) {
  const messages = [];
  const insecure = insecureTransport(server);
  if (insecure && !server.allowInsecure) {
    messages.push(
      `server "${name}" uses ${insecureLabel(insecure)} without "allowInsecure": true — a real deploy will be REFUSED`
    );
  }
  if (unsafeRemoteRoot(server) && !server.allowUnsafeRemoteRoot) {
    messages.push(`${unsafeRemoteRootBlockedMessage(name, server.root)} A real deploy will be REFUSED.`);
  }
  if (
    server.protocol === "sftp" &&
    server.hostKeySha256.length === 0 &&
    !server.allowUnknownHostKey
  ) {
    messages.push(`${unknownHostKeyBlockedMessage(name)} A real deploy will be REFUSED.`);
  }
  return messages;
}

function securityWarning(server) {
  const warnings = transportWarningTexts(server);
  return warnings.length ? boundedString(warnings.join("\n\n")) : null;
}

function connectionRefused(server) {
  const insecure = insecureTransport(server);
  return Boolean(
    (insecure && !server.allowInsecure) ||
      (unsafeRemoteRoot(server) && !server.allowUnsafeRemoteRoot) ||
      (server.protocol === "sftp" && server.hostKeySha256.length === 0 && !server.allowUnknownHostKey)
  );
}

function sampleWithOmitted(items, limit = DEPLOY_SAMPLE_LIMIT) {
  const sample = items.slice(0, limit);
  return { sample, omitted: Math.max(0, items.length - sample.length) };
}

function fitListServerSamples(
  servers,
  errors,
  serverTotal = servers.length,
  errorTotal = errors.length
) {
  const serverSample = servers.slice(0, 20);
  const errorSample = errors.slice(0, 20);
  while (
    (serverSample.length > 0 || errorSample.length > 0) &&
    utf8Size({ servers: serverSample, errors: errorSample }) > STRUCTURED_SAMPLE_BUDGET
  ) {
    if (errorSample.length > 0) errorSample.pop();
    else serverSample.pop();
  }
  return {
    servers: serverSample,
    serversOmitted: serverTotal - serverSample.length,
    errors: errorSample,
    errorsOmitted: errorTotal - errorSample.length,
  };
}

function projectedListEntry(entry) {
  return {
    name: boundedString(entry.name),
    type: entry.type === "dir" || entry.type === "link" ? entry.type : "file",
    size_bytes: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0,
    modified_at: entry.modifiedAt ? boundedString(entry.modifiedAt, 512) : null,
  };
}

function fitListPage(meta, entries) {
  const page = [];
  for (const entry of entries) {
    page.push(projectedListEntry(entry));
    if (page.length > 1 && utf8Size({ ...meta, entries: page }) > STRUCTURED_SAMPLE_BUDGET) {
      page.pop();
      break;
    }
  }
  return page;
}

function boundedDeploySamples(items, project = (item) => item) {
  const selected = items.slice(0, DEPLOY_SAMPLE_LIMIT);
  const sample = selected.map((item) => {
    const projected = project(item);
    return {
      path: boundedString(projected.path),
      size_bytes:
        typeof projected.size_bytes === "number" && projected.size_bytes >= 0 ? projected.size_bytes : 0,
    };
  });
  while (sample.length > 1 && utf8Size(sample) > STRUCTURED_SAMPLE_BUDGET) sample.pop();
  return { sample, omitted: items.length - sample.length };
}

// ---- registration ---------------------------------------------------------

export function registerTools(server, loaded, options = {}) {
  const connectAdapter = options.openAdapter || openAdapter;
  const redactor = createRedactor(loaded && loaded.config);
  const guardTool = (handler) => guard(handler, redactor);
  const useServer = (requested, opts, run) =>
    withServer(loaded, requested, opts, run, connectAdapter);
  const serverField = z
    .string()
    .optional()
    .describe("Name of the configured server. Defaults to the configured default, or the sole server.");

  // 1. ftp_list_servers
  server.registerTool(
    "ftp_list_servers",
    {
      title: "List configured servers",
      description:
        "List all configured FTP/FTPS/SFTP servers (name, protocol, host, port, root, read-only, auth kind) and which is default. Never reveals passwords or keys.",
      inputSchema: {},
      outputSchema: OUTPUT_SCHEMAS.listServers,
      annotations: annotations(true, false, true, false),
    },
    guardTool(async () => {
      if (!loaded.found || loaded.error || !loaded.config) {
        const invalidNames = loaded.invalidServerNames || [];
        const errorTotal = (loaded.error ? 1 : 0) + invalidNames.length;
        const errorItems = loaded.error
          ? [{ server: null, message: boundedString(loaded.error) }]
          : [];
        for (const name of invalidNames.slice(0, Math.max(0, 20 - errorItems.length))) {
          errorItems.push({
            server: boundedString(name),
            message: boundedString(loaded.serverErrors && loaded.serverErrors[name]),
          });
        }
        const samples = fitListServerSamples([], errorItems, 0, errorTotal);
        return successResult(configHelpText(loaded), {
          status: loaded.found ? "invalid" : "missing",
          configured_count: invalidNames.length,
          valid_count: 0,
          invalid_count: invalidNames.length,
          default_server: null,
          servers: [],
          servers_omitted: 0,
          errors: samples.errors,
          errors_omitted: samples.errorsOmitted,
        });
      }
      const names = loaded.serverNames;
      const invalidNames = loaded.invalidServerNames || [];
      const lines = [`Configured servers (${names.length + invalidNames.length}):`, ""];
      const structuredServers = [];
      for (const name of names) {
        const s = normalizeServer(name, loaded.config.servers[name]);
        const isDefault =
          loaded.defaultServer === name || (!loaded.defaultServer && names.length === 1);
        const auth = s.privateKeyPath ? "key" : "password";
        const insecure = insecureTransport(s);
        const flags = [];
        if (isDefault) flags.push("default");
        if (s.readOnly) flags.push("read-only");
        if (insecure) flags.push("⚠ INSECURE");
        if (unsafeRemoteRoot(s)) flags.push("⚠ UNSAFE ROOT");
        if (s.protocol === "sftp" && s.hostKeySha256.length === 0) flags.push("⚠ HOST KEY");
        const suffix = flags.length ? `  [${flags.join(", ")}]` : "";
        lines.push(`- ${name}${suffix}`);
        const protoLabel = s.implicitTLS ? `${s.protocol} (implicit)` : s.protocol;
        lines.push(
          `    ${protoLabel}://${s.host}:${s.port}   root=${normalizeRoot(s.root)}   auth=${auth}`
        );
        lines.push(`    localRoot=${localRootStatus(s)}`);
        if (insecure) {
          lines.push(
            s.allowInsecure
              ? `    ⚠ ${insecureLabel(insecure)} — explicitly allowed by "allowInsecure": true; prefer sftp`
              : `    ⚠ ${insecureLabel(insecure)} — connections are REFUSED until "allowInsecure": true is set; prefer sftp`
          );
        }
        if (unsafeRemoteRoot(s)) {
          lines.push(
            s.allowUnsafeRemoteRoot
              ? `    ⚠ FTP/FTPS sub-root is explicitly allowed by "allowUnsafeRemoteRoot": true; it is not a reliable symlink jail`
              : `    ⚠ FTP/FTPS sub-root is REFUSED until "allowUnsafeRemoteRoot": true is set or a server-side chroot is used`
          );
        }
        if (s.protocol === "sftp" && s.hostKeySha256.length === 0) {
          lines.push(
            s.allowUnknownHostKey
              ? `    ⚠ SFTP host identity is not verified; explicitly allowed by "allowUnknownHostKey": true`
              : `    ⚠ SFTP connections are REFUSED until "hostKeySha256" is configured or "allowUnknownHostKey": true is set`
          );
        }
        if (structuredServers.length < 20) {
          structuredServers.push({
            name: boundedString(name),
            protocol: s.protocol,
            host: boundedString(s.host),
            port: s.port,
            root: boundedString(normalizeRoot(s.root)),
            read_only: s.readOnly,
            auth,
            is_default: isDefault,
            local_root_status: localRootStatus(s),
            connection_refused: connectionRefused(s),
            security_warning: securityWarning(s),
          });
        }
      }
      const structuredErrors = [];
      for (const name of invalidNames) {
        lines.push(`- ${name}  [INVALID — REFUSED]`);
        lines.push(`    ${loaded.serverErrors[name]}`);
        if (structuredErrors.length < 20) {
          structuredErrors.push({
            server: boundedString(name),
            message: boundedString(loaded.serverErrors[name]),
          });
        }
      }
      const samples = fitListServerSamples(
        structuredServers,
        structuredErrors,
        names.length,
        invalidNames.length
      );
      return successResult(lines.join("\n"), {
        status: "configured",
        configured_count: names.length + invalidNames.length,
        valid_count: names.length,
        invalid_count: invalidNames.length,
        default_server: loaded.defaultServer ? boundedString(loaded.defaultServer) : null,
        servers: samples.servers,
        servers_omitted: samples.serversOmitted,
        errors: samples.errors,
        errors_omitted: samples.errorsOmitted,
      });
    })
  );

  // 2. ftp_test
  server.registerTool(
    "ftp_test",
    {
      title: "Test a server connection",
      description: "Connect to a server, list its root directory, and report success.",
      inputSchema: { server: serverField },
      outputSchema: OUTPUT_SCHEMAS.test,
      annotations: annotations(true, false, true, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: false }, async ({ server: s, adapter }) => {
        const root = resolveRemote(s.root, "");
        const entries = await adapter.list(root);
        return successResult(
          `OK — connected to ${s.protocol}://${s.host}:${s.port}, root ${root}, ${entries.length} entries visible`,
          {
            server: boundedString(s.name),
            protocol: s.protocol,
            host: boundedString(s.host),
            port: s.port,
            root: boundedString(root),
            entries_visible: entries.length,
            security_warning: securityWarning(s),
          }
        );
      })
    )
  );

  // 3. ftp_list
  server.registerTool(
    "ftp_list",
    {
      title: "List a remote directory",
      description:
        "List the contents of a remote directory (relative to the server root). Directories are listed first.",
      inputSchema: {
        server: serverField,
        path: z.string().optional().describe("Remote directory, relative to the server root. Defaults to the root."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum entries to return (default 50, maximum 200)."),
        offset: z.number().int().nonnegative().optional().describe("Zero-based entry offset (default 0)."),
      },
      outputSchema: OUTPUT_SCHEMAS.list,
      annotations: annotations(true, false, true, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: false }, async ({ server: s, adapter }) => {
        const target = resolveRemote(s.root, args.path ?? "");
        const entries = await adapter.list(target);
        entries.sort((a, b) => {
          const ad = a.type === "dir" ? 0 : 1;
          const bd = b.type === "dir" ? 0 : 1;
          if (ad !== bd) return ad - bd;
          return a.name.localeCompare(b.name);
        });
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        const total = entries.length;
        const warning = securityWarning(s);
        const candidates = entries.slice(offset, offset + limit);
        const projectedPage = fitListPage(
          {
            server: boundedString(s.name),
            path: boundedString(target),
            total,
            offset,
            limit,
            security_warning: warning,
          },
          candidates
        );
        const page = candidates.slice(0, projectedPage.length);
        const count = projectedPage.length;
        const hasMore = offset + count < total;
        const nextOffset = hasMore ? offset + count : null;
        const pageLine = `Page: offset ${offset}, count ${count}, limit ${limit}; ${
          nextOffset === null ? "no next offset" : `next offset ${nextOffset}`
        }.`;
        const showPagination = args.limit !== undefined || args.offset !== undefined || total > 50;
        const lines = [`Contents of ${target} (${entries.length} entries):`];
        if (showPagination) lines.push(pageLine);
        lines.push("");
        if (entries.length === 0) {
          lines.push("(empty directory)");
        } else if (page.length === 0) {
          lines.push(`(no entries at offset ${offset})`);
        } else {
          for (const e of page) {
            if (e.type === "dir") {
              lines.push(`[DIR] ${e.name}`);
            } else if (e.type === "link") {
              lines.push(`[LINK] ${e.name}`);
            } else {
              const when = e.modifiedAt ? `, ${e.modifiedAt}` : "";
              lines.push(`[FILE] ${e.name} (${formatSize(e.size)}${when})`);
            }
          }
        }
        return successResult(lines.join("\n"), {
          server: boundedString(s.name),
          path: boundedString(target),
          total,
          count,
          offset,
          limit,
          has_more: hasMore,
          next_offset: nextOffset,
          entries: projectedPage,
          security_warning: warning,
        });
      })
    )
  );

  // 4. ftp_read
  server.registerTool(
    "ftp_read",
    {
      title: "Read a remote text file",
      description:
        "Read a remote text file and return its content. Binary files are refused (use ftp_download instead).",
      inputSchema: {
        server: serverField,
        path: z.string().describe("Remote file path, relative to the server root."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum bytes to read (default ${READ_DEFAULT_BYTES}, hard max ${READ_MAX_BYTES}).`),
      },
      annotations: annotations(true, false, true, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: false }, async ({ server: s, adapter }) => {
        let maxBytes = args.max_bytes ?? READ_DEFAULT_BYTES;
        if (maxBytes > READ_MAX_BYTES) maxBytes = READ_MAX_BYTES;
        if (maxBytes < 1) maxBytes = 1;
        const target = resolveRemote(s.root, args.path);
        const { buffer, truncated } = await adapter.readFile(target, maxBytes);
        const scan = Math.min(buffer.length, 8192);
        for (let i = 0; i < scan; i++) {
          if (buffer[i] === 0) {
            return textResult(
              `Refused: ${target} looks like a binary file (NUL byte found in the first ${scan} bytes). Use ftp_download to fetch it.`
            );
          }
        }
        const note = truncated ? ` — TRUNCATED at ${maxBytes} bytes` : "";
        const header = `File ${target} (${formatSize(buffer.length)}${note}):`;
        return textResult(`${header}\n\n${buffer.toString("utf8")}`);
      })
    )
  );

  // 5. ftp_upload
  server.registerTool(
    "ftp_upload",
    {
      title: "Upload a local file",
      description:
        "Upload one local file to the server, auto-creating parent directories. Remote path defaults to the file basename at the root.",
      inputSchema: {
        server: serverField,
        local_path: z.string().describe("Local file path, absolute or relative to the server's configured localRoot."),
        remote_path: z
          .string()
          .optional()
          .describe("Destination remote path, relative to the server root. Defaults to the local basename at the root."),
      },
      outputSchema: OUTPUT_SCHEMAS.upload,
      annotations: annotations(false, true, false, true),
    },
    guardTool(async (args) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      try {
        const source = resolveLocalSource(s, args.local_path, "file");
        const base = path.basename(source.path);
        const remoteRel = args.remote_path && args.remote_path.trim() ? args.remote_path : base;
        const target = resolveRemote(s.root, remoteRel);
        return await withResolvedServer(
          name,
          s,
          { write: true },
          async ({ adapter }) => {
            await adapter.uploadFile(source.path, target);
            return successResult(
              `Uploaded ${source.path} -> ${target} (${formatSize(source.stat.size)}) on ${s.protocol}://${s.host}`,
              {
                server: boundedString(name),
                local_path: boundedString(source.path),
                remote_path: boundedString(target),
                size_bytes: source.stat.size,
                security_warning: securityWarning(s),
              }
            );
          },
          connectAdapter
        );
      } catch (err) {
        throw withTransportError(err, s);
      }
    })
  );

  // 6. ftp_deploy
  server.registerTool(
    "ftp_deploy",
    {
      title: "Deploy a local directory",
      description:
        "Recursively upload a local directory to the server over a single connection, applying default and custom exclude globs (and optional include globs). Supports dry_run.",
      inputSchema: {
        server: serverField,
        local_dir: z.string().describe("Local directory to deploy, absolute or relative to the server's configured localRoot."),
        remote_dir: z
          .string()
          .optional()
          .describe("Destination remote directory, relative to the server root. Defaults to the root."),
        include: z
          .array(z.string())
          .optional()
          .describe("Glob patterns; when given, a file must match at least one to be uploaded."),
        exclude: z.array(z.string()).optional().describe("Extra glob patterns to exclude, added to the built-in defaults."),
        dry_run: z.boolean().optional().describe("If true, list what would be uploaded without connecting."),
      },
      outputSchema: OUTPUT_SCHEMAS.deploy,
      annotations: annotations(false, true, false, true),
    },
    guardTool(async (args) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      try {
        const source = resolveLocalSource(s, args.local_dir, "directory");
        const files = selectDeployFiles(source.path, args.include, args.exclude);
        const remoteBase = resolveRemote(s.root, args.remote_dir ?? "");
        const totalBytes = files.reduce((a, f) => a + f.size, 0);

        if (args.dry_run) {
          // dry_run performs zero network I/O, so it's allowed even on a
          // read-only server — only a real deploy is blocked below.
          const lines = [
            `Dry run — would upload ${files.length} files (${formatSize(totalBytes)}) to ${remoteBase} on "${name}". No connection was made.`,
            "",
          ];
          const shown = files.slice(0, DEPLOY_SAMPLE_LIMIT);
          for (const f of shown) lines.push(`  ${f.rel} (${formatSize(f.size)})`);
          if (files.length > shown.length) lines.push(`  ... and ${files.length - shown.length} more`);
          if (files.length === 0) lines.push("  (nothing matches — check include/exclude globs)");
          if (s.readOnly) {
            lines.push("");
            lines.push(`Note: server "${name}" is read-only — a real deploy will be refused.`);
          }
          for (const message of dryRunPolicyMessages(name, s)) {
            lines.push("");
            lines.push(`Note: ${message}`);
          }
          const planned = boundedDeploySamples(files, (file) => ({
            path: file.rel,
            size_bytes: file.size,
          }));
          return withTransportNotices(
            successResult(lines.join("\n"), {
              mode: "dry_run",
              server: boundedString(name),
              remote_base: boundedString(remoteBase),
              total_files: files.length,
              total_bytes: totalBytes,
              uploaded_count: 0,
              uploaded_bytes: 0,
              failed_count: 0,
              aborted_early: false,
              complete: true,
              duration_ms: 0,
              security_warning: securityWarning(s),
              uploaded: [],
              uploaded_omitted: 0,
              planned: planned.sample,
              planned_omitted: planned.omitted,
              failures: [],
              failures_omitted: 0,
            }),
            s
          );
        }

        if (s.readOnly) {
          throw new Error(
            `server "${name}" is read-only — upload, deploy, mkdir, rename and delete are blocked`
          );
        }

        if (files.length === 0) {
          return withTransportNotices(
            successResult(
              `Nothing to deploy to ${remoteBase} on "${name}" — no files matched (check include/exclude globs).`,
              {
                mode: "deploy",
                server: boundedString(name),
                remote_base: boundedString(remoteBase),
                total_files: 0,
                total_bytes: 0,
                uploaded_count: 0,
                uploaded_bytes: 0,
                failed_count: 0,
                aborted_early: false,
                complete: true,
                duration_ms: 0,
                security_warning: securityWarning(s),
                uploaded: [],
                uploaded_omitted: 0,
                planned: [],
                planned_omitted: 0,
                failures: [],
                failures_omitted: 0,
              }
            ),
            s
          );
        }

        const t0 = Date.now();
        const created = new Set();
        const uploadedList = [];
        const failures = [];
        let bytes = 0;
        let consecutive = 0;
        let abortedEarly = false;
        let adapter = null;
        let deployFailure = null;
        let closeFailure = null;

        try {
          adapter = await connectAdapter(s);
          try {
            for (const f of files) {
              const relForRemote = args.remote_dir
                ? posix.join(String(args.remote_dir).replace(/\\/g, "/"), f.rel)
                : f.rel;
              try {
                const target = resolveRemote(s.root, relForRemote);
                const parent = posix.dirname(target);
                if (parent && parent !== "/" && !created.has(parent)) {
                  await adapter.mkdirp(parent);
                  created.add(parent);
                }
                await adapter.uploadFile(f.abs, target);
                uploadedList.push({ path: f.rel, size_bytes: f.size });
                bytes += f.size;
                consecutive = 0;
              } catch (err) {
                failures.push(`${f.rel}: ${err.message}`);
                consecutive += 1;
                if (consecutive > 5) {
                  abortedEarly = true;
                  break;
                }
              }
            }
          } catch (err) {
            deployFailure = err;
          }
        } catch (err) {
          deployFailure = err;
        } finally {
          if (adapter) {
            try {
              await adapter.close();
            } catch (err) {
              closeFailure = err;
            }
          }
        }

        const durationMs = Date.now() - t0;
        const secs = (durationMs / 1000).toFixed(1);
        if (deployFailure) failures.push(`deploy: ${deployFailure.message}`);
        if (closeFailure) failures.push(`connection close: ${closeFailure.message}`);
        const partial =
          failures.length > 0 ||
          abortedEarly ||
          uploadedList.length !== files.length ||
          deployFailure !== null ||
          closeFailure !== null;
        const lines = partial ? ["PARTIAL DEPLOY — ERROR"] : [];
        lines.push(
          `Deployed ${uploadedList.length}/${files.length} files (${formatSize(bytes)}) to ${remoteBase} on "${name}" in ${secs}s.`
        );
        if (abortedEarly) {
          lines.push("ABORTED after more than 5 consecutive failures — this is a partial deploy.");
        }
        lines.push("");
        lines.push("Uploaded:");
        const shown = uploadedList.slice(0, DEPLOY_SAMPLE_LIMIT);
        for (const item of shown) lines.push(`  ${item.path}`);
        if (uploadedList.length > shown.length) lines.push(`  ... and ${uploadedList.length - shown.length} more`);
        if (uploadedList.length === 0) lines.push("  (none)");
        if (failures.length) {
          lines.push("");
          lines.push(`Failures (${failures.length}):`);
          const shownFailures = failures.slice(0, DEPLOY_SAMPLE_LIMIT);
          for (const fmsg of shownFailures) lines.push(`  ${fmsg}`);
          if (failures.length > shownFailures.length) {
            lines.push(`  ... and ${failures.length - shownFailures.length} more`);
          }
        }
        const text = lines.join("\n");
        if (partial) return withTransportNotices(explicitErrorResult(text), s);
        const uploaded = boundedDeploySamples(uploadedList);
        return withTransportNotices(
          successResult(text, {
            mode: "deploy",
            server: boundedString(name),
            remote_base: boundedString(remoteBase),
            total_files: files.length,
            total_bytes: totalBytes,
            uploaded_count: uploadedList.length,
            uploaded_bytes: bytes,
            failed_count: 0,
            aborted_early: false,
            complete: true,
            duration_ms: durationMs,
            security_warning: securityWarning(s),
            uploaded: uploaded.sample,
            uploaded_omitted: uploaded.omitted,
            planned: [],
            planned_omitted: 0,
            failures: [],
            failures_omitted: 0,
          }),
          s
        );
      } catch (err) {
        throw withTransportError(err, s);
      }
    })
  );

  // 7. ftp_download
  server.registerTool(
    "ftp_download",
    {
      title: "Download a remote file",
      description: "Download a remote file to a local path, auto-creating local parent directories. Refuses to overwrite unless overwrite:true.",
      inputSchema: {
        server: serverField,
        remote_path: z.string().describe("Remote file path, relative to the server root."),
        local_path: z.string().describe("Local destination path, absolute or relative to the server's configured localRoot."),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing local file."),
      },
      outputSchema: OUTPUT_SCHEMAS.download,
      annotations: annotations(false, true, false, true),
    },
    guardTool(async (args) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      try {
        const target = resolveRemote(s.root, args.remote_path);
        const destination = resolveLocalDestination(s, args.local_path);
        if (destination.exists && !args.overwrite) {
          throw new Error(
            `local file already exists inside "localRoot" — pass overwrite:true to replace it`
          );
        }
        return await withResolvedServer(
          name,
          s,
          { write: false },
          async ({ adapter }) => {
            await adapter.downloadFile(target, destination.path);
            const written = resolveLocalDestination(s, args.local_path);
            return successResult(
              `Downloaded ${target} -> ${written.path} (${formatSize(written.stat.size)})`,
              {
                server: boundedString(name),
                remote_path: boundedString(target),
                local_path: boundedString(written.path),
                size_bytes: written.stat.size,
                overwritten: destination.exists,
                security_warning: securityWarning(s),
              }
            );
          },
          connectAdapter
        );
      } catch (err) {
        throw withTransportError(err, s);
      }
    })
  );

  // 8. ftp_mkdir
  server.registerTool(
    "ftp_mkdir",
    {
      title: "Create a remote directory",
      description: "Recursively create a remote directory (relative to the server root).",
      inputSchema: {
        server: serverField,
        path: z.string().describe("Remote directory to create, relative to the server root."),
      },
      outputSchema: OUTPUT_SCHEMAS.mkdir,
      annotations: annotations(false, false, true, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: true }, async ({ server: s, adapter }) => {
        const target = resolveRemote(s.root, args.path);
        await adapter.mkdirp(target);
        return successResult(`Created directory ${target}`, {
          server: boundedString(s.name),
          path: boundedString(target),
          created: true,
          security_warning: securityWarning(s),
        });
      })
    )
  );

  // 9. ftp_rename
  server.registerTool(
    "ftp_rename",
    {
      title: "Rename or move a remote entry",
      description: "Rename or move a remote file or directory (both paths relative to the server root).",
      inputSchema: {
        server: serverField,
        from_path: z.string().describe("Existing remote path, relative to the server root."),
        to_path: z.string().describe("New remote path, relative to the server root."),
      },
      outputSchema: OUTPUT_SCHEMAS.rename,
      annotations: annotations(false, true, false, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: true }, async ({ server: s, adapter }) => {
        if (isRootPath(s.root, args.from_path)) throw new Error("refusing to rename the server root");
        if (isRootPath(s.root, args.to_path)) throw new Error("refusing to overwrite the server root");
        const from = resolveRemote(s.root, args.from_path);
        const to = resolveRemote(s.root, args.to_path);
        await adapter.rename(from, to);
        return successResult(`Renamed ${from} -> ${to}`, {
          server: boundedString(s.name),
          from_path: boundedString(from),
          to_path: boundedString(to),
          moved: true,
          security_warning: securityWarning(s),
        });
      })
    )
  );

  // 10. ftp_delete
  server.registerTool(
    "ftp_delete",
    {
      title: "Delete a remote file or directory",
      description:
        "Delete a remote file, or a directory when recursive:true. Never deletes the server root.",
      inputSchema: {
        server: serverField,
        path: z.string().describe("Remote path to delete, relative to the server root."),
        recursive: z.boolean().optional().describe("Required to delete a directory and its contents."),
      },
      outputSchema: OUTPUT_SCHEMAS.delete,
      annotations: annotations(false, true, true, true),
    },
    guardTool((args) =>
      useServer(args.server, { write: true }, async ({ server: s, adapter }) => {
        if (isRootPath(s.root, args.path)) throw new Error("refusing to delete the server root directory");
        const target = resolveRemote(s.root, args.path);
        const st = await adapter.stat(target);
        if (st.type === "dir") {
          if (!args.recursive) {
            throw new Error(`"${target}" is a directory — pass recursive:true to delete it`);
          }
          await adapter.deleteDir(target);
          return successResult(`Deleted directory (recursive) ${target}`, {
            server: boundedString(s.name),
            path: boundedString(target),
            entry_type: "directory",
            recursive: true,
            deleted: true,
            security_warning: securityWarning(s),
          });
        }
        await adapter.deleteFile(target);
        return successResult(`Deleted file ${target}`, {
          server: boundedString(s.name),
          path: boundedString(target),
          entry_type: "file",
          recursive: false,
          deleted: true,
          security_warning: securityWarning(s),
        });
      })
    )
  );
}

export const TOOL_NAMES = [
  "ftp_list_servers",
  "ftp_test",
  "ftp_list",
  "ftp_read",
  "ftp_upload",
  "ftp_deploy",
  "ftp_download",
  "ftp_mkdir",
  "ftp_rename",
  "ftp_delete",
];
