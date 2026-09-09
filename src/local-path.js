// Local filesystem jail used by upload, deploy and download.
//
// Source paths already exist, so canonical containment is authoritative.
// Download destinations may not exist, so they require both lexical
// containment and a canonical check of every existing ancestor. Existing
// symlinks/junctions are never accepted on a write path.

import fs from "node:fs";
import path from "node:path";
import { appError, messageSpec } from "./errors.js";
import { createI18n } from "./i18n.js";

function isContained(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function localRootFor(server) {
  if (typeof server.localRoot !== "string" || server.localRoot.trim() === "") {
    throw appError("CONFIG_INVALID", "runtime.local.rootRequired", { name: String(server.name) });
  }
  if (!path.isAbsolute(server.localRoot)) {
    throw appError("CONFIG_INVALID", "runtime.local.rootRelative", { name: String(server.name) });
  }

  const root = path.resolve(server.localRoot);
  let stat;
  let realRoot;
  try {
    stat = fs.statSync(root);
    realRoot = fs.realpathSync(root);
  } catch (err) {
    throw appError("CONFIG_INVALID", "runtime.local.rootInaccessible", { name: String(server.name), error: err.message }, { origin: "local" });
  }
  if (!stat.isDirectory()) {
    throw appError("CONFIG_INVALID", "runtime.local.rootNotDirectory", { name: String(server.name) });
  }
  return { root, realRoot };
}

function lexicalCandidate(root, input, label) {
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isContained(root, candidate)) {
    throw appError("PATH_REJECTED", "runtime.local.escape", { label });
  }
  return candidate;
}

export function resolveLocalSource(server, input, kind) {
  const label = messageSpec(kind === "directory" ? "runtime.local.directoryLabel" : "runtime.local.fileLabel");
  const { root, realRoot } = localRootFor(server);
  const candidate = lexicalCandidate(root, input, label);

  let realCandidate;
  let stat;
  try {
    realCandidate = fs.realpathSync(candidate);
    stat = fs.statSync(realCandidate);
  } catch (err) {
    throw appError(err?.code === "ENOENT" ? "NOT_FOUND" : "PATH_REJECTED", "runtime.local.sourceInaccessible", { label, error: err.message }, { origin: "local" });
  }
  if (!isContained(realRoot, realCandidate)) {
    throw appError("PATH_REJECTED", "runtime.local.sourceSymlinkEscape", { label });
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw appError("PATH_REJECTED", "runtime.local.sourceKind", {
      label,
      kindLabel: kind === "directory" ? messageSpec("runtime.local.directoryKind") :
        kind === "file" ? messageSpec("runtime.local.fileKind") : String(kind),
    });
  }
  return { path: realCandidate, stat };
}

export function resolveLocalDestination(server, input) {
  const { root, realRoot } = localRootFor(server);
  const candidate = lexicalCandidate(root, input, messageSpec("runtime.local.destinationLabel"));
  const rel = path.relative(root, candidate);
  const parts = rel === "" ? [] : rel.split(path.sep).filter(Boolean);
  let current = root;
  let finalStat = null;

  for (let i = 0; i <= parts.length; i += 1) {
    if (i > 0) current = path.join(current, parts[i - 1]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const existingParent = path.dirname(current);
        let realParent;
        try {
          realParent = fs.realpathSync(existingParent);
        } catch (parentErr) {
          throw appError("PATH_REJECTED", "runtime.local.parentInaccessible", { error: parentErr.message }, { origin: "local" });
        }
        if (!isContained(realRoot, realParent)) {
          throw appError("PATH_REJECTED", "runtime.local.parentEscape", {});
        }
        return { path: candidate, canonicalPath: path.resolve(realRoot, rel), exists: false, stat: null };
      }
      throw appError("PATH_REJECTED", "runtime.local.destinationInaccessible", { error: err.message }, { origin: "local" });
    }

    if (stat.isSymbolicLink()) {
      throw appError("PATH_REJECTED", "runtime.local.destinationSymlink", {});
    }
    const isFinal = i === parts.length;
    if (!isFinal && !stat.isDirectory()) {
      throw appError("PATH_REJECTED", "runtime.local.parentNotDirectory", {});
    }
    if (isFinal) finalStat = stat;
  }

  const realExisting = fs.realpathSync(candidate);
  if (!isContained(realRoot, realExisting)) {
    throw appError("PATH_REJECTED", "runtime.local.destinationEscape", {});
  }
  if (!finalStat.isFile()) {
    throw appError("PATH_REJECTED", "runtime.local.destinationNotFile", {});
  }
  return { path: candidate, canonicalPath: path.resolve(realRoot, rel), exists: true, stat: finalStat };
}

export function localRootStatus(server, i18n = createI18n()) {
  if (typeof server.localRoot !== "string" || server.localRoot.trim() === "") {
    return i18n.t("runtime.local.statusMissing");
  }
  return i18n.t(path.isAbsolute(server.localRoot) ? "runtime.local.statusConfigured" : "runtime.local.statusRelative");
}
