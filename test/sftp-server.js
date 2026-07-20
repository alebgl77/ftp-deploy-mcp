// Minimal in-process SFTP server for the smoke test, built on ssh2.
// Correctness over elegance: it maps a virtual absolute POSIX namespace onto a
// real temp directory (`root`) and implements just enough of the SFTP protocol
// for ssh2-sftp-client to exercise every tool.
//
// startSftpServer({ root, user, password }) -> Promise<{ port, close() }>

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

export function startSftpServer({ root, user, password }) {
  const realRoot = path.resolve(root);

  // Virtual path -> real filesystem path under realRoot.
  function toReal(virtualPath) {
    const norm = virtualNormalize(virtualPath).replace(/^\/+/, "");
    return path.join(realRoot, norm);
  }

  function attrsFromStats(st) {
    return {
      mode: st.mode,
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

    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.username === user && ctx.password === password) {
          ctx.accept();
        } else if (ctx.method === "none") {
          ctx.reject(["password"]);
        } else {
          ctx.reject();
        }
      });

      client.on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            wireSftp(sftp);
          });
        });
      });
    });

    function wireSftp(sftp) {
      const handles = new Map();
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
        const v = virtualNormalize(p);
        let attrs = { mode: 0o40755, size: 0 };
        try {
          attrs = attrsFromStats(fs.statSync(toReal(v)));
        } catch {
          /* path may not exist yet; still return a canonical name */
        }
        sftp.name(reqid, [{ filename: v, longname: `drwxr-xr-x 1 user group 0 Jan 1 00:00 ${v}`, attrs }]);
      });

      sftp.on("STAT", (reqid, p) => {
        try {
          sftp.attrs(reqid, attrsFromStats(fs.statSync(toReal(p))));
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("LSTAT", (reqid, p) => {
        try {
          sftp.attrs(reqid, attrsFromStats(fs.lstatSync(toReal(p))));
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("FSTAT", (reqid, handle) => {
        const h = getHandle(handle);
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
        try {
          sftp.attrs(reqid, attrsFromStats(fs.statSync(h.realPath)));
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
            return { filename: name, longname: longname(name, st), attrs: attrsFromStats(st) };
          });
        } catch (err) {
          return fail(reqid, err);
        }
        sftp.name(reqid, names);
      });

      sftp.on("OPEN", (reqid, filename, flags, _attrs) => {
        const realPath = toReal(filename);
        let fsFlags;
        if (flags & OPEN_MODE.WRITE) {
          fsFlags = flags & OPEN_MODE.APPEND ? "a" : "w";
        } else {
          fsFlags = "r";
        }
        let fd;
        try {
          fd = fs.openSync(realPath, fsFlags);
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
          fs.unlinkSync(toReal(p));
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      sftp.on("RENAME", (reqid, oldPath, newPath) => {
        try {
          fs.renameSync(toReal(oldPath), toReal(newPath));
          sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          fail(reqid, err);
        }
      });

      // Accept (and ignore) attribute changes so put()/get() finalization works.
      sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
      sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
    }

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
