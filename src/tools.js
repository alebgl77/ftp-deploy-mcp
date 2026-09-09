// MCP tool definitions. Each tool:
//   - resolves which configured server to use,
//   - enforces the remote-path jail and readOnly flag,
//   - opens a fresh connection, runs the op, closes it in finally,
//   - never throws to the transport (errors become isError results),
//   - never leaks credentials.
//
// Human-facing output uses the immutable locale selected at server startup.

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

import {
  resolveServer,
  configRedactor,
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
import { connectOperation, remoteLockKey, localLockKey } from "./operations.js";
import { createI18n } from "./i18n.js";
import { appError, normalizeError, nativeError, renderError, withSecondary } from "./errors.js";
import { createToolRegistry, addNotices, withRenderMetadata, utf8Size, truncateUtf8 } from "./tool-registry.js";
import { checkTransferSize, checkDeploySelection, hashLocalFile, uploadVerified, downloadVerified } from "./transfers.js";
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
  ".ftp-mcp-*.tmp",
  "**/.ftp-mcp/**",
];

const READ_DEFAULT_BYTES = 262144;
const READ_MAX_BYTES = 1048576;
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

function boundedString(value, maxBytes = 2048, i18n = createI18n()) {
  return truncateUtf8(value == null ? "" : value, maxBytes, i18n.t("error.truncated"));
}

function formatSize(n) {
  if (typeof n !== "number" || n < 0) return "? B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function openAdapter(serverCfg, operation) {
  const mod = serverCfg.protocol === "sftp" ? sftpAdapter : ftpAdapter;
  return mod.connect(serverCfg, operation);
}

// Append a loud, visible security warning to a tool result when the server
// uses an explicitly-allowed insecure transport. Secure servers pass through.
function transportWarningTexts(server, i18n = createI18n()) {
  // Bound only displayed parameters; policy decisions use the original config.
  const shown = { ...server, name: boundedString(server.name, 256, i18n), root: boundedString(server.root, 256, i18n) };
  return [insecureWarningText(shown, i18n), unsafeRemoteRootWarningText(shown, i18n),
    unknownHostKeyWarningText(shown, i18n)].filter(Boolean);
}

function withTransportNotices(result, server, i18n = createI18n()) {
  return addNotices(result, transportWarningTexts(server, i18n));
}

function withTransportError(error) { return normalizeError(error); }

function requireConfig(loaded) {
  if (!loaded.found || loaded.error || !loaded.config) {
    throw loaded.failure || appError(loaded.found ? "CONFIG_INVALID" : "CONFIG_REQUIRED",
      loaded.found ? "error.CONFIG_INVALID" : "error.CONFIG_REQUIRED", { detail: loaded.error ?? "" });
  }
}

// Resolve server, optionally block writes on read-only servers, connect,
// run `run({ name, server, adapter })`, and always close.
async function withResolvedServer(name, server, opts, run, connectAdapter) {
  const write = opts && opts.write;
  const operation = opts.operation;
  try {
    if (write && server.readOnly) {
      throw appError("READ_ONLY", "runtime.tools.readOnly", { name });
    }
    return await operation.lock(write ? [remoteLockKey(server)] : (opts.lockKeys || []), async () => {
      operation.check();
      await operation.step(() => opts.beforeConnect?.());
      const adapter = await connectOperation(connectAdapter, server, operation);
      operation.progress();
      let result;
      let operationError = null;
      let operationFailed = false;
      try {
        result = await operation.step(() => run({ name, server, adapter, operation }));
        operation.progress();
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
          const secondary = nativeError(closeError, "transport");
          throw withSecondary(operationError, "error.close", { detail: secondary });
        }
        throw operationError;
      }
      if (closeFailed) throw nativeError(closeError, "transport");
      return withTransportNotices(result, server, operation.i18n);
    });
  } catch (err) {
    throw withTransportError(err, server);
  }
}

