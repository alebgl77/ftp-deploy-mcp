// Real loopback transport qualification, not a general-purpose FTP server.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ssh2 from "ssh2";
import { connect as connectSftp } from "../src/adapters/sftp.js";
import { startSftpServer } from "./sftp-server.js";

const certPath = fileURLToPath(new URL("./fixtures/transport/localhost-cert.pem", import.meta.url));
const tlsOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(new URL("./fixtures/transport/localhost-key.pem", import.meta.url)),
};

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-transport-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "remote"));
  return dir;
}

async function startFtpsServer(root, { disconnectOnRead = false } = {}) {
  const sockets = new Set();
  const listeners = new Set();
  const stats = { commands: [], controlTLS: 0, dataTLS: 0, logins: 0, writes: 0, reads: 0, disconnects: 0 };
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {}); // Expected for rejected certificates/disconnects.
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    return socket;
  };
  const listen = async (server) => {
    listeners.add(server);
    server.on("close", () => listeners.delete(server));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  };
  const server = net.createServer((raw) => {
    let control = track(raw);
    let pending = "";
    let protectedData = false;
    let loggedIn = false;
    let renameFrom;
    let dataReady;
    const reply = (line) => control.write(`${line}\r\n`);
    const file = (name) => {
      // This fixture deliberately supports only flat, test-owned files.
      if (!/^\/[a-zA-Z0-9._-]+$/.test(name) || name === "/." || name === "/..") {
        throw new Error("Unsupported fixture path");
      }
      return path.join(root, name.slice(1));
    };
    const command = async (line) => {
      const [verb, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      stats.commands.push(verb); // Never retain passwords.
      if (verb === "AUTH" && arg === "TLS" && control === raw) {
        raw.removeListener("data", onData);
        reply("234 Start TLS");
        control = track(new tls.TLSSocket(raw, { isServer: true, secureContext: tls.createSecureContext(tlsOptions) }));
        control.on("secure", () => { stats.controlTLS++; });
        control.on("data", onData);
        return;
      }
      if (!(control instanceof tls.TLSSocket) || !control.getCipher()) return reply("534 TLS required");
      if (verb === "USER") return reply(arg === "fixture" ? "331 Password required" : "530 Rejected");
      if (verb === "PASS") {
        loggedIn = arg === "test-only-password";
        if (loggedIn) stats.logins++;
        return reply(loggedIn ? "230 Logged in" : "530 Rejected");
      }
      if (verb === "OPTS") return reply("200 Options accepted");
      if (!loggedIn) return reply("530 Login required");
      if (verb === "FEAT") return reply("211 No extensions");
      if (verb === "TYPE" || verb === "STRU" || verb === "PBSZ") return reply("200 Accepted");
      if (verb === "PROT") {
        protectedData = arg === "P";
        return reply(protectedData ? "200 Private data" : "536 Private data required");
      }
      if (verb === "EPSV") {
        if (!protectedData) return reply("536 Private data required");
        let resolveData;
        dataReady = new Promise((resolve) => { resolveData = resolve; });
        const passive = tls.createServer(tlsOptions, (socket) => {
          assert.ok(socket instanceof tls.TLSSocket && socket.encrypted && socket.getCipher());
          stats.dataTLS++;
          track(socket);
          passive.close();
          resolveData(socket);
        });
        passive.on("connection", track);
        passive.on("tlsClientError", () => {});
        const port = await listen(passive);
        return reply(`229 Entering Extended Passive Mode (|||${port}|)`);
      }
      if (verb === "STOR" || verb === "RETR") {
        if (!protectedData || !dataReady) return reply("425 No protected data connection");
        const target = file(arg);
        reply("150 Opening protected data connection");
        const data = await dataReady;
        dataReady = undefined;
        if (verb === "STOR") {
          const chunks = [];
          for await (const chunk of data) chunks.push(chunk);
          fs.writeFileSync(target, Buffer.concat(chunks));
          stats.writes++;
          reply("226 Transfer complete");
        } else if (disconnectOnRead) {
          stats.disconnects++;
          data.destroy();
          control.destroy();
        } else {
          stats.reads++;
          data.end(fs.readFileSync(target), () => reply("226 Transfer complete"));
        }
        return;
      }
      if (verb === "RNFR") { renameFrom = file(arg); return reply("350 Rename destination required"); }
      if (verb === "RNTO") { fs.renameSync(renameFrom, file(arg)); return reply("250 Renamed"); }
      if (verb === "DELE") { fs.unlinkSync(file(arg)); return reply("250 Deleted"); }
      if (verb === "QUIT") { control.end("221 Goodbye\r\n"); return; }
      reply("502 Unsupported fixture command");
    };
    let chain = Promise.resolve();
    function onData(chunk) {
      pending += chunk.toString("utf8");
      let index;
      while ((index = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        chain = chain.then(() => command(line)).catch(() => control.destroy());
      }
    }
    raw.on("data", onData);
    reply("220 Local TLS fixture");
  });
  const port = await listen(server);
  return {
    port,
    stats,
    async close() {
      const closed = [...listeners].map((listener) => new Promise((resolve) => listener.close(resolve)));
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
    },
  };
}

async function exercise(adapter, dir) {
  const payload = Buffer.from("TLS and SSH transport fixture\n".repeat(2048));
  const source = path.join(dir, "source.txt");
  const download = path.join(dir, "download.txt");
  fs.writeFileSync(source, payload);
  await adapter.uploadFile(source, "/uploaded.txt");
  const read = await adapter.readFile("/uploaded.txt", payload.length + 1);
  assert.equal(read.truncated, false);
  assert.deepEqual(read.buffer, payload);
  await adapter.rename("/uploaded.txt", "/renamed.txt");
  await adapter.downloadFile("/renamed.txt", download);
  assert.deepEqual(fs.readFileSync(download), payload);
  await adapter.deleteFile("/renamed.txt");
  return payload.length;
}

function ftpChild(server, dir, trusted) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_OPTIONS;
  if (trusted) env.NODE_EXTRA_CA_CERTS = certPath;
  const config = { protocol: "ftps", host: "127.0.0.1", port: server.port, user: "fixture", password: "test-only-password", root: "/" };
  const code = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { connect } from ${JSON.stringify(new URL("../src/adapters/ftp.js", import.meta.url).href)};
    const exercise = ${exercise.toString()};
    let adapter;
    try {
      adapter = await connect(${JSON.stringify(config)});
      console.log(JSON.stringify({ ok: true, bytes: await exercise(adapter, ${JSON.stringify(dir)}) }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    } finally { await adapter?.close(); }
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], { env, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

for (const mode of ["trusted", "untrusted", "disconnect"]) {
  test(`explicit FTPS local TLS fixture: ${mode}`, { timeout: 20000 }, async (t) => {
    const dir = scratch(t);
    const server = await startFtpsServer(path.join(dir, "remote"), { disconnectOnRead: mode === "disconnect" });
    try {
      const result = await ftpChild(server, dir, mode !== "untrusted");
      if (mode === "trusted") {
        assert.deepEqual(result, { ok: true, bytes: 61440 });
        assert.equal(server.stats.controlTLS, 1);
        assert.equal(server.stats.dataTLS, 3);
        assert.equal(server.stats.writes, 1);
        assert.equal(server.stats.reads, 2);
        assert.deepEqual(fs.readdirSync(path.join(dir, "remote")), []);
        assert.ok(server.stats.commands.includes("AUTH") && server.stats.commands.includes("PROT"));
      } else {
        assert.equal(result.ok, false);
        assert.match(result.error, mode === "untrusted" ? /self.signed|certificate/i : /closed|disconnect|socket|FIN/i);
        assert.equal(server.stats.logins, mode === "untrusted" ? 0 : 1);
        assert.equal(server.stats.writes, mode === "untrusted" ? 0 : 1);
        assert.equal(server.stats.dataTLS, mode === "untrusted" ? 0 : 2);
        assert.equal(server.stats.disconnects, mode === "untrusted" ? 0 : 1);
      }
    } finally { await server.close(); }
  });
}

function clientKey(dir, name) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const parsed = ssh2.utils.parseKey(privateKey);
  const privateKeyPath = path.join(dir, `${name}.pem`);
  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  return { privateKeyPath, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString("base64")}` };
}

for (const mode of ["valid key", "wrong key", "wrong host pin"]) {
  test(`SFTP public-key authentication: ${mode}`, { timeout: 20000 }, async (t) => {
    const dir = scratch(t);
    const key = clientKey(dir, "client");
    const server = await startSftpServer({ root: path.join(dir, "remote"), user: "fixture", publicKey: key.publicKey });
    const config = {
      protocol: "sftp", host: "127.0.0.1", port: server.port, user: "fixture", root: "/",
      privateKeyPath: mode === "wrong key" ? clientKey(dir, "wrong").privateKeyPath : key.privateKeyPath,
      hostKeySha256: mode === "wrong host pin" ? `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/, "")}` : server.hostKeySha256,
    };
    let adapter;
    try {
      if (mode === "valid key") {
        adapter = await connectSftp(config);
        assert.equal(await exercise(adapter, dir), 61440);
        assert.equal(server.getStats().publicKeyAuthentications, 1);
        assert.equal(server.getStats().sftpSessions, 1);
        assert.deepEqual(fs.readdirSync(path.join(dir, "remote")), []);
      } else {
        await assert.rejects(connectSftp(config), mode === "wrong key" ? /authentication failed/i : /host key verification failed/i);
        assert.equal(server.getStats().publicKeyAuthentications, 0);
        assert.equal(server.getStats().sftpSessions, 0);
        if (mode === "wrong host pin") assert.equal(server.getStats().authenticationAttempts, 0);
        assert.deepEqual(fs.readdirSync(path.join(dir, "remote")), []);
      }
    } finally {
      await adapter?.close();
      await server.close();
    }
  });
}
