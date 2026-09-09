// FTP / FTPS adapter built on basic-ftp.
//
// Every adapter exposes the same interface so tools.js is protocol-agnostic:
//   list, stat, uploadFile, downloadFile, readFile, mkdirp,
//   deleteFile, deleteDir, rename, close
//
// Connections are per-tool-call: connect -> op -> close(). No pooling.

import { Client } from "basic-ftp";
import { Writable } from "node:stream";
import path from "node:path";
import fs from "node:fs";
import { checkedMethods } from "../operations.js";
import { appError, isAppError, nativeError, messageSpec } from "../errors.js";
import { normalizeRoot } from "../remote-path.js";
import { TRANSFER_LIMITS, hashRemoteStream, sendLocalStream, receiveLocalStream } from "../transfers.js";

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
      try {
        await ensureDirAbsolute(posix.dirname(remotePath));
        // Portable FTP has no exclusive STOR. Ownership uses the unpredictable
        // name selected by the caller; no existing final target is removed.
        options.onOwned?.();
        await sendLocalStream(localPath, Math.min(maxBytes, maxTransferBytes), operation,
          (input) => client.uploadFrom(input, remotePath));
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

    async deleteFile(p) {
      try {
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

    async rename(from, to) {
      try {
        await ensureDirAbsolute(posix.dirname(to));
        await client.rename(from, to);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: from });
      }
    },

    close,
  };
}
