// SFTP adapter built on ssh2-sftp-client.
//
// Same interface as adapters/ftp.js so tools.js stays protocol-agnostic:
//   list, stat, uploadFile, downloadFile, readFile, hashFile, mkdirp,
//   deleteFile, deleteDir, rename, close
//
// Connections are per-tool-call: connect -> op -> close(). No pooling.

import SftpClient from "ssh2-sftp-client";
import { Writable } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { checkedMethods } from "../operations.js";
import { appError, isAppError, nativeError, messageSpec } from "../errors.js";
import { TRANSFER_LIMITS, hashRemoteStream, sendLocalStream, receiveLocalStream } from "../transfers.js";

import { normalizeRoot, relativeRemote, rebaseRemote } from "../remote-path.js";

const posix = path.posix;

function entryTypeFromChar(c) {
  if (c === "d") return "dir";
  if (c === "l") return "link";
  return "file";
}

function isoFromMs(ms) {
  if (typeof ms !== "number" || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function boolFlag(v) {
  return typeof v === "function" ? !!v() : !!v;
}

function friendlyError(err, ctx) {
  if (isAppError(err)) return err;
  const error = err instanceof Error ? err.message : String(err);
  const at = `${ctx.host}:${ctx.port}`;
  const key = err?.code === "ECONNREFUSED" ? "connectionRefused" : err?.code === "ENOTFOUND" ? "hostMissing" :
    err?.code === "ETIMEDOUT" ? "timeout" : null;
  if (key) return appError("TRANSPORT_ERROR", `runtime.sftp.${key}`, { at, host: ctx.host, error }, { origin: "sftp" });
  if (err?.code === 2 || err?.code === "ENOENT") {
    return appError("NOT_FOUND", "runtime.sftp.notFound", { where: ctx.path ? `: ${ctx.path}` : "", error }, { origin: "sftp" });
  }
  return nativeError(err, "sftp");
}

function decodeHostPins(value) {
  const pins = typeof value === "string" ? [value] : value;
  if (pins === undefined || (Array.isArray(pins) && pins.length === 0)) return [];
  if (!Array.isArray(pins) || pins.length === 0) {
    throw appError("CONFIG_INVALID", "runtime.sftp.pinType");
  }
  return pins.map((pin, index) => {
    if (typeof pin !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pin)) {
      throw appError("CONFIG_INVALID", "runtime.sftp.pinFormat", { index: index + 1 });
    }
    const encoded = pin.slice("SHA256:".length);
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== encoded) {
      throw appError("CONFIG_INVALID", "runtime.sftp.pinFormat", { index: index + 1 });
    }
    return decoded;
  });
}

