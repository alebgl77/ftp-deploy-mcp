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
import { TRANSFER_LIMITS, hashRemoteStream, sendLocalStream, receiveLocalStream } from "../transfers.js";

import { unknownHostKeyBlockedMessage } from "../config.js";
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
  if (err && err.remoteSafety) return err;
  const orig = err && err.message ? err.message : String(err);
  const code = err && err.code;
  const at = `${ctx.host}:${ctx.port}`;
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(orig)) {
    return new Error(`connection refused by ${at} — is the SFTP server reachable? [${orig}]`);
  }
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(orig)) {
    return new Error(`host not found: ${ctx.host} [${orig}]`);
  }
  if (/host denied|host key|verification failed/i.test(orig)) {
    return new Error(
      `SFTP host key verification failed for ${at} — the server key does not match "hostKeySha256"`
    );
  }
  if (/timed?\s?out|timeout|handshake/i.test(orig)) {
    return new Error(`connection to ${at} timed out — check host, port and firewall [${orig}]`);
  }
  if (/authentication|all configured auth|permission denied|Cannot parse privateKey|bad passphrase|encrypted/i.test(orig)) {
    return new Error(`authentication failed for user "${ctx.user}" on ${at} — check password/key/passphrase [${orig}]`);
  }
  if (code === 2 || code === "ENOENT" || /no such file|not exist|ENOENT/i.test(orig)) {
    const where = ctx.path ? `: ${ctx.path}` : "";
    return new Error(`no such file or directory${where} [${orig}]`);
  }
  return new Error(orig);
}

function safetyError(message) {
  const err = new Error(message);
  err.remoteSafety = true;
  return err;
}

function decodeHostPins(value) {
  const pins = typeof value === "string" ? [value] : value;
  if (pins === undefined || (Array.isArray(pins) && pins.length === 0)) return [];
  if (!Array.isArray(pins) || pins.length === 0) {
    throw new Error('field "hostKeySha256" must be a fingerprint string or a non-empty array');
  }
  return pins.map((pin, index) => {
    if (typeof pin !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pin)) {
      throw new Error(
        `field "hostKeySha256" entry ${index + 1} must use SHA256:<43-character unpadded base64> format`
      );
    }
    const encoded = pin.slice("SHA256:".length);
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== encoded) {
      throw new Error(
        `field "hostKeySha256" entry ${index + 1} must use SHA256:<43-character unpadded base64> format`
      );
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
  const expectedHostKeys = decodeHostPins(serverCfg.hostKeySha256);
  if (expectedHostKeys.length === 0 && serverCfg.allowUnknownHostKey !== true) {
    throw new Error(unknownHostKeyBlockedMessage(serverCfg.name ?? serverCfg.host));
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
      return matched === 1;
    };
  }
  if (serverCfg.privateKeyPath) {
    try {
      connOpts.privateKey = fs.readFileSync(serverCfg.privateKeyPath);
    } catch (err) {
      throw new Error(
        `cannot read privateKeyPath "${serverCfg.privateKeyPath}" for server "${serverCfg.name}": ${err.message}`
      );
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
    throw friendlyError(err, ctx);
  }

  function absoluteRemote(remotePath, label) {
    const raw = String(remotePath == null ? "" : remotePath).replace(/\\/g, "/");
    if (!raw.startsWith("/")) {
      throw safetyError(`${label} must be an absolute remote path`);
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
    const message = err && err.message ? err.message : String(err);
    return err?.code === 2 || err?.code === "ENOENT" || /no such file|not exist|ENOENT/i.test(message);
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
      throw safetyError(`refusing remote path containing symbolic link: ${remotePath}`);
    }
    if (requireDirectory && !st.isDirectory) {
      throw safetyError(`remote path component is not a directory: ${remotePath}`);
    }
  }

  async function validatePrefix(prefix, allowMissingSuffix) {
    const paths = pathPrefixes(prefix);
    for (let i = 0; i < paths.length; i++) {
      const st = await lstatMaybe(paths[i]);
      if (!st) {
        if (allowMissingSuffix) return { exists: false, missingAt: paths[i] };
        throw safetyError(`no such file or directory: ${paths[i]}`);
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
    if (!resolved) throw safetyError(`configured SFTP root does not exist: ${configuredRoot}`);
    const canonical = absoluteRemote(resolved, "SFTP REALPATH result");
    if (pinnedRoot !== null && canonical !== pinnedRoot) {
      throw safetyError("TARGET_CHANGED: canonical SFTP root changed during this connection");
    }
    const final = await validatePrefix(canonical, false);
    if (!final.exists) throw safetyError(`configured SFTP root does not exist: ${configuredRoot}`);
    const st = await sftp.lstat(canonical);
    assertSafeEntry(canonical, st, true);
    pinnedRoot ??= canonical;
    return canonical;
  }

  async function safePath(remotePath, { allowMissing = false, requireDirectory = false } = {}) {
    const lexical = absoluteRemote(remotePath, "remote path");
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
      throw safetyError("TRANSFER_MODE: a regular file with readable permissions is required");
    }
    return entry.stat.mode & 0o777;
  }

  function assertIdentity(entry, identity) {
    if (identity && (entry.root !== identity.root || entry.path !== identity.path)) {
      throw safetyError("TARGET_CHANGED: owned SFTP temporary identity changed");
    }
  }

  async function setTemporaryMode(remotePath, expectedRoot, mode) {
    const before = await safePath(remotePath);
    permissionBits(before);
    if (before.root !== expectedRoot) throw safetyError("SFTP root changed while setting temporary permissions");
    await sftp.chmod(before.path, mode);
    const after = await safePath(remotePath);
    if (after.root !== expectedRoot || permissionBits(after) !== mode) {
      throw safetyError("TRANSFER_MODE: temporary permissions could not be verified");
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
      if (restricted !== 0o600) throw safetyError("TRANSFER_MODE: temporary permissions could not be verified");
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
    const lexical = absoluteRemote(remotePath, "remote directory");
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
          throw safetyError("configured SFTP root changed while validating upload");
        }
        if (options.staged) {
          if (destination.exists) throw safetyError("TRANSFER_MODE: staging destination already exists");
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
        if (relativeRemote(configuredRoot, absoluteRemote(p, "remote path")) === "") {
          throw safetyError("refusing to delete the configured SFTP root");
        }
        const parent = await safePath(posix.dirname(p), { requireDirectory: true });
        const target = await safePath(p);
        assertIdentity(target, options.identity);
        if (parent.root !== target.root) {
          throw safetyError("configured SFTP root changed while validating delete");
        }
        await sftp.delete(target.path);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async deleteDir(p) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(p, "remote path")) === "") {
          throw safetyError("refusing to delete the configured SFTP root");
        }
        const parent = await safePath(posix.dirname(p), { requireDirectory: true });
        const target = await safePath(p, { requireDirectory: true });
        if (parent.root !== target.root) {
          throw safetyError("configured SFTP root changed while validating delete");
        }
        await sftp.rmdir(target.path, true);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async rename(from, to, options = {}) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(from, "rename source")) === "") {
          throw safetyError("refusing to rename the configured SFTP root");
        }
        if (relativeRemote(configuredRoot, absoluteRemote(to, "rename destination")) === "") {
          throw safetyError("refusing to overwrite the configured SFTP root");
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
          throw safetyError("configured SFTP root changed while validating rename");
        }
        if (options.staged) {
          const mode = destination.exists ? permissionBits(destination) : options.mode;
          if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
            throw safetyError("TRANSFER_MODE: initial server permissions are unavailable");
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
