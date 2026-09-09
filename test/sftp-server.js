// Minimal in-process SFTP server for the smoke test, built on ssh2.
// Correctness over elegance: it maps a virtual absolute POSIX namespace onto a
// real temp directory (`root`) and implements just enough of the SFTP protocol
// for ssh2-sftp-client to exercise every tool.
//
// startSftpServer({ root, user, password, publicKey? })
//   -> Promise<{ port, hostKeySha256, getStats(), close() }>

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

// Virtual path -> canonical absolute POSIX path (for REALPATH replies).
function virtualNormalize(p) {
  const s = String(p == null ? "" : p).replace(/\\/g, "/");
  return path.posix.normalize("/" + s);
}

export function startSftpServer({ root, user, password, publicKey, initialModes = {}, denyChmod = false, ignoreChmod = false, onWrite, realPath }) {
  const realRoot = path.resolve(root);
  // Windows cannot represent all POSIX mode bits. Track protocol metadata
  // there; on POSIX every reported mode comes from the real filesystem.
  const windowsModes = new Map();
  const allowedKey = publicKey === undefined ? null : utils.parseKey(publicKey);
  if (allowedKey instanceof Error) throw allowedKey;

  // Virtual path -> real filesystem path under realRoot.
  function toReal(virtualPath) {
    const norm = virtualNormalize(virtualPath).replace(/^\/+/, "");
    return path.join(realRoot, norm);
  }

  for (const [remote, mode] of Object.entries(initialModes)) {
    const file = toReal(remote);
    fs.chmodSync(file, mode);
    if (process.platform === "win32") windowsModes.set(file, mode);
  }

  function attrsFromStats(st, file) {
    return {
      mode: windowsModes.has(file) ? (st.mode & ~0o777) | windowsModes.get(file) : st.mode,
      uid: 0,
      gid: 0,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  }

  function longname(name, st) {
    const typeChar = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "-";
    const when = new Date(st.mtimeMs).toString().slice(4, 16);
    return `${typeChar}rwxr-xr-x 1 user group ${st.size} ${when} ${name}`;
  }

  return new Promise((resolve, reject) => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const parsedHostKey = utils.parseKey(privateKey);
    if (parsedHostKey instanceof Error) return reject(parsedHostKey);
    const hostKeySha256 =
      "SHA256:" +
      crypto.createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("base64").replace(/=+$/, "");
    const stats = { authenticationAttempts: 0, sftpSessions: 0, publicKeyAuthentications: 0, permissions: [], removes: [], renames: [] };
    const clients = new Set();

    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      // A deliberately rejected host key ends key exchange and emits an error
      // on the server-side client object. It is expected in negative tests.
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        stats.authenticationAttempts++;
        if (ctx.method === "password" && password !== undefined && ctx.username === user && ctx.password === password) {
          ctx.accept();
        } else if (ctx.method === "publickey" && allowedKey && ctx.username === user) {
          const expected = allowedKey.getPublicSSH();
          if (ctx.key.algo !== allowedKey.type || ctx.key.data.length !== expected.length ||
              !crypto.timingSafeEqual(ctx.key.data, expected) ||
              (ctx.signature && allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)) {
            return ctx.reject();
          }
          if (ctx.signature) stats.publicKeyAuthentications++;
          ctx.accept();
        } else if (ctx.method === "none") {
          ctx.reject([...(password !== undefined ? ["password"] : []), ...(allowedKey ? ["publickey"] : [])]);
        } else {
          ctx.reject();
        }
      });

      client.on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          session.on("sftp", (acceptSftp) => {
            stats.sftpSessions++;
            const sftp = acceptSftp();
            wireSftp(sftp);
          });
        });
      });
    });

    function wireSftp(sftp) {
      const handles = new Map();
      sftp.on("close", () => {
        for (const h of handles.values()) {
          if (h.type === "file") {
            try { fs.closeSync(h.fd); } catch { /* already closed */ }
          }
        }
        handles.clear();
      });
      let nextId = 1;
      const makeHandle = (obj) => {
        const id = nextId++;
        handles.set(id, obj);
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(id, 0);
        return buf;
      };
      const getHandle = (buf) => {
        if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
        return handles.get(buf.readUInt32BE(0)) || null;
      };

      const fail = (reqid, err) => {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
          return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        }
        return sftp.status(reqid, STATUS_CODE.FAILURE);
      };

      sftp.on("REALPATH", (reqid, p) => {
        const v = realPath ? realPath(virtualNormalize(p)) : virtualNormalize(p);
        let attrs = { mode: 0o40755, size: 0 };
        try {
          attrs = attrsFromStats(fs.statSync(toReal(v)), toReal(v));
        } catch {
          /* path may not exist yet; still return a canonical name */
        }
        sftp.name(reqid, [{ filename: v, longname: `drwxr-xr-x 1 user group 0 Jan 1 00:00 ${v}`, attrs }]);
      });

      sftp.on("STAT", (reqid, p) => {
        try {
          sftp.attrs(reqid, attrsFromStats(fs.statSync(toReal(p)), toReal(p)));
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("LSTAT", (reqid, p) => {
        try {
          sftp.attrs(reqid, attrsFromStats(fs.lstatSync(toReal(p)), toReal(p)));
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("FSTAT", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
        try {
          sftp.attrs(reqid, attrsFromStats(h.type === "file" ? fs.fstatSync(h.fd) : fs.statSync(h.realPath), h.realPath));
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("OPENDIR", (reqid, p) => {
        const realPath = toReal(p);
        try {
          if (!fs.statSync(realPath).isDirectory()) {
            return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          }
        } catch (err) {
          return fail(reqid, err);
        }
        sftp.handle(reqid, makeHandle({ type: "dir", realPath, done: false }));
      });

      sftp.on("READDIR", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h || h.type !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
        h.done = true;
        let names = [];
        try {
          names = fs.readdirSync(h.realPath).map((name) => {
            const st = fs.statSync(path.join(h.realPath, name));
            return { filename: name, longname: longname(name, st), attrs: attrsFromStats(st, path.join(h.realPath, name)) };
          });
        } catch (err) {
          return fail(reqid, err);
        }
        sftp.name(reqid, names);
      });

      sftp.on("OPEN", (reqid, filename, flags, attrs) => {
        const realPath = toReal(filename);
        let fsFlags;
        if (flags & OPEN_MODE.WRITE) {
          fsFlags = flags & OPEN_MODE.EXCL ? "wx" : flags & OPEN_MODE.APPEND ? "a" :
            flags & OPEN_MODE.CREAT ? "w" : "r+";
        } else {
          fsFlags = "r";
        }
        let fd;
        try {
          fd = fs.openSync(realPath, fsFlags, attrs.mode);
          if (fsFlags === "wx") {
            windowsModes.delete(realPath);
            stats.permissions.push({ action: "create", path: filename, flags: fsFlags, mode: fs.fstatSync(fd).mode & 0o777 });
          }
        } catch (err) {
          return fail(reqid, err);
        }
        sftp.handle(reqid, makeHandle({ type: "file", realPath, fd }));
      });

      sftp.on("READ", (reqid, handle, offset, length) => {
        const h = getHandle(handle);
        if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
        const buf = Buffer.alloc(length);
        let bytesRead;
        try {
          bytesRead = fs.readSync(h.fd, buf, 0, length, offset);
        } catch (err) {
          return fail(reqid, err);
        }
        if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.data(reqid, buf.subarray(0, bytesRead));
      });

      sftp.on("WRITE", (reqid, handle, offset, data) => {
        const h = getHandle(handle);
        if (!h || h.type !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
        try {
          stats.permissions.push({ action: "write", path: h.realPath,
            mode: attrsFromStats(fs.fstatSync(h.fd), h.realPath).mode & 0o777 });
          onWrite?.({ path: h.realPath, offset, bytes: data.length });
          fs.writeSync(h.fd, data, 0, data.length, offset);
        } catch (err) {
          return fail(reqid, err);
        }
        sftp.status(reqid, STATUS_CODE.OK);
      });

      sftp.on("CLOSE", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (h.type === "file" && typeof h.fd === "number") {
          try {
            fs.closeSync(h.fd);
          } catch {
            /* ignore */
          }
        }
        if (Buffer.isBuffer(handle) && handle.length >= 4) handles.delete(handle.readUInt32BE(0));
        sftp.status(reqid, STATUS_CODE.OK);
      });

      sftp.on("MKDIR", (reqid, p, _attrs) => {
        try {
          fs.mkdirSync(toReal(p), { recursive: true });
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("RMDIR", (reqid, p) => {
        const realPath = toReal(p);
        try {
          if (!fs.existsSync(realPath)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          fs.rmSync(realPath, { recursive: true, force: true });
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("REMOVE", (reqid, p) => {
        try {
          stats.removes.push(p);
          fs.unlinkSync(toReal(p));
          windowsModes.delete(toReal(p));
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("RENAME", (reqid, oldPath, newPath) => {
        try {
          stats.renames.push([oldPath, newPath]);
          fs.renameSync(toReal(oldPath), toReal(newPath));
          if (windowsModes.has(toReal(oldPath))) {
            windowsModes.set(toReal(newPath), windowsModes.get(toReal(oldPath)));
            windowsModes.delete(toReal(oldPath));
          } else windowsModes.delete(toReal(newPath));
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      function setAttributes(reqid, file, attrs) {
        try {
          if (attrs.mode !== undefined) {
            const mode = attrs.mode & 0o777;
            stats.permissions.push({ action: "chmod", path: file, mode });
            if (typeof denyChmod === "function" ? denyChmod(mode, file) : denyChmod) {
              return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            }
            if (typeof ignoreChmod === "function" ? ignoreChmod(mode, file) : ignoreChmod) {
              return sftp.status(reqid, STATUS_CODE.OK);
            }
            fs.chmodSync(file, mode);
            if (process.platform === "win32") windowsModes.set(file, mode);
          }
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) { fail(reqid, err); }
      }
      sftp.on("SETSTAT", (reqid, p, attrs) => setAttributes(reqid, toReal(p), attrs));
      sftp.on("FSETSTAT", (reqid, handle, attrs) => {
        const h = getHandle(handle);
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
        setAttributes(reqid, h.realPath, attrs);
      });
    }

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        hostKeySha256,
        getStats: () => ({ ...stats }),
        close: () =>
          new Promise((res) => {
            for (const client of clients) client.end();
            server.close(() => res());
          }),
      });
    });
  });
}