export async function connect(serverCfg, operation) {
  operation?.check();
  const maxTransferBytes = serverCfg.maxTransferBytes ?? TRANSFER_LIMITS.maxTransferBytes.default;
  const ctx = { host: serverCfg.host, port: serverCfg.port, user: serverCfg.user };
  const configuredRoot = normalizeRoot(serverCfg.root);
  let pinnedRoot = null;
  let hostKeyRejected = false;
  const expectedHostKeys = decodeHostPins(serverCfg.hostKeySha256);
  if (expectedHostKeys.length === 0 && serverCfg.allowUnknownHostKey !== true) {
    throw appError("HOST_KEY_REJECTED", "runtime.config.hostKeyRequired", { name: serverCfg.name ?? serverCfg.host });
  }
  const connOpts = {
    host: serverCfg.host,
    port: serverCfg.port,
    username: serverCfg.user,
    readyTimeout: 30000,
    // Detect a dead/half-open peer in ~30s (interval * countMax) so a stuck
    // op rejects instead of hanging forever; slow-but-alive transfers are
    // unaffected since this is a liveness ping, not a per-op timeout.
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };
  if (expectedHostKeys.length > 0) {
    connOpts.hostVerifier = (rawHostKey) => {
      const observed = crypto.createHash("sha256").update(rawHostKey).digest();
      let matched = 0;
      for (const expected of expectedHostKeys) {
        matched |= Number(crypto.timingSafeEqual(observed, expected));
      }
      hostKeyRejected = matched !== 1;
      return matched === 1;
    };
  }
  if (serverCfg.privateKeyPath) {
    try {
      connOpts.privateKey = fs.readFileSync(serverCfg.privateKeyPath);
    } catch (err) {
      throw appError("CONFIG_INVALID", "runtime.sftp.keyUnreadable", { path: serverCfg.privateKeyPath, name: serverCfg.name, error: err.message }, { origin: "local" });
    }
    if (serverCfg.passphrase) connOpts.passphrase = serverCfg.passphrase;
  }
  if (serverCfg.password) {
    connOpts.password = serverCfg.password;
  }

  const transport = new SftpClient();
  // Retain the library's native transport timeouts and absorb late errors.
  transport.on("error", () => {});
  const sftp = checkedMethods(transport, operation, [
    "connect", "lstat", "realPath", "list", "mkdir", "put", "get", "delete", "rmdir", "rename", "chmod",
  ]);
  let closing;
  const close = () => {
    operation?.signal.removeEventListener("abort", onAbort);
    closing ??= Promise.resolve().then(() => transport.end()).catch(() => {});
    return closing;
  };
  const onAbort = () => {
    // end() alone can be a no-op before SFTP is ready. Destroy the SSH
    // transport as well so cancellation interrupts an in-flight handshake.
    try { transport.client.destroy(); } catch { /* end() still runs below */ }
    void close();
  };
  operation?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    await sftp.connect(connOpts);
    await canonicalRoot();
  } catch (err) {
    await close();
    if (hostKeyRejected) throw appError("HOST_KEY_REJECTED", "runtime.sftp.hostKeyMismatch", { at: `${ctx.host}:${ctx.port}` });
    throw friendlyError(err, ctx);
  }

  function absoluteRemote(remotePath, label) {
    const raw = String(remotePath == null ? "" : remotePath).replace(/\\/g, "/");
    if (!raw.startsWith("/")) {
      throw appError("PATH_REJECTED", "runtime.sftp.absoluteRequired", { label });
    }
    const normalized = posix.normalize(raw);
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  }

  function pathPrefixes(absolutePath) {
    const parts = absolutePath.split("/").filter(Boolean);
    const prefixes = ["/"];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      prefixes.push(current);
    }
    return prefixes;
  }

  function isMissing(err) {
    return (isAppError(err) && err.code === "NOT_FOUND") || err?.code === 2 || err?.code === "ENOENT";
  }

  async function lstatMaybe(remotePath) {
    try {
      return await sftp.lstat(remotePath);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  function assertSafeEntry(remotePath, st, requireDirectory) {
    if (st.isSymbolicLink) {
      throw appError("PATH_REJECTED", "runtime.sftp.symlinkRefused", { path: remotePath });
    }
    if (requireDirectory && !st.isDirectory) {
      throw appError("PATH_REJECTED", "runtime.sftp.componentNotDirectory", { path: remotePath });
    }
  }

  async function validatePrefix(prefix, allowMissingSuffix) {
    const paths = pathPrefixes(prefix);
    for (let i = 0; i < paths.length; i++) {
      const st = await lstatMaybe(paths[i]);
      if (!st) {
        if (allowMissingSuffix) return { exists: false, missingAt: paths[i] };
        throw appError("NOT_FOUND", "runtime.sftp.prefixMissing", { path: paths[i] });
      }
      assertSafeEntry(paths[i], st, i < paths.length - 1);
    }
    return { exists: true };
  }

  // Re-run on every adapter operation. No canonical or lstat result is shared
  // between operations, because a server-side path can change at any time.
  async function canonicalRoot() {
    await validatePrefix(configuredRoot, false);
    const resolved = await sftp.realPath(configuredRoot);
    if (!resolved) throw appError("REMOTE_ROOT_REJECTED", "runtime.sftp.rootMissing", { root: configuredRoot });
    const canonical = absoluteRemote(resolved, messageSpec("runtime.sftp.realpathLabel"));
    if (pinnedRoot !== null && canonical !== pinnedRoot) {
      throw appError("TARGET_CHANGED", "runtime.sftp.canonicalRootChanged", {});
    }
    const final = await validatePrefix(canonical, false);
    if (!final.exists) throw appError("REMOTE_ROOT_REJECTED", "runtime.sftp.rootMissing", { root: configuredRoot });
    const st = await sftp.lstat(canonical);
    assertSafeEntry(canonical, st, true);
    pinnedRoot ??= canonical;
    return canonical;
  }

  async function safePath(remotePath, { allowMissing = false, requireDirectory = false } = {}) {
    const lexical = absoluteRemote(remotePath, messageSpec("runtime.sftp.remotePathLabel"));
    relativeRemote(configuredRoot, lexical);
    const root = await canonicalRoot();
    const candidate = rebaseRemote(configuredRoot, root, lexical);
    const checked = await validatePrefix(candidate, allowMissing);
    let st = null;
    if (checked.exists) {
      st = await sftp.lstat(candidate);
      assertSafeEntry(candidate, st, requireDirectory);
    }
    return { path: candidate, root, exists: checked.exists, stat: st };
  }

  function permissionBits(entry) {
    const regular = typeof entry.stat?.isFile === "function" ? entry.stat.isFile() : entry.stat?.isFile;
    if (!regular || !Number.isInteger(entry.stat.mode) || entry.stat.mode < 0) {
      throw appError("TRANSFER_VERIFY", "runtime.sftp.permissionsRequired", {});
    }
    return entry.stat.mode & 0o777;
  }

  function assertIdentity(entry, identity) {
    if (identity && (entry.root !== identity.root || entry.path !== identity.path)) {
      throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged", {});
    }
  }

  async function setTemporaryMode(remotePath, expectedRoot, mode) {
    const before = await safePath(remotePath);
    permissionBits(before);
    if (before.root !== expectedRoot) throw appError("TARGET_CHANGED", "runtime.sftp.rootChangedMode", {});
    await sftp.chmod(before.path, mode);
    const after = await safePath(remotePath);
    if (after.root !== expectedRoot || permissionBits(after) !== mode) {
      throw appError("TRANSFER_VERIFY", "runtime.sftp.temporaryModeUnverified", {});
    }
  }

  function handleRequest(method, ...args) {
    return new Promise((resolve, reject) => {
      transport.sftp[method](...args, (error, value) => error ? reject(error) : resolve(value));
    });
  }

  async function stagedUpload(localPath, destination, maxBytes, options) {
    operation?.check();
    options.onCreating?.();
    // Do not use ssh2's WriteStream.open(): it silently FCHMODs to its default
    // 0666 after OPEN, overriding the umask and previously restricted modes.
    const handle = await handleRequest("open", destination.path, "wx", {});
    options.onOwned?.(Object.freeze({ root: destination.root, path: destination.path }));
    let failed = false;
    try {
      operation?.check();
      const mode = permissionBits({ stat: await handleRequest("fstat", handle) });
      operation?.check();
      await handleRequest("fchmod", handle, 0o600);
      operation?.check();
      const restricted = permissionBits({ stat: await handleRequest("fstat", handle) });
      operation?.check();
      if (restricted !== 0o600) throw appError("TRANSFER_VERIFY", "runtime.sftp.temporaryModeUnverified", {});
      await sendLocalStream(localPath, Math.min(maxBytes, maxTransferBytes), operation, async (input) => {
        let offset = 0;
        for await (const chunk of input) {
          operation?.check();
          await handleRequest("write", handle, chunk, 0, chunk.length, offset);
          offset += chunk.length;
          operation?.check();
        }
      });
      return { mode };
    } catch (error) { failed = true; throw error; }
    finally {
      // Cleanup bypasses checkpoints, but remains awaited even after abort.
      // A failed close must not replace an earlier transfer diagnostic.
      try { await handleRequest("close", handle); } catch (error) { if (!failed) throw error; }
    }
  }

  async function ensureDirectory(remotePath) {
    const lexical = absoluteRemote(remotePath, messageSpec("runtime.sftp.remoteDirectoryLabel"));
    const rel = relativeRemote(configuredRoot, lexical);
    if (!rel) {
      await safePath(lexical, { requireDirectory: true });
      return;
    }
    const parts = rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const partRel = parts.slice(0, i + 1).join("/");
      const partLexical = configuredRoot === "/" ? `/${partRel}` : `${configuredRoot}/${partRel}`;
      const current = await safePath(partLexical, { allowMissing: true, requireDirectory: true });
      if (current.exists) continue;

      const parentLexical = i === 0 ? configuredRoot : posix.dirname(partLexical);
      const parent = await safePath(parentLexical, { requireDirectory: true });
      const candidate = rebaseRemote(configuredRoot, parent.root, partLexical);
      try {
        await sftp.mkdir(candidate, false);
      } catch (err) {
        // A concurrent creator is safe only if the postcondition below proves
        // the new component is a real directory and not a symlink.
        const post = await lstatMaybe(candidate);
        if (!post) throw err;
      }
      await safePath(partLexical, { requireDirectory: true });
    }
  }

  return {
    async list(dir) {
      try {
        const safe = await safePath(dir, { requireDirectory: true });
        const entries = await sftp.list(safe.path);
        return entries.map((e) => ({
          name: e.name,
          type: entryTypeFromChar(e.type),
          size: typeof e.size === "number" ? e.size : 0,
          modifiedAt: isoFromMs(e.modifyTime),
        }));
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: dir });
      }
    },

    async stat(p) {
      try {
        const safe = await safePath(p);
        const st = safe.stat;
        const isDir = boolFlag(st.isDirectory);
        const isLink = boolFlag(st.isSymbolicLink);
        return {
          name: posix.basename(p) || "/",
          type: isDir ? "dir" : isLink ? "link" : "file",
          size: typeof st.size === "number" ? st.size : 0,
          modifiedAt: isoFromMs(st.modifyTime),
        };
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async uploadFile(localPath, remotePath, maxBytes = maxTransferBytes, options = {}) {
      try {
        await ensureDirectory(posix.dirname(remotePath));
        const parent = await safePath(posix.dirname(remotePath), { requireDirectory: true });
        const destination = await safePath(remotePath, { allowMissing: true });
        if (parent.root !== destination.root) {
          throw appError("TARGET_CHANGED", "runtime.sftp.rootChangedUpload", {});
        }
        if (options.staged) {
          if (destination.exists) throw appError("ALREADY_EXISTS", "runtime.sftp.stagingExists", {});
          return await stagedUpload(localPath, destination, maxBytes, options);
        }
        await sendLocalStream(localPath, Math.min(maxBytes, maxTransferBytes), operation,
          (input) => sftp.put(input, destination.path));
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async downloadFile(remotePath, localPath, maxBytes = maxTransferBytes) {
      try {
        const source = await safePath(remotePath);
        operation?.check();
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await receiveLocalStream(localPath, Math.min(maxBytes, maxTransferBytes), operation,
          (output) => sftp.get(source.path, output));
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async hashFile(remotePath, maxBytes = maxTransferBytes, options = {}) {
      try {
        const source = await safePath(remotePath);
        assertIdentity(source, options.identity);
        return await hashRemoteStream((output) => sftp.get(source.path, output),
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
      // failures still surface via the rejected get() promise below.
      sink.on("error", () => {});
      try {
        const source = await safePath(remotePath);
        await sftp.get(source.path, sink);
      } catch (err) {
        if (!aborted) throw friendlyError(err, { ...ctx, path: remotePath });
      }
      return { buffer: Buffer.concat(chunks), truncated };
    },

    async mkdirp(dir) {
      try {
        await ensureDirectory(dir);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: dir });
      }
    },

    async deleteFile(p, options = {}) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(p, messageSpec("runtime.sftp.remotePathLabel"))) === "") {
          throw appError("PATH_REJECTED", "runtime.sftp.deleteRootRefused", {});
        }
        const parent = await safePath(posix.dirname(p), { requireDirectory: true });
        const target = await safePath(p);
        assertIdentity(target, options.identity);
        if (parent.root !== target.root) {
          throw appError("TARGET_CHANGED", "runtime.sftp.rootChangedDelete", {});
        }
        await sftp.delete(target.path);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async deleteDir(p) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(p, messageSpec("runtime.sftp.remotePathLabel"))) === "") {
          throw appError("PATH_REJECTED", "runtime.sftp.deleteRootRefused", {});
        }
        const parent = await safePath(posix.dirname(p), { requireDirectory: true });
        const target = await safePath(p, { requireDirectory: true });
        if (parent.root !== target.root) {
          throw appError("TARGET_CHANGED", "runtime.sftp.rootChangedDelete", {});
        }
        await sftp.rmdir(target.path, true);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async rename(from, to, options = {}) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(from, messageSpec("runtime.sftp.renameSourceLabel"))) === "") {
          throw appError("PATH_REJECTED", "runtime.sftp.renameRootRefused", {});
        }
        if (relativeRemote(configuredRoot, absoluteRemote(to, messageSpec("runtime.sftp.renameDestinationLabel"))) === "") {
          throw appError("PATH_REJECTED", "runtime.sftp.overwriteRootRefused", {});
        }
        await ensureDirectory(posix.dirname(to));
        const sourceParent = await safePath(posix.dirname(from), { requireDirectory: true });
        const destinationParent = await safePath(posix.dirname(to), { requireDirectory: true });
        const source = await safePath(from);
        assertIdentity(source, options.identity);
        const destination = await safePath(to, { allowMissing: true });
        if (
          source.root !== sourceParent.root ||
          source.root !== destinationParent.root ||
          source.root !== destination.root
        ) {
          throw appError("TARGET_CHANGED", "runtime.sftp.rootChangedRename", {});
        }
        if (options.staged) {
          const mode = destination.exists ? permissionBits(destination) : options.mode;
          if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
            throw appError("TRANSFER_VERIFY", "runtime.sftp.initialModeMissing", {});
          }
          await setTemporaryMode(from, source.root, mode);
        }
        await sftp.rename(source.path, destination.path);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: from });
      }
    },

    close,
  };
}