async function withServer(loaded, requestedServer, opts, run, connectAdapter) {
  requireConfig(loaded);
  const { name, server } = resolveServer(loaded, requestedServer);
  return withResolvedServer(name, server, opts, run, connectAdapter);
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
      throw appError("PATH_REJECTED", "runtime.tools.directoryReadFailed", { path: absDir, error: err.message }, { origin: "local" });
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

function dryRunPolicyMessages(name, server, i18n) {
  const { t } = i18n;
  const messages = [];
  const insecure = insecureTransport(server);
  if (insecure && !server.allowInsecure) {
    messages.push(
      t("runtime.tools.dryRunInsecure", { name, label: insecureLabel(insecure, i18n) })
    );
  }
  if (unsafeRemoteRoot(server) && !server.allowUnsafeRemoteRoot) {
    messages.push(t("runtime.tools.realDeployRefused", { message: unsafeRemoteRootBlockedMessage(name, server.root, i18n) }));
  }
  if (
    server.protocol === "sftp" &&
    server.hostKeySha256.length === 0 &&
    !server.allowUnknownHostKey
  ) {
    messages.push(t("runtime.tools.realDeployRefused", { message: unknownHostKeyBlockedMessage(name, i18n) }));
  }
  return messages;
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

function projectedListEntry(entry, i18n) {
  return {
    name: boundedString(entry.name, 2048, i18n),
    type: entry.type === "dir" || entry.type === "link" ? entry.type : "file",
    size_bytes: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0,
    modified_at: entry.modifiedAt ? boundedString(entry.modifiedAt, 512, i18n) : null,
  };
}

function fitListPage(meta, entries, i18n) {
  const page = [];
  for (const entry of entries) {
    page.push(projectedListEntry(entry, i18n));
    if (page.length > 1 && utf8Size({ ...meta, entries: page }) > STRUCTURED_SAMPLE_BUDGET) {
      page.pop();
      break;
    }
  }
  return page;
}

function boundedDeploySamples(items, project = (item) => item, i18n = createI18n()) {
  const selected = items.slice(0, DEPLOY_SAMPLE_LIMIT);
  const sample = selected.map((item) => {
    const projected = project(item);
    return {
      path: boundedString(projected.path, 2048, i18n),
      size_bytes:
        typeof projected.size_bytes === "number" && projected.size_bytes >= 0 ? projected.size_bytes : 0,
    };
  });
  while (sample.length > 1 && utf8Size(sample) > STRUCTURED_SAMPLE_BUDGET) sample.pop();
  return { sample, omitted: items.length - sample.length };
}

// ---- registration ---------------------------------------------------------

export function registerTools(sdkServer, loaded, options = {}) {
  const i18n = options.i18n ?? createI18n();
  const { t } = i18n;
  const connectAdapter = options.openAdapter || openAdapter;
  const redactor = configRedactor(loaded);
  const selected = (args) => { try { return resolveServer(loaded, args?.server).server; } catch { return null; } };
  const server = createToolRegistry({ redactor, i18n, transportContext: options.transportContext,
    timeoutFor: (args) => selected(args)?.operationTimeoutMs,
    errorNotices: (args) => { const resolved = selected(args); return resolved ? transportWarningTexts(resolved, i18n) : []; },
  });
  const guardTool = (handler) => handler;
  const boundedString = (value, max = 2048) => truncateUtf8(value, max, t("error.truncated"));
  const securityWarning = (resolved) => {
    const warnings = transportWarningTexts(resolved, i18n);
    return warnings.length ? boundedString(warnings.join("\n\n")) : null;
  };
  const withTransportNotices = (result, resolved) => addNotices(result, transportWarningTexts(resolved, i18n));
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
          ? [{ server: null, message: boundedString(loaded.failure ? renderError(loaded.failure, i18n) : loaded.error) }]
          : [];
        for (const name of invalidNames.slice(0, Math.max(0, 20 - errorItems.length))) {
          errorItems.push({
            server: boundedString(name),
            message: boundedString(loaded.serverFailures?.[name] ? renderError(loaded.serverFailures[name], i18n) : loaded.serverErrors?.[name]),
          });
        }
        const samples = fitListServerSamples([], errorItems, 0, errorTotal);
        return successResult(configHelpText(loaded, i18n), {
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
      const lines = [t("runtime.tools.servers.heading", { count: names.length + invalidNames.length }), ""];
      const structuredServers = [];
      for (const name of names) {
        const s = normalizeServer(name, loaded.config.servers[name]);
        const isDefault =
          loaded.defaultServer === name || (!loaded.defaultServer && names.length === 1);
        const auth = s.privateKeyPath ? "key" : "password";
        const insecure = insecureTransport(s);
        const flags = [];
        if (isDefault) flags.push(t("runtime.tools.servers.default"));
        if (s.readOnly) flags.push(t("runtime.tools.servers.readOnly"));
        if (insecure) flags.push(t("runtime.tools.servers.insecure"));
        if (unsafeRemoteRoot(s)) flags.push(t("runtime.tools.servers.unsafeRoot"));
        if (s.protocol === "sftp" && s.hostKeySha256.length === 0) flags.push(t("runtime.tools.servers.hostKey"));
        const suffix = flags.length ? `  [${flags.join(", ")}]` : "";
        lines.push(`- ${name}${suffix}`);
        const protoLabel = s.implicitTLS ? t("runtime.tools.servers.implicit", { protocol: s.protocol }) : s.protocol;
        lines.push(
          `    ${protoLabel}://${s.host}:${s.port}   root=${normalizeRoot(s.root)}   auth=${t(auth === "key" ? "doctor.key" : "doctor.password")}`
        );
        lines.push(`    localRoot=${localRootStatus(s, i18n)}`);
        if (insecure) {
          lines.push(
            s.allowInsecure
              ? t("runtime.tools.servers.insecureAllowed", { label: insecureLabel(insecure, i18n) })
              : t("runtime.tools.servers.insecureRefused", { label: insecureLabel(insecure, i18n) })
          );
        }
        if (unsafeRemoteRoot(s)) {
          lines.push(
            s.allowUnsafeRemoteRoot
              ? t("runtime.tools.servers.rootAllowed")
              : t("runtime.tools.servers.rootRefused")
          );
        }
        if (s.protocol === "sftp" && s.hostKeySha256.length === 0) {
          lines.push(
            s.allowUnknownHostKey
              ? t("runtime.tools.servers.keyAllowed")
              : t("runtime.tools.servers.keyRefused")
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
            local_root_status: localRootStatus(s, i18n),
            connection_refused: connectionRefused(s),
            security_warning: securityWarning(s),
          });
        }
      }
      const structuredErrors = [];
      for (const name of invalidNames) {
        lines.push(t("runtime.tools.servers.invalid", { name }));
        lines.push(`    ${loaded.serverFailures?.[name] ? renderError(loaded.serverFailures[name], i18n) : loaded.serverErrors[name]}`);
        if (structuredErrors.length < 20) {
          structuredErrors.push({
            server: boundedString(name),
            message: boundedString(loaded.serverFailures?.[name] ? renderError(loaded.serverFailures[name], i18n) : loaded.serverErrors[name]),
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
    guardTool((args, operation) =>
      useServer(args.server, { write: false, operation }, async ({ server: s, adapter }) => {
        const root = resolveRemote(s.root, "");
        const entries = await adapter.list(root);
        return successResult(
          t("runtime.tools.test.connected", { protocol: s.protocol, host: s.host, port: s.port, root, count: entries.length }),
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
    guardTool((args, operation) =>
      useServer(args.server, { write: false, operation }, async ({ server: s, adapter }) => {
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
          candidates, i18n
        );
        const count = projectedPage.length;
        const hasMore = offset + count < total;
        const structured = { server: boundedString(s.name), path: boundedString(target), total, count, offset, limit,
          has_more: hasMore, next_offset: hasMore ? offset + count : null, entries: projectedPage, security_warning: warning };
        const showPagination = args.limit !== undefined || args.offset !== undefined || total > 50;
        const renderPage = (data) => {
          const lines = [t("runtime.tools.list.heading", { path: data.path, count: data.total })];
          if (showPagination) lines.push(t("runtime.tools.page", { offset: data.offset, count: data.count, limit: data.limit,
            next: data.next_offset === null ? t("runtime.tools.pageNone") : t("runtime.tools.pageNext", { offset: data.next_offset }) }));
          lines.push("");
          if (!data.total) lines.push(t("runtime.tools.list.empty"));
          else if (!data.entries.length) lines.push(t("runtime.tools.list.noPage", { offset: data.offset }));
          for (const entry of data.entries) {
            if (entry.type === "dir" || entry.type === "link") {
              lines.push(t(entry.type === "dir" ? "runtime.tools.list.dir" : "runtime.tools.list.link", { name: entry.name }));
            } else lines.push(t("runtime.tools.list.file", { name: entry.name, size: formatSize(entry.size_bytes),
              modified: entry.modified_at ? `, ${entry.modified_at}` : "" }));
          }
          return lines.join("\n");
        };
        return withRenderMetadata(successResult(renderPage(structured), structured), { page: renderPage });
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
    guardTool((args, operation) =>
      useServer(args.server, { write: false, operation }, async ({ server: s, adapter }) => {
        let maxBytes = args.max_bytes ?? READ_DEFAULT_BYTES;
        if (maxBytes > READ_MAX_BYTES) maxBytes = READ_MAX_BYTES;
        if (maxBytes < 1) maxBytes = 1;
        const target = resolveRemote(s.root, args.path);
        const { buffer, truncated } = await adapter.readFile(target, maxBytes);
        const scan = Math.min(buffer.length, 8192);
        for (let i = 0; i < scan; i++) {
          if (buffer[i] === 0) {
            return textResult(
              t("runtime.tools.read.binary", { path: target, scan })
            );
          }
        }
        const note = truncated ? t("runtime.tools.read.truncated", { maxBytes }) : "";
        const header = t("runtime.tools.read.heading", { path: target, size: formatSize(buffer.length), note });
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
    guardTool(async (args, operation) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      operation.trackFiles(1);
      try {
        let source = resolveLocalSource(s, args.local_path, "file");
        checkTransferSize(source.stat.size, s.maxTransferBytes);
        let expected;
        const base = path.basename(source.path);
        const remoteRel = args.remote_path && args.remote_path.trim() ? args.remote_path : base;
        const target = resolveRemote(s.root, remoteRel);
        return await withResolvedServer(
          name,
          s,
          { write: true, operation, beforeConnect: async () => {
            source = resolveLocalSource(s, args.local_path, "file");
            expected = await hashLocalFile(source.path, s.maxTransferBytes, operation);
          } },
          async ({ adapter }) => {
            const transferred = await operation.fileAttempt(() => uploadVerified({
              adapter, source: source.path, target, maxBytes: s.maxTransferBytes, operation, expected,
            }));
            return successResult(
              t("runtime.tools.upload.done", { localPath: source.path, remotePath: target, size: formatSize(transferred.bytes), protocol: s.protocol, host: s.host }),
              {
                server: boundedString(name),
                local_path: boundedString(source.path),
                remote_path: boundedString(target),
                size_bytes: transferred.bytes,
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
    guardTool(async (args, operation) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      try {
        const source = resolveLocalSource(s, args.local_dir, "directory");
        const lexicalDir = path.resolve(s.localRoot, args.local_dir);
        const files = selectDeployFiles(source.path, args.include, args.exclude);
        const remoteBase = resolveRemote(s.root, args.remote_dir ?? "");
        let totalBytes = checkDeploySelection(files, s);
        if (!args.dry_run) operation.trackFiles(files.length);

        if (args.dry_run) {
          // dry_run performs zero network I/O, so it's allowed even on a
          // read-only server — only a real deploy is blocked below.
          const lines = [
            t("runtime.tools.deploy.dryRun", { count: files.length, size: formatSize(totalBytes), path: remoteBase, name }),
            "",
          ];
          const shown = files.slice(0, DEPLOY_SAMPLE_LIMIT);
          for (const f of shown) lines.push(`  ${f.rel} (${formatSize(f.size)})`);
          if (files.length > shown.length) lines.push(t("runtime.tools.deploy.more", { count: files.length - shown.length }));
          if (files.length === 0) lines.push(t("runtime.tools.deploy.noMatch"));
          if (s.readOnly) {
            lines.push("");
            lines.push(t("runtime.tools.deploy.readOnlyNote", { name }));
          }
          for (const message of dryRunPolicyMessages(name, s, i18n)) {
            lines.push("");
            lines.push(t("runtime.tools.deploy.note", { message }));
          }
          const planned = boundedDeploySamples(files, (file) => ({
            path: file.rel,
            size_bytes: file.size,
          }), i18n);
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
          throw appError("READ_ONLY", "runtime.tools.readOnly", { name });
        }

        if (files.length === 0) {
          return withTransportNotices(
            successResult(
              t("runtime.tools.deploy.nothing", { path: remoteBase, name }),
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
        return await operation.lock([remoteLockKey(s)], async () => {
          const created = new Set();
          const uploadedList = [];
          const failures = [];
          let bytes = 0;
          let attemptedBytes = 0;
          let consecutive = 0;
          let abortedEarly = false;
          let adapter = null;
          let deployFailure = null;
          let closeFailure = null;

          try {
            adapter = await connectOperation(connectAdapter, s, operation);
            operation.progress();
            try {
              for (const f of files) {
                operation.check();
                const relForRemote = args.remote_dir
                  ? posix.join(String(args.remote_dir).replace(/\\/g, "/"), f.rel)
                  : f.rel;
                try {
                  const target = resolveRemote(s.root, relForRemote);
                  const current = resolveLocalSource(s, path.resolve(lexicalDir, f.rel), "file");
                  const expected = await hashLocalFile(current.path, s.maxTransferBytes, operation);
                  if (expected.bytes > s.maxDeployBytes - attemptedBytes) {
                    throw appError("TRANSFER_LIMIT", "runtime.transfer.deployBytesLimit");
                  }
                  attemptedBytes += expected.bytes;
                  totalBytes += expected.bytes - f.size;
                  f.size = expected.bytes;
                  const parent = posix.dirname(target);
                  if (parent && parent !== "/" && !created.has(parent)) {
                    await adapter.mkdirp(parent);
                    created.add(parent);
                  }
                  await uploadVerified({
                    adapter, source: current.path, target, maxBytes: s.maxTransferBytes, operation, expected,
                  });
                  operation.progress();
                  uploadedList.push({ path: f.rel, size_bytes: f.size });
                  bytes += f.size;
                  consecutive = 0;
                } catch (err) {
                  operation.failFile();
                  operation.check();
                  failures.push(`${f.rel}: ${renderError(normalizeError(err), i18n)}`);
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

          operation.check();
          const durationMs = Date.now() - t0;
          const secs = (durationMs / 1000).toFixed(1);
          if (deployFailure) failures.push(t("runtime.tools.deploy.failureContext", { error: renderError(normalizeError(deployFailure), i18n) }));
          if (closeFailure) failures.push(t("runtime.tools.deploy.closeContext", { error: renderError(nativeError(closeFailure, "transport"), i18n) }));
          const partial =
            failures.length > 0 ||
            abortedEarly ||
            uploadedList.length !== files.length ||
            deployFailure !== null ||
            closeFailure !== null;
          const lines = [];
          lines.push(
            t("runtime.tools.deploy.summary", { uploaded: uploadedList.length, total: files.length, size: formatSize(bytes), path: remoteBase, name, seconds: secs })
          );
          if (abortedEarly) {
            lines.push(t("runtime.tools.deploy.aborted"));
          }
          lines.push("");
          if (failures.length) lines.push(t("runtime.tools.deploy.failures", { count: failures.length }));
          lines.push(t("runtime.tools.deploy.uploadedHeading"));
          const shown = uploadedList.slice(0, DEPLOY_SAMPLE_LIMIT);
          for (const item of shown) lines.push(`  ${item.path}`);
          if (uploadedList.length > shown.length) lines.push(t("runtime.tools.deploy.more", { count: uploadedList.length - shown.length }));
          if (uploadedList.length === 0) lines.push(t("runtime.tools.deploy.none"));
          if (failures.length) {
            lines.push("");
            lines.push(t("runtime.tools.deploy.failures", { count: failures.length }));
            const shownFailures = failures.slice(0, DEPLOY_SAMPLE_LIMIT);
            for (const fmsg of shownFailures) lines.push(`  ${fmsg}`);
            if (failures.length > shownFailures.length) {
              lines.push(t("runtime.tools.deploy.more", { count: failures.length - shownFailures.length }));
            }
          }
          const text = lines.join("\n");
          if (partial) throw appError("DEPLOY_PARTIAL", "error.DEPLOY_PARTIAL", { detail: text });
          const uploaded = boundedDeploySamples(uploadedList, undefined, i18n);
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
        });
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
    guardTool(async (args, operation) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      operation.trackFiles(1);
      try {
        const target = resolveRemote(s.root, args.remote_path);
        let destination = resolveLocalDestination(s, args.local_path);
        if (destination.exists && !args.overwrite) {
          throw appError("ALREADY_EXISTS", "runtime.tools.download.exists");
        }
        const destinationKey = localLockKey(destination.canonicalPath);
        const revalidate = () => {
          const current = resolveLocalDestination(s, args.local_path);
          if (localLockKey(current.canonicalPath) !== destinationKey) {
            throw appError("TARGET_CHANGED", "runtime.tools.download.targetChanged");
          }
          if (current.exists && !args.overwrite) {
            throw appError("ALREADY_EXISTS", "runtime.tools.download.exists");
          }
          destination = current;
          return current;
        };
        return await withResolvedServer(
          name,
          s,
          { write: false, operation, lockKeys: [destinationKey], beforeConnect: revalidate },
          async ({ adapter }) => {
            const transferred = await operation.fileAttempt(() => downloadVerified({
              adapter, remote: target, destination, maxBytes: s.maxTransferBytes,
              overwrite: args.overwrite === true, operation, revalidate,
            }));
            const written = resolveLocalDestination(s, args.local_path);
            return successResult(
              t("runtime.tools.download.done", { remotePath: target, localPath: written.path, size: formatSize(transferred.bytes) }) +
                (transferred.cleanupWarning ? `\n\n${transferred.cleanupWarning}` : ""),
              {
                server: boundedString(name),
                remote_path: boundedString(target),
                local_path: boundedString(written.path),
                size_bytes: transferred.bytes,
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
    guardTool((args, operation) =>
      useServer(args.server, { write: true, operation }, async ({ server: s, adapter }) => {
        const target = resolveRemote(s.root, args.path);
        await adapter.mkdirp(target);
        return successResult(t("runtime.tools.mkdir.done", { path: target }), {
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
    guardTool((args, operation) =>
      useServer(args.server, { write: true, operation }, async ({ server: s, adapter }) => {
        if (isRootPath(s.root, args.from_path)) throw appError("PATH_REJECTED", "runtime.tools.rename.root");
        if (isRootPath(s.root, args.to_path)) throw appError("PATH_REJECTED", "runtime.tools.rename.overwriteRoot");
        const from = resolveRemote(s.root, args.from_path);
        const to = resolveRemote(s.root, args.to_path);
        await adapter.rename(from, to);
        return successResult(t("runtime.tools.rename.done", { fromPath: from, toPath: to }), {
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
    guardTool((args, operation) =>
      useServer(args.server, { write: true, operation }, async ({ server: s, adapter }) => {
        if (isRootPath(s.root, args.path)) throw appError("PATH_REJECTED", "runtime.tools.delete.root");
        const target = resolveRemote(s.root, args.path);
        const st = await adapter.stat(target);
        if (st.type === "dir") {
          if (!args.recursive) {
            throw appError("INVALID_ARGUMENT", "runtime.tools.delete.recursiveRequired", { path: target });
          }
          await adapter.deleteDir(target);
          return successResult(t("runtime.tools.delete.directoryDone", { path: target }), {
            server: boundedString(s.name),
            path: boundedString(target),
            entry_type: "directory",
            recursive: true,
            deleted: true,
            security_warning: securityWarning(s),
          });
        }
        await adapter.deleteFile(target);
        return successResult(t("runtime.tools.delete.fileDone", { path: target }), {
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
  if (sdkServer) server.install(sdkServer);
  return server;
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
