// SFTP adapter built on ssh2-sftp-client.
//
// Same interface as adapters/ftp.js so tools.js stays protocol-agnostic:
//   list, stat, uploadFile, downloadFile, readFile, mkdirp,
//   deleteFile, deleteDir, rename, close
//
// Connections are per-tool-call: connect -> op -> close(). No pooling.

import SftpClient from "ssh2-sftp-client";
import { Writable } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

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

export async function connect(serverCfg) {
  const ctx = { host: serverCfg.host, port: serverCfg.port, user: serverCfg.user };
  const configuredRoot = normalizeRoot(serverCfg.root);
  const expectedHostKeys = decodeHostPins(serverCfg.hostKeySha256);
  if (expectedHostKeys.length === 0 && serverCfg.allowUnknownHostKey !== true) {
    throw new Error(unknownHostKeyBlockedMessage(serverCfg.name ?? serverCfg.host));
  }
  const sftp = new SftpClient();
  // Prevent a late connection-level 'error' from crashing the whole process
  // after we've already translated/handled the operational failure.
  sftp.on("error", () => {});

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

  try {
    await sftp.connect(connOpts);
    await canonicalRoot();
  } catch (err) {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
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
    const final = await validatePrefix(canonical, false);
    if (!final.exists) throw safetyError(`configured SFTP root does not exist: ${configuredRoot}`);
    const st = await sftp.lstat(canonical);
    assertSafeEntry(canonical, st, true);
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

    async uploadFile(localPath, remotePath) {
      try {
        await ensureDirectory(posix.dirname(remotePath));
        const parent = await safePath(posix.dirname(remotePath), { requireDirectory: true });
        const destination = await safePath(remotePath, { allowMissing: true });
        if (parent.root !== destination.root) {
          throw safetyError("configured SFTP root changed while validating upload");
        }
        await sftp.put(localPath, destination.path);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async downloadFile(remotePath, localPath) {
      try {
        const source = await safePath(remotePath);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await sftp.get(source.path, localPath);
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

    async deleteFile(p) {
      try {
        if (relativeRemote(configuredRoot, absoluteRemote(p, "remote path")) === "") {
          throw safetyError("refusing to delete the configured SFTP root");
        }
        const parent = await safePath(posix.dirname(p), { requireDirectory: true });
        const target = await safePath(p);
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

    async rename(from, to) {
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
        const destination = await safePath(to, { allowMissing: true });
        if (
          source.root !== sourceParent.root ||
          source.root !== destinationParent.root ||
          source.root !== destination.root
        ) {
          throw safetyError("configured SFTP root changed while validating rename");
        }
        await sftp.rename(source.path, destination.path);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: from });
      }
    },

    async close() {
      try {
        await sftp.end();
      } catch {
        /* ignore */
      }
    },
  };
}
