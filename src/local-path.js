// Local filesystem jail used by upload, deploy and download.
//
// Source paths already exist, so canonical containment is authoritative.
// Download destinations may not exist, so they require both lexical
// containment and a canonical check of every existing ancestor. Existing
// symlinks/junctions are never accepted on a write path.

import fs from "node:fs";
import path from "node:path";

function isContained(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function localRootFor(server) {
  if (typeof server.localRoot !== "string" || server.localRoot.trim() === "") {
    throw new Error(
      `LOCAL ROOT REQUIRED: server "${server.name}" must set "localRoot" to an absolute local directory ` +
        `before ftp_upload, ftp_deploy or ftp_download can access local files`
    );
  }
  if (!path.isAbsolute(server.localRoot)) {
    throw new Error(
      `LOCAL ROOT INVALID: server "${server.name}" has a relative "localRoot"; set it to an absolute ` +
        `local directory (a leading "~" is supported)`
    );
  }

  const root = path.resolve(server.localRoot);
  let stat;
  let realRoot;
  try {
    stat = fs.statSync(root);
    realRoot = fs.realpathSync(root);
  } catch (err) {
    throw new Error(`LOCAL ROOT INVALID: server "${server.name}" cannot access "localRoot": ${err.message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`LOCAL ROOT INVALID: server "${server.name}" field "localRoot" is not a directory`);
  }
  return { root, realRoot };
}

function lexicalCandidate(root, input, label) {
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  if (!isContained(root, candidate)) {
    throw new Error(`${label} escapes the configured "localRoot"`);
  }
  return candidate;
}

export function resolveLocalSource(server, input, kind) {
  const label = kind === "directory" ? "local directory" : "local file";
  const { root, realRoot } = localRootFor(server);
  const candidate = lexicalCandidate(root, input, label);

  let realCandidate;
  let stat;
  try {
    realCandidate = fs.realpathSync(candidate);
    stat = fs.statSync(realCandidate);
  } catch (err) {
    throw new Error(`${label} not found or inaccessible inside "localRoot": ${err.message}`);
  }
  if (!isContained(realRoot, realCandidate)) {
    throw new Error(`${label} resolves outside the configured "localRoot" through a symbolic link or junction`);
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} is not a regular ${kind}`);
  }
  return { path: realCandidate, stat };
}

export function resolveLocalDestination(server, input) {
  const { root, realRoot } = localRootFor(server);
  const candidate = lexicalCandidate(root, input, "local destination");
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
          throw new Error(`local destination has an inaccessible parent inside "localRoot": ${parentErr.message}`);
        }
        if (!isContained(realRoot, realParent)) {
          throw new Error(`local destination parent resolves outside the configured "localRoot"`);
        }
        return { path: candidate, exists: false, stat: null };
      }
      throw new Error(`local destination is inaccessible inside "localRoot": ${err.message}`);
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`local destination contains a symbolic link or junction, which is refused`);
    }
    const isFinal = i === parts.length;
    if (!isFinal && !stat.isDirectory()) {
      throw new Error(`local destination parent is not a directory`);
    }
    if (isFinal) finalStat = stat;
  }

  const realExisting = fs.realpathSync(candidate);
  if (!isContained(realRoot, realExisting)) {
    throw new Error(`local destination resolves outside the configured "localRoot"`);
  }
  if (!finalStat.isFile()) {
    throw new Error(`local destination is not a regular file`);
  }
  return { path: candidate, exists: true, stat: finalStat };
}

export function localRootStatus(server) {
  if (typeof server.localRoot !== "string" || server.localRoot.trim() === "") {
    return "missing (local tools REFUSED)";
  }
  return path.isAbsolute(server.localRoot) ? "configured" : "relative (REFUSED)";
}
