// MCP client detection + surgical JSON config merge.
//
// PURE and testable: every function derives its paths from an explicit
//   ctx = { home, platform, appData }
// This module NEVER reads os.homedir() or process.platform itself — the caller
// (setup.js / doctor) builds ctx, so detection stays deterministic and can be
// unit-tested against a throwaway home directory.

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

// The single mcpServers key we install everywhere.
const KEY = "ftp";

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Claude Desktop's per-platform config directory.
function claudeDesktopDir(ctx) {
  if (ctx.platform === "win32") return path.join(ctx.appData, "Claude");
  if (ctx.platform === "darwin") {
    return path.join(ctx.home, "Library", "Application Support", "Claude");
  }
  return path.join(ctx.home, ".config", "Claude");
}

// Antigravity ships two documented config paths across versions. Write policy:
//   - update EVERY candidate whose file already exists;
//   - else create the one whose parent dir already exists;
//   - else create the antigravity/ one.
function antigravityTargets(ctx) {
  const a = path.join(ctx.home, ".gemini", "antigravity", "mcp_config.json");
  const b = path.join(ctx.home, ".gemini", "config", "mcp_config.json");
  const present = [a, b].filter(exists);
  if (present.length) return present;
  if (exists(path.dirname(a))) return [a];
  if (exists(path.dirname(b))) return [b];
  return [a];
}

// The client registry, resolved against ctx. Each descriptor:
//   { id, name, kind: "file"|"manual", detected: bool, targets: [absPath,...] }
// `targets` are the file(s) a write would touch (Antigravity may have two).
export function getClients(ctx) {
  const dtDir = claudeDesktopDir(ctx);
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      kind: "file",
      detected:
        exists(path.join(ctx.home, ".claude")) || exists(path.join(ctx.home, ".claude.json")),
      targets: [path.join(ctx.home, ".claude.json")],
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      kind: "file",
      detected: exists(dtDir),
      targets: [path.join(dtDir, "claude_desktop_config.json")],
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "file",
      detected: exists(path.join(ctx.home, ".cursor")),
      targets: [path.join(ctx.home, ".cursor", "mcp.json")],
    },
    {
      id: "windsurf",
      name: "Windsurf",
      kind: "file",
      detected: exists(path.join(ctx.home, ".codeium", "windsurf")),
      targets: [path.join(ctx.home, ".codeium", "windsurf", "mcp_config.json")],
    },
    {
      id: "antigravity",
      name: "Antigravity",
      kind: "file",
      detected: exists(path.join(ctx.home, ".gemini")),
      targets: antigravityTargets(ctx),
    },
    {
      // UI-managed, no stable config file — never auto-written.
      id: "trae",
      name: "Trae",
      kind: "manual",
      detected: false,
      targets: [],
    },
  ];
}

// Build the mcpServers.ftp entry. `configPath` (already forward-slashed) is
// added as an env override ONLY for a non-default config destination; for the
// default ~/.ftp-mcp/servers.json the caller passes null and discovery finds it.
export function buildEntry({ absIndexJs, configPath }) {
  const entry = { command: "node", args: [absIndexJs] };
  if (configPath) entry.env = { FTP_MCP_CONFIG: configPath };
  return entry;
}

// Order-independent deep equality for plain JSON values.
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// YYYYMMDD-HHmmss for backup filenames.
function stamp(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// Surgically merge `entry` into a single client config file, preserving every
// unrelated key. Options: { force, dryRun, now }. Returns
//   { path, status: created|updated|already|skipped-different|unparseable,
//     backupPath?, existing? }
// - missing file        -> create (mkdir -p) { mcpServers: { ftp: entry } }
// - unparseable JSON     -> do NOT touch; status "unparseable"
// - ftp already equal    -> status "already" (no write, no backup)
// - ftp differs, !force  -> status "skipped-different" (untouched)
// - otherwise            -> backup existing, then write; status "updated"
export function mergeConfigFile(filePath, entry, opts = {}) {
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;

  if (!exists(filePath)) {
    if (!dryRun) {
      atomicWriteFileSync(
        filePath,
        JSON.stringify({ mcpServers: { [KEY]: entry } }, null, 2) + "\n"
      );
    }
    return { path: filePath, status: "created" };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { path: filePath, status: "unparseable" };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { path: filePath, status: "unparseable" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { path: filePath, status: "unparseable" };
  }

  const hasServers =
    obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers);
  const existing = hasServers ? obj.mcpServers[KEY] : undefined;
  if (existing !== undefined) {
    if (deepEqual(existing, entry)) return { path: filePath, status: "already" };
    if (!force) return { path: filePath, status: "skipped-different", existing };
  }

  if (dryRun) return { path: filePath, status: "updated" };

  // Back up BEFORE the first (and only) modification of an existing file.
  const backupPath = `${filePath}.backup-${stamp(opts.now)}`;
  fs.copyFileSync(filePath, backupPath);
  if (!hasServers) obj.mcpServers = {};
  obj.mcpServers[KEY] = entry;
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
  return { path: filePath, status: "updated", backupPath };
}

// Apply `entry` to every target file of a client (Antigravity may have two).
// Manual clients (Trae) are never written and return [].
export function applyClient(client, entry, opts = {}) {
  if (!client || client.kind !== "file") return [];
  return client.targets.map((t) => mergeConfigFile(t, entry, opts));
}
