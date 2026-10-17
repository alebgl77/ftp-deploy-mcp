// FTP / FTPS adapter built on basic-ftp.
//
// Every adapter exposes the same interface so tools.js is protocol-agnostic:
//   list, stat, uploadFile, downloadFile, readFile, mkdirp,
//   deleteFile, deleteDir, rename, close
//
// Connections are per-tool-call: connect -> op -> close(). No pooling.

import { Client } from "basic-ftp";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import path from "node:path";
import fs from "node:fs";
import { checkedMethods } from "../operations.js";
import { appError, isAppError, nativeError, messageSpec } from "../errors.js";
import { normalizeRoot } from "../remote-path.js";
import { TRANSFER_LIMITS, checkTransferSize, hashRemoteStream, sendReadableStream,
  receiveLocalStream, receiveRemoteStream } from "../transfers.js";

import {
  insecureTransport,
  unsafeRemoteRoot,
} from "../config.js";

const posix = path.posix;

function toISO(fileInfo) {
  const m = fileInfo.modifiedAt;
  if (m instanceof Date && !Number.isNaN(m.getTime())) return m.toISOString();
  const raw = fileInfo.rawModifiedAt;
  if (typeof raw === "string" && raw.length > 0) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function entryType(fileInfo) {
  if (fileInfo.isDirectory) return "dir";
  if (fileInfo.isSymbolicLink) return "link";
  return "file";
}

// Turn a low-level failure into a readable Error. Never includes secrets.
function friendlyError(err, ctx) {
  if (isAppError(err)) return err;
  const error = err instanceof Error ? err.message : String(err);
  const at = `${ctx.host}:${ctx.port}`;
  const key = err?.code === "ECONNREFUSED" ? "connectionRefused" : err?.code === "ENOTFOUND" ? "hostMissing" :
    err?.code === "ETIMEDOUT" ? "timeout" : err?.code === 530 ? "authFailed" : null;
  if (key) return appError("TRANSPORT_ERROR", `runtime.ftp.${key}`, { at, host: ctx.host, user: ctx.user, error }, { origin: "ftp" });
  // FTP 550 is ambiguous (missing, inaccessible, policy); no text inference.
  return nativeError(err, "ftp");
}

export async function connect(serverCfg, operation) {
  operation?.check();
  const maxTransferBytes = serverCfg.maxTransferBytes ?? TRANSFER_LIMITS.maxTransferBytes.default;
  // FTP has no portable REALPATH/LSTAT equivalent. Refuse a client-side
  // sub-root before network I/O unless the operator explicitly accepts that it
  // is not an anti-symlink jail.
  if (unsafeRemoteRoot(serverCfg) && serverCfg.allowUnsafeRemoteRoot !== true) {
    throw appError("REMOTE_ROOT_REJECTED", "runtime.config.remoteRootBlocked", { name: serverCfg.name ?? serverCfg.host, root: normalizeRoot(serverCfg.root) });
  }

  // Insecure transports (plain FTP, or FTPS with certificate verification
  // disabled) are refused BEFORE any network I/O unless the server entry
  // explicitly opts in with "allowInsecure": true.
  const insecureReason = insecureTransport(serverCfg);
  if (insecureReason && serverCfg.allowInsecure !== true) {
    throw appError("TRANSPORT_POLICY", "runtime.config.insecureBlocked", { name: serverCfg.name ?? serverCfg.host,
      risk: messageSpec(insecureReason === "plain-ftp" ? "runtime.config.ftpRisk" : "runtime.config.tlsRisk", { name: serverCfg.name ?? serverCfg.host }) });
  }

  const ctx = { host: serverCfg.host, port: serverCfg.port, user: serverCfg.user };
  const canonicalRoot = normalizeRoot(serverCfg.root);
  const transport = new Client(30000);
  const client = checkedMethods(transport, operation, [
    "access", "list", "ensureDir", "uploadFrom", "downloadTo", "remove", "removeDir", "rename",
  ]);
  const close = () => {
    operation?.signal.removeEventListener("abort", close);
    try { transport.close(); } catch { /* ignore */ }
  };
  operation?.signal.addEventListener("abort", close, { once: true });
  client.ftp.verbose = false;

  // Plain "ftps" is explicit AUTH TLS (secure: true). When implicitTLS is
  // set, the server expects TLS from the first byte (secure: "implicit",
  // typically port 990 — FileZilla's "FTP over implicit TLS").
  const secure =
    serverCfg.protocol === "ftps" ? (serverCfg.implicitTLS === true ? "implicit" : true) : false;
  const access = {
    host: serverCfg.host,
    port: serverCfg.port,
    user: serverCfg.user,
    password: serverCfg.password ?? "",
    secure,
  };
  if (serverCfg.protocol === "ftps" && serverCfg.insecureTLS && serverCfg.allowInsecure === true) {
    access.secureOptions = { rejectUnauthorized: false };
  }

  try {
    await client.access(access);
  } catch (err) {
    close();
    throw friendlyError(err, ctx);
  }

  // Ensure an absolute directory exists, then return to a known location.
  // basic-ftp's ensureDir changes the working directory, so we always work
  // with absolute remote paths and don't depend on cwd afterwards.
  async function ensureDirAbsolute(dir) {
    if (!dir || dir === "/" || dir === ".") return;
    await client.ensureDir(dir);
  }

  async function listedFile(remotePath, { allowAbsent = false } = {}) {
    const parent = posix.dirname(remotePath);
    const base = posix.basename(remotePath);
    const entries = await client.list(parent);
    const found = entries.find((entry) => entry.name === base);
    if (!found && allowAbsent) return { parent, found: null };
    if (!found) throw appError("NOT_FOUND", "runtime.ftp.notFound", { where: `: ${remotePath}`, error: "550 not found" }, { origin: "ftp" });
    if (entryType(found) !== "file") throw appError("PATH_REJECTED", "error.PATH_REJECTED");
    return { parent, found };
  }

  function identityFor(remotePath, parent, details = {}) {
    return Object.freeze({ root: canonicalRoot, canonicalRoot, path: remotePath, parent, ...details });
  }

  function assertIdentity(remotePath, parent, found, identity) {
    if (!identity) return;
    const root = identity.canonicalRoot ?? identity.root;
    if ((root !== undefined && root !== canonicalRoot) ||
        (identity.path !== undefined && identity.path !== remotePath) ||
        (identity.parent !== undefined && identity.parent !== parent) ||
        (identity.bytes !== undefined && identity.bytes !== found.size)) {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
  }

  function assertObservedIdentity(observation, identity) {
    if (!identity || observation?.type !== "file") {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
    const root = identity.canonicalRoot ?? identity.root;
    if ((root !== undefined && root !== observation.canonicalRoot) ||
        (identity.path !== undefined && identity.path !== observation.path) ||
        (identity.parent !== undefined && identity.parent !== observation.parent) ||
        (identity.bytes !== undefined && identity.bytes !== observation.bytes) ||
        (identity.sha256 !== undefined && identity.sha256 !== observation.sha256)) {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
  }

  async function inspectRemoteFile(remotePath, maxBytes = maxTransferBytes) {
    const before = await listedFile(remotePath, { allowAbsent: true });
    if (!before.found) return { type: "absent", path: remotePath, parent: before.parent, canonicalRoot };
    checkTransferSize(before.found.size, Math.min(maxBytes, maxTransferBytes));
    const actual = await hashRemoteStream((output) => client.downloadTo(output, remotePath),
      Math.min(maxBytes, maxTransferBytes), operation);
    const after = await listedFile(remotePath);
    if (before.found.size !== after.found.size || actual.bytes !== after.found.size) {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
    const identity = identityFor(remotePath, before.parent, actual);
    return { type: "file", path: remotePath, parent: before.parent, canonicalRoot,
      bytes: actual.bytes, sha256: actual.sha256, identity };
  }

  async function uploadReadable(readable, remotePath, expected, options = {}) {
    checkTransferSize(expected?.bytes, Math.min(expected?.bytes, maxTransferBytes));
    const parent = posix.dirname(remotePath);
    if (options.createParents === false) await client.list(parent);
    else await ensureDirAbsolute(parent);
    if (options.staged && options.checkExisting !== false) {
      const prior = await listedFile(remotePath, { allowAbsent: true });
      if (prior.found) throw appError("ALREADY_EXISTS", "error.exists", { path: remotePath });
    }
    options.onCreating?.();
    // FTP has no exclusive STOR. The unpredictable validated staging name is
    // the ownership boundary; callers still verify bytes before promotion.
    const identity = identityFor(remotePath, parent);
    options.onOwned?.(identity);
    await sendReadableStream(readable, Math.min(expected.bytes, maxTransferBytes), operation,
      (input) => client.uploadFrom(input, remotePath));
    return {};
  }

  async function downloadReadable(remotePath, writable, maxBytes, options = {}) {
    const before = await listedFile(remotePath);
    assertIdentity(remotePath, before.parent, before.found, options.identity);
    checkTransferSize(before.found.size, Math.min(maxBytes, maxTransferBytes));
    const actual = await receiveRemoteStream(writable, Math.min(maxBytes, maxTransferBytes), operation,
      (output) => client.downloadTo(output, remotePath), { sha256: typeof options.identity?.sha256 === "string" });
    const after = await listedFile(remotePath);
    assertIdentity(remotePath, after.parent, after.found, options.identity);
    if (before.found.size !== after.found.size || actual.bytes !== after.found.size ||
        (options.identity?.sha256 !== undefined && options.identity.sha256 !== actual.sha256)) {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
    return actual;
  }

  return {
    async list(dir) {
      try {
        const entries = await client.list(dir);
        return entries.map((f) => ({
          name: f.name,
          type: entryType(f),
          size: typeof f.size === "number" ? f.size : 0,
          modifiedAt: toISO(f),
        }));
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: dir });
      }
    },

    async stat(p) {
      // basic-ftp has no portable stat; derive it from the parent listing.
      if (p === "/" || p === "") {
        return { name: "/", type: "dir", size: 0, modifiedAt: null };
      }
      const parent = posix.dirname(p);
      const base = posix.basename(p);
      try {
        const entries = await client.list(parent);
        const found = entries.find((f) => f.name === base);
        if (!found) {
          throw appError("NOT_FOUND", "runtime.ftp.notFound", { where: `: ${p}`, error: "550 not found" }, { origin: "ftp" });
        }
        return {
          name: found.name,
          type: entryType(found),
          size: typeof found.size === "number" ? found.size : 0,
          modifiedAt: toISO(found),
        };
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async uploadFile(localPath, remotePath, maxBytes = maxTransferBytes, options = {}) {
      const readable = fs.createReadStream(localPath);
      const settled = finished(readable).catch(() => {});
      try {
        const bytes = Math.min(maxBytes, maxTransferBytes);
        return await uploadReadable(readable, remotePath, { bytes },
          { createParents: true, ...options, checkExisting: false });
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      } finally {
        readable.destroy();
        await settled;
      }
    },

    async uploadStream(readable, remotePath, expected, options = {}) {
      try {
        return await uploadReadable(readable, remotePath, expected, options);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async downloadFile(remotePath, localPath, maxBytes = maxTransferBytes) {
      try {
        operation?.check();
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await receiveLocalStream(localPath, Math.min(maxBytes, maxTransferBytes), operation,
          (output) => client.downloadTo(output, remotePath));
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async downloadStream(remotePath, writable, maxBytes = maxTransferBytes, options = {}) {
      try {
        return await downloadReadable(remotePath, writable, maxBytes, options);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async inspectFile(remotePath, { maxBytes = maxTransferBytes } = {}) {
      try {
        return await inspectRemoteFile(remotePath, maxBytes);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async hashFile(remotePath, maxBytes = maxTransferBytes) {
      try {
        return await hashRemoteStream((output) => client.downloadTo(output, remotePath),
          Math.min(maxBytes, maxTransferBytes), operation);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async readFile(remotePath, maxBytes) {
      const chunks = [];
      let total = 0;
      let truncated = false;
      let aborted = false;
      const sink = new Writable({
        write(chunk, _enc, cb) {
          if (aborted) return cb();
          if (total >= maxBytes) {
            truncated = true;
            aborted = true;
            cb();
            this.destroy(new Error("__MAXBYTES__"));
            return;
          }
          const room = maxBytes - total;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            total += room;
            truncated = true;
            aborted = true;
            cb();
            this.destroy(new Error("__MAXBYTES__"));
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
          cb();
        },
      });
      // The intentional destroy() above emits 'error' on the sink; absorb it so
      // an unhandled 'error' event can never crash the process. Real transfer
      // failures still surface via the rejected downloadTo() promise below.
      sink.on("error", () => {});
      try {
        await client.downloadTo(sink, remotePath);
      } catch (err) {
        if (!aborted) throw friendlyError(err, { ...ctx, path: remotePath });
      }
      return { buffer: Buffer.concat(chunks), truncated };
    },

    async mkdirp(dir) {
      try {
        await ensureDirAbsolute(dir);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: dir });
      }
    },

    async deleteFile(p, options = {}) {
      try {
        if (typeof options.identity?.sha256 === "string") {
          const observed = await inspectRemoteFile(p, options.identity.bytes ?? maxTransferBytes);
          assertObservedIdentity(observed, options.identity);
        }
        await client.remove(p);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async deleteDir(p) {
      try {
        await client.removeDir(p);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async rename(from, to, options = {}) {
      try {
        if (options.createParents === false) await client.list(posix.dirname(to));
        else await ensureDirAbsolute(posix.dirname(to));
        if (typeof options.identity?.sha256 === "string") {
          const observed = await inspectRemoteFile(from, options.identity.bytes ?? maxTransferBytes);
          assertObservedIdentity(observed, options.identity);
        }
        await client.rename(from, to);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: from });
      }
    },

    close,
  };
}
