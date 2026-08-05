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
} from "./config.js";
import { resolveRemote, isRootPath, normalizeRoot } from "./remote-path.js";
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
function withInsecureNotice(result, server) {
  const warn = insecureWarningText(server);
  if (!warn || !result || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: "text", text: warn }] };
}

// Same for the error path: guard() renders thrown errors as isError results,
// so the warning must ride inside the message — an op that failed may still
// have sent credentials over the insecure transport.
function withInsecureError(err, server) {
  const warn = insecureWarningText(server);
  if (!warn) return err;
  const msg = err && err.message ? err.message : String(err);
  if (msg.includes(warn)) return err;
  return new Error(`${msg}\n\n${warn}`);
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
async function withServer(loaded, requestedServer, opts, run) {
  const write = opts && opts.write;
  requireConfig(loaded);
  const { name, server } = resolveServer(loaded, requestedServer);
  try {
    if (write && server.readOnly) {
      throw new Error(
        `server "${name}" is read-only — upload, deploy, mkdir, rename and delete are blocked`
      );
    }
    const adapter = await openAdapter(server);
    try {
      return withInsecureNotice(await run({ name, server, adapter }), server);
    } finally {
      await adapter.close();
    }
  } catch (err) {
    throw withInsecureError(err, server);
  }
}

// Wrap a handler so any throw becomes a clean isError result.
function guard(fn) {
  return async (args, _extra) => {
    try {
      return await fn(args || {});
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return errorResult(msg);
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

// ---- registration ---------------------------------------------------------

export function registerTools(server, loaded) {
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
    guard(async () => {
      if (!loaded.found || loaded.error || !loaded.config) {
        return textResult(configHelpText(loaded));
      }
      const names = loaded.serverNames;
      const lines = [`Configured servers (${names.length}):`, ""];
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
        const suffix = flags.length ? `  [${flags.join(", ")}]` : "";
        lines.push(`- ${name}${suffix}`);
        const protoLabel = s.implicitTLS ? `${s.protocol} (implicit)` : s.protocol;
        lines.push(
          `    ${protoLabel}://${s.host}:${s.port}   root=${normalizeRoot(s.root)}   auth=${auth}`
        );
        if (insecure) {
          lines.push(
            s.allowInsecure
              ? `    ⚠ ${insecureLabel(insecure)} — explicitly allowed by "allowInsecure": true; prefer sftp`
              : `    ⚠ ${insecureLabel(insecure)} — connections are REFUSED until "allowInsecure": true is set; prefer sftp`
          );
        }
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
    guard((args) =>
      withServer(loaded, args.server, { write: false }, async ({ server: s, adapter }) => {
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
    guard((args) =>
      withServer(loaded, args.server, { write: false }, async ({ server: s, adapter }) => {
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
    guard((args) =>
      withServer(loaded, args.server, { write: false }, async ({ server: s, adapter }) => {
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
        local_path: z.string().describe("Local file path (relative paths resolve against the process cwd)."),
        remote_path: z
          .string()
          .optional()
          .describe("Destination remote path, relative to the server root. Defaults to the local basename at the root."),
      },
    },
    guard((args) =>
      withServer(loaded, args.server, { write: true }, async ({ server: s, adapter }) => {
        const localPath = path.resolve(process.cwd(), args.local_path);
        let st;
        try {
          st = fs.statSync(localPath);
        } catch {
          throw new Error(`local file not found: ${localPath}`);
        }
        if (!st.isFile()) throw new Error(`not a regular file: ${localPath}`);
        const base = path.basename(localPath);
        const remoteRel = args.remote_path && args.remote_path.trim() ? args.remote_path : base;
        const target = resolveRemote(s.root, remoteRel);
        await adapter.uploadFile(localPath, target);
        return textResult(
          `Uploaded ${localPath} -> ${target} (${formatSize(st.size)}) on ${s.protocol}://${s.host}`
        );
      })
    )
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
        local_dir: z.string().describe("Local directory to deploy (relative paths resolve against the process cwd)."),
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
    guard(async (args) => {
      requireConfig(loaded);
      const { name, server: s } = resolveServer(loaded, args.server);
      try {
        const localDirAbs = path.resolve(process.cwd(), args.local_dir);
        let dstat;
        try {
          dstat = fs.statSync(localDirAbs);
        } catch {
          throw new Error(`local directory not found: ${localDirAbs}`);
        }
        if (!dstat.isDirectory()) throw new Error(`not a directory: ${localDirAbs}`);

        const files = selectDeployFiles(localDirAbs, args.include, args.exclude);
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
          const insecure = insecureTransport(s);
          if (insecure && !s.allowInsecure) {
            lines.push("");
            lines.push(
              `Note: server "${name}" uses ${insecureLabel(insecure)} without "allowInsecure": true — a real deploy will be REFUSED. Prefer sftp.`
            );
          }
          return withInsecureNotice(textResult(lines.join("\n")), s);
        }

        if (s.readOnly) {
          throw new Error(
            `server "${name}" is read-only — upload, deploy, mkdir, rename and delete are blocked`
          );
        }

        if (files.length === 0) {
          return withInsecureNotice(
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

        const adapter = await openAdapter(s);
        try {
          for (const f of files) {
            const relForRemote = args.remote_dir
              ? posix.join(String(args.remote_dir).replace(/\\/g, "/"), f.rel)
              : f.rel;
            let target;
            try {
              target = resolveRemote(s.root, relForRemote);
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
        } finally {
          await adapter.close();
        }

        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const lines = [];
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
        if (uploadedList.length === 0) return withInsecureNotice(errorResult(text), s);
        return withInsecureNotice(textResult(text), s);
      } catch (err) {
        throw withInsecureError(err, s);
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
        local_path: z.string().describe("Local destination path (relative paths resolve against the process cwd)."),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing local file."),
      },
    },
    guard((args) =>
      withServer(loaded, args.server, { write: false }, async ({ server: s, adapter }) => {
        const target = resolveRemote(s.root, args.remote_path);
        const localPath = path.resolve(process.cwd(), args.local_path);
        if (fs.existsSync(localPath) && !args.overwrite) {
          throw new Error(
            `local file already exists: ${localPath} — pass overwrite:true to replace it`
          );
        }
        await adapter.downloadFile(target, localPath);
        let size = 0;
        try {
          size = fs.statSync(localPath).size;
        } catch {
          /* ignore */
        }
        return textResult(`Downloaded ${target} -> ${localPath} (${formatSize(size)})`);
      })
    )
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
    guard((args) =>
      withServer(loaded, args.server, { write: true }, async ({ server: s, adapter }) => {
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
    guard((args) =>
      withServer(loaded, args.server, { write: true }, async ({ server: s, adapter }) => {
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
    guard((args) =>
      withServer(loaded, args.server, { write: true }, async ({ server: s, adapter }) => {
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
