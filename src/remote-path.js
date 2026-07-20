// Remote path jail. All remote operations are confined under a server's `root`.
//
// User-supplied paths are POSIX-style and interpreted RELATIVE to `root`.
//   ""  "/"  "."   -> the root itself
//   "/x"          -> root-relative (NOT filesystem-absolute)
//   ".." escapes  -> rejected
//
// We normalize with POSIX semantics, then verify the result is still inside the
// root before letting any adapter touch it.

import path from "node:path";

const posix = path.posix;

// Normalize a configured root into a canonical absolute POSIX path with no
// trailing slash (except the bare root "/").
export function normalizeRoot(root) {
  let r = root == null ? "" : String(root);
  r = r.replace(/\\/g, "/").trim();
  if (r === "" || r === ".") r = "/";
  if (!r.startsWith("/")) r = "/" + r;
  r = posix.normalize(r);
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

// Resolve a user path against the root and enforce the jail.
// Returns the full canonical remote path (absolute, POSIX).
// Throws "path escapes configured root" on any breakout attempt.
export function resolveRemote(root, userPath) {
  const normRoot = normalizeRoot(root);
  let up = userPath == null ? "" : String(userPath);
  up = up.replace(/\\/g, "/").trim();
  // A leading slash means "relative to root", so strip it.
  up = up.replace(/^\/+/, "");

  // Normalize as a RELATIVE path so we can catch ".." that climbs above the
  // base BEFORE it gets silently clamped (e.g. "/../.." collapsing to "/").
  // A relative result of ".." or starting with "../" means it escaped.
  const relNorm = posix.normalize(up === "" ? "." : up);
  if (relNorm === ".." || relNorm.startsWith("../")) {
    throw new Error(`path escapes configured root: "${userPath}" (root is "${normRoot}")`);
  }

  const rel = relNorm === "." ? "" : relNorm;
  const joined = normRoot === "/" ? "/" + rel : rel ? normRoot + "/" + rel : normRoot;
  let resolved = posix.normalize(joined);
  if (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);

  // Belt-and-suspenders: the result must still live inside the root.
  const prefix = normRoot === "/" ? "/" : normRoot + "/";
  if (resolved !== normRoot && !resolved.startsWith(prefix)) {
    throw new Error(`path escapes configured root: "${userPath}" (root is "${normRoot}")`);
  }
  return resolved;
}

// True when the user path resolves to the root itself. Used to refuse
// deleting/renaming the jail root.
export function isRootPath(root, userPath) {
  const normRoot = normalizeRoot(root);
  let resolved;
  try {
    resolved = resolveRemote(root, userPath);
  } catch {
    return false;
  }
  return resolved === normRoot;
}

// Convenience: the POSIX parent directory of a remote path.
export function remoteDirname(p) {
  return posix.dirname(p);
}

// Convenience: join remote segments with POSIX semantics.
export function remoteJoin(...parts) {
  return posix.join(...parts);
}
