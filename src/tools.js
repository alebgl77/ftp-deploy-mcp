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

// ---- small helpers --------------------------------------------------------

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function explicitErrorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
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
  const missing = warnings.filter((warning) => !msg.includes(warning));
  if (missing.length === 0) return err;
  return new Error(`${msg}\n\n${missing.join("\n\n")}`);
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
      return redactor.result(await fn(args || {}));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return errorResult(redactor.strictText(msg));
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
    },
    guardTool(async () => {
      if (!loaded.found || loaded.error || !loaded.config) {
        return textResult(configHelpText(loaded));
      }
      const names = loaded.serverNames;
      const invalidNames = loaded.invalidServerNames || [];
      const lines = [`Configured servers (${names.length + invalidNames.length}):`, ""];
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
      }
      for (const name of invalidNames) {
        lines.push(`- ${name}  [INVALID — REFUSED]`);
        lines.push(`    ${loaded.serverErrors[name]}`);
      }
      return textResult(lines.join("\n"));
    })
  );

  // 2. ftp_test
  server.registerTool(
    "ftp_test",
    {
      title: "Test a server connection",
      description: "Connect to a server, list its root directory, and report success.",
      inputSchema: { server: serverField },
    },
    guardTool((args) =>
      useServer(args.server, { write: false }, async ({ server: s, adapter }) => {
        const root = resolveRemote(s.root, "");
        const entries = await adapter.list(root);
        return textResult(
          `OK — connected to ${s.protocol}://${s.host}:${s.port}, root ${root}, ${entries.length} entries visible`
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
      },
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
        const lines = [`Contents of ${target} (${entries.length} entries):`, ""];
        if (entries.length === 0) {
          lines.push("(empty directory)");
        } else {
          for (const e of entries) {
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
        return textResult(lines.join("\n"));
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
            return textResult(
              `Uploaded ${source.path} -> ${target} (${formatSize(source.stat.size)}) on ${s.protocol}://${s.host}`
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
          const shown = files.slice(0, 100);
          for (const f of shown) lines.push(`  ${f.rel} (${formatSize(f.size)})`);
          if (files.length > 100) lines.push(`  ... and ${files.length - 100} more`);
          if (files.length === 0) lines.push("  (nothing matches — check include/exclude globs)");
          if (s.readOnly) {
            lines.push("");
            lines.push(`Note: server "${name}" is read-only — a real deploy will be refused.`);
          }
          for (const message of dryRunPolicyMessages(name, s)) {
            lines.push("");
            lines.push(`Note: ${message}`);
          }
          return withTransportNotices(textResult(lines.join("\n")), s);
        }

        if (s.readOnly) {
          throw new Error(
            `server "${name}" is read-only — upload, deploy, mkdir, rename and delete are blocked`
          );
        }

        if (files.length === 0) {
          return withTransportNotices(
            textResult(
              `Nothing to deploy to ${remoteBase} on "${name}" — no files matched (check include/exclude globs).`
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
                uploadedList.push(f.rel);
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

        const secs = ((Date.now() - t0) / 1000).toFixed(1);
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
        const shown = uploadedList.slice(0, 100);
        for (const r of shown) lines.push(`  ${r}`);
        if (uploadedList.length > 100) lines.push(`  ... and ${uploadedList.length - 100} more`);
        if (uploadedList.length === 0) lines.push("  (none)");
        if (failures.length) {
          lines.push("");
          lines.push(`Failures (${failures.length}):`);
          for (const fmsg of failures.slice(0, 100)) lines.push(`  ${fmsg}`);
          if (failures.length > 100) lines.push(`  ... and ${failures.length - 100} more`);
        }
        const text = lines.join("\n");
        return withTransportNotices(partial ? explicitErrorResult(text) : textResult(text), s);
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
            return textResult(`Downloaded ${target} -> ${written.path} (${formatSize(written.stat.size)})`);
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
    },
    guardTool((args) =>
      useServer(args.server, { write: true }, async ({ server: s, adapter }) => {
        const target = resolveRemote(s.root, args.path);
        await adapter.mkdirp(target);
        return textResult(`Created directory ${target}`);
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
    },
    guardTool((args) =>
      useServer(args.server, { write: true }, async ({ server: s, adapter }) => {
        if (isRootPath(s.root, args.from_path)) throw new Error("refusing to rename the server root");
        if (isRootPath(s.root, args.to_path)) throw new Error("refusing to overwrite the server root");
        const from = resolveRemote(s.root, args.from_path);
        const to = resolveRemote(s.root, args.to_path);
        await adapter.rename(from, to);
        return textResult(`Renamed ${from} -> ${to}`);
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
          return textResult(`Deleted directory (recursive) ${target}`);
        }
        await adapter.deleteFile(target);
        return textResult(`Deleted file ${target}`);
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
