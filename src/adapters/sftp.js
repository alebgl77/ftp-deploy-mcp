// SFTP adapter built on ssh2-sftp-client.
//
// Same interface as adapters/ftp.js so tools.js stays protocol-agnostic:
//   list, stat, uploadFile, downloadFile, readFile, mkdirp,
//   deleteFile, deleteDir, rename, close
//
// Connections are per-tool-call: connect -> op -> close(). No pooling.

import SftpClient from "ssh2-sftp-client";
import { Writable } from "node:stream";
import path from "node:path";
import fs from "node:fs";

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
  const orig = err && err.message ? err.message : String(err);
  const code = err && err.code;
  const at = `${ctx.host}:${ctx.port}`;
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(orig)) {
    return new Error(`connection refused by ${at} — is the SFTP server reachable? [${orig}]`);
  }
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/.test(orig)) {
    return new Error(`host not found: ${ctx.host} [${orig}]`);
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

export async function connect(serverCfg) {
  const ctx = { host: serverCfg.host, port: serverCfg.port, user: serverCfg.user };
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
  } catch (err) {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
    throw friendlyError(err, ctx);
  }

  async function ensureParent(remotePath) {
    const parent = posix.dirname(remotePath);
    if (parent && parent !== "/" && parent !== ".") {
      await sftp.mkdir(parent, true);
    }
  }

  return {
    async list(dir) {
      try {
        const entries = await sftp.list(dir);
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
        const st = await sftp.stat(p);
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
        await ensureParent(remotePath);
        await sftp.put(localPath, remotePath);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: remotePath });
      }
    },

    async downloadFile(remotePath, localPath) {
      try {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await sftp.get(remotePath, localPath);
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
        await sftp.get(remotePath, sink);
      } catch (err) {
        if (!aborted) throw friendlyError(err, { ...ctx, path: remotePath });
      }
      return { buffer: Buffer.concat(chunks), truncated };
    },

    async mkdirp(dir) {
      try {
        await sftp.mkdir(dir, true);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: dir });
      }
    },

    async deleteFile(p) {
      try {
        await sftp.delete(p);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async deleteDir(p) {
      try {
        await sftp.rmdir(p, true);
      } catch (err) {
        throw friendlyError(err, { ...ctx, path: p });
      }
    },

    async rename(from, to) {
      try {
        await ensureParent(to);
        await sftp.rename(from, to);
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
