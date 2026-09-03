// Smoke / acceptance test for ftp-deploy-mcp. Plain Node, no test framework.
// Runs on Windows. Exits 0 only if every PASS line printed and none FAILed.
//
// PART A  jail math + FileZilla import (no network)
// PART B  local FTP server (ftp-srv)
// PART C  local SFTP server (test/sftp-server.js)
// PART D  spawn the MCP server, drive it over stdio JSON-RPC, list tools
// PART E  full scenario, run twice (FTP then SFTP)
// PART F  read-only guard, list-servers, credential-leak + bad-server checks

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FtpSrv from "@electerm/ftp-srv";
import { startSftpServer } from "./sftp-server.js";
import { resolveRemote, isRootPath, normalizeRoot } from "../src/remote-path.js";
import { parseSiteManager, decodeRemoteDir } from "../src/filezilla.js";
import { loadConfig, normalizeServer, insecureTransport, resolveServer } from "../src/config.js";
import { getClients, mergeConfigFile, applyClient, buildEntry } from "../src/clients.js";
import { runToolsSecurityTests } from "./tools-security.js";
import { runMcpContractTests } from "./mcp-contract.js";
import { atomicWriteFileSync } from "../src/atomic-write.js";
import { createRedactor } from "../src/redact.js";
import { registerTools } from "../src/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const TEST_USER = "mcp";
const TEST_PASS = "s3cr3t-P@ss-DO-NOT-LEAK";

// ---- assert helpers -------------------------------------------------------
let passCount = 0;
let failCount = 0;
const failDetails = [];
function ok(cond, msg, detail) {
  if (cond) {
    passCount++;
    console.log(`PASS: ${msg}`);
  } else {
    failCount++;
    console.log(`FAIL: ${msg}`);
    if (detail !== undefined) failDetails.push(`${msg}\n   ${detail}`);
  }
}
function contains(text, sub, msg) {
  ok(typeof text === "string" && text.includes(sub), msg, `got: ${JSON.stringify(String(text).slice(0, 400))}`);
}
function notContains(text, sub, msg) {
  ok(typeof text === "string" && !text.includes(sub), msg, `unexpectedly contained ${JSON.stringify(sub)}`);
}
function throws(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, msg);
}

function injectedFs(method, replacement) {
  let calls = 0;
  return new Proxy(fs, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === method) {
        return (...args) => {
          calls += 1;
          return replacement({ calls, target, args });
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function tempFilesFor(filePath) {
  const prefix = `.${path.basename(filePath)}.`;
  return fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
}

function partAtomicWriter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-atomic-"));
  try {
    const created = path.join(root, "nested", "config.json");
    let openFlags;
    let openMode;
    let mkdirMode;
    const observedFs = new Proxy(fs, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "openSync") {
          return (file, flags, mode) => {
            openFlags = flags;
            openMode = mode;
            return target.openSync(file, flags, mode);
          };
        }
        if (prop === "mkdirSync") {
          return (dir, options) => {
            mkdirMode = options.mode;
            return target.mkdirSync(dir, options);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    atomicWriteFileSync(created, "first\n", { _fs: observedFs, _platform: "win32" });
    ok(fs.readFileSync(created, "utf8") === "first\n", "atomic writer: creates a complete file");
    ok(openFlags === "wx" && openMode === 0o600, "atomic writer: opens a unique temp with wx/0600");
    ok(mkdirMode === 0o700, "atomic writer: creates the parent with mode 0700");

    atomicWriteFileSync(created, "second\n");
    ok(fs.readFileSync(created, "utf8") === "second\n", "atomic writer: atomically replaces existing content");
    ok(tempFilesFor(created).length === 0, "atomic writer: successful replacement leaves no temp file");

    const partialFs = injectedFs("writeSync", ({ target, args }) => {
      const [fd, buffer, offset, length, position] = args;
      return target.writeSync(fd, buffer, offset, Math.min(2, length), position);
    });
    atomicWriteFileSync(created, "complete-after-short-writes", { _fs: partialFs });
    ok(fs.readFileSync(created, "utf8") === "complete-after-short-writes", "atomic writer: retries partial writes to completion");

    for (const phase of ["writeSync", "fsyncSync", "closeSync", "renameSync"]) {
      fs.writeFileSync(created, "old-complete");
      const failingFs = injectedFs(phase, ({ calls, target, args }) => {
        if (calls === 1) {
          const err = new Error(`injected ${phase}`);
          err.code = "EIO";
          throw err;
        }
        return target[phase](...args);
      });
      throws(
        () => atomicWriteFileSync(created, "new-complete", { _fs: failingFs }),
        `atomic writer: propagates injected ${phase} failure`
      );
      ok(fs.readFileSync(created, "utf8") === "old-complete", `atomic writer: ${phase} failure preserves old target`);
      ok(tempFilesFor(created).length === 0, `atomic writer: ${phase} failure cleans its temp file`);
    }

    fs.writeFileSync(created, "old-before-open");
    const openFailureFs = injectedFs("openSync", () => {
      const err = new Error("injected openSync");
      err.code = "EACCES";
      throw err;
    });
    throws(() => atomicWriteFileSync(created, "new", { _fs: openFailureFs }), "atomic writer: propagates temp open failure");
    ok(fs.readFileSync(created, "utf8") === "old-before-open", "atomic writer: temp open failure preserves old target");
    ok(tempFilesFor(created).length === 0, "atomic writer: temp open failure leaves no residue");

    fs.writeFileSync(created, "old-before-chmod");
    const chmodFailureFs = injectedFs("chmodSync", ({ calls, target, args }) => {
      if (calls === 1) {
        const err = new Error("injected chmodSync");
        err.code = "EACCES";
        throw err;
      }
      return target.chmodSync(...args);
    });
    throws(
      () => atomicWriteFileSync(created, "new", { _fs: chmodFailureFs, _platform: "linux" }),
      "atomic writer: propagates pre-rename chmod failure"
    );
    ok(fs.readFileSync(created, "utf8") === "old-before-chmod", "atomic writer: pre-rename chmod failure preserves old target");
    ok(tempFilesFor(created).length === 0, "atomic writer: pre-rename chmod failure cleans its temp file");

    const modeTarget = path.join(root, "mode.json");
    fs.writeFileSync(modeTarget, "old");
    const chmods = [];
    const modeFs = new Proxy(fs, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "statSync") {
          return (file) => {
            const stat = target.statSync(file);
            return file === path.resolve(modeTarget) ? { ...stat, mode: 0o100400 } : stat;
          };
        }
        if (prop === "chmodSync") {
          return (file, mode) => {
            chmods.push([path.resolve(file), mode]);
            return target.chmodSync(file, mode);
          };
        }
        if (prop === "openSync") {
          return (file, flags, mode) => {
            if (path.resolve(file) === path.resolve(root) && flags === "r") {
              const err = new Error("directory fsync unsupported by test platform");
              err.code = "EINVAL";
              throw err;
            }
            return target.openSync(file, flags, mode);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    atomicWriteFileSync(modeTarget, "new", { _fs: modeFs, _platform: "linux" });
    ok(chmods.some(([file, mode]) => file === path.resolve(modeTarget) && mode === 0o400), "atomic writer: preserves a stricter existing POSIX mode");
    ok(tempFilesFor(modeTarget).length === 0, "atomic writer: unsupported directory fsync is non-fatal and clean");

    const committedTarget = path.join(root, "directory-fsync.json");
    fs.writeFileSync(committedTarget, "old");
    const directoryFd = 987654321;
    const directoryFsyncFs = new Proxy(fs, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "openSync") {
          return (file, flags, mode) =>
            path.resolve(file) === path.resolve(root) && flags === "r"
              ? directoryFd
              : target.openSync(file, flags, mode);
        }
        if (prop === "fsyncSync") {
          return (fd) => {
            if (fd === directoryFd) {
              const err = new Error("injected directory fsync failure");
              err.code = "EIO";
              throw err;
            }
            return target.fsyncSync(fd);
          };
        }
        if (prop === "closeSync") {
          return (fd) => (fd === directoryFd ? undefined : target.closeSync(fd));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    throws(
      () => atomicWriteFileSync(committedTarget, "new-complete", { _fs: directoryFsyncFs, _platform: "linux" }),
      "atomic writer: propagates a real parent-directory fsync failure"
    );
    ok(fs.readFileSync(committedTarget, "utf8") === "new-complete", "atomic writer: post-rename fsync failure leaves a complete new target");
    ok(tempFilesFor(committedTarget).length === 0, "atomic writer: post-rename fsync failure leaves no temp file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function partRedaction(root) {
  const password = "sentinel-password-never-print";
  const passphrase = "sentinel-passphrase-never-print";
  const envName = "FTPMCP_REDACTION_SENTINEL";
  const envValue = "sentinel-env-value-never-print";
  const previousEnv = process.env[envName];
  process.env[envName] = envValue;
  try {
    const redactor = createRedactor({ password, passphrase, token: `\${ENV:${envName}}` });
    const cleaned = redactor.text(`${password} ${passphrase} ${envValue} ${envName} abc`);
    notContains(cleaned, password, "redaction: removes a known password");
    notContains(cleaned, passphrase, "redaction: removes a known passphrase");
    notContains(cleaned, envValue, "redaction: removes a known substituted ENV value");
    contains(cleaned, envName, "redaction: preserves useful ENV variable names");
    contains(cleaned, "abc", "redaction: does not replace short strings globally");
    const placeholderJson = redactor.text(JSON.stringify({ password: `\${ENV:${envName}}` }));
    contains(placeholderJson, envName, "redaction: preserves an ENV name used as a password placeholder");

    const privateKey = "-----BEGIN PRIVATE KEY-----\nPRIVATE-CONTENT-SENTINEL\n-----END PRIVATE KEY-----";
    const loaded = {
      found: true,
      error: null,
      config: {
        defaultServer: "test",
        servers: {
          test: {
            protocol: "sftp",
            host: "test.invalid",
            user: "tester",
            password,
            passphrase,
            root: "/",
            localRoot: root,
            hostKeySha256: `SHA256:${Buffer.alloc(32, 4).toString("base64").replace(/=+$/, "")}`,
          },
        },
      },
      serverNames: ["test"],
      invalidServerNames: [],
      serverErrors: {},
      defaultServer: "test",
    };
    const handlers = new Map();
    registerTools(
      { registerTool(name, _definition, handler) { handlers.set(name, handler); } },
      loaded,
      {
        openAdapter: async () => ({
          async list() { throw new Error(`${password} ${passphrase}\n${privateKey}`); },
          async close() {},
        }),
      }
    );
    const result = await handlers.get("ftp_list")({ path: "" }, {});
    const text = result.content.map((item) => item.text || "").join("\n");
    ok(result.isError === true, "redaction: simulated adapter failure remains an MCP error");
    notContains(text, password, "redaction: MCP adapter errors remove passwords");
    notContains(text, passphrase, "redaction: MCP adapter errors remove passphrases");
    notContains(text, "PRIVATE-CONTENT-SENTINEL", "redaction: MCP adapter errors remove private-key content");

    const shortSecrets = { password: "a", passphrase: "ab", privateKeyData: "abc" };
    const strictDiagnostic = createRedactor(shortSecrets).strictText(
      "HOST KEY REFUSED\nUNSAFE ROOT REFUSED\nFTP\n${ENV:NAME}\nsecrets: a | ab | abc"
    );
    ok(
      strictDiagnostic ===
        "HOST KEY REFUSED\nUNSAFE ROOT REFUSED\nFTP\n${ENV:NAME}\nsecrets: [REDACTED] | [REDACTED] | [REDACTED]",
      "redaction: ASCII secrets a/ab/abc are isolated while diagnostics and ENV markers remain exact",
      strictDiagnostic
    );
    const shortLoaded = {
      ...loaded,
      config: {
        defaultServer: "test",
        servers: { test: { ...loaded.config.servers.test, ...shortSecrets } },
      },
    };
    const failingHandlers = new Map();
    registerTools(
      { registerTool(name, _definition, handler) { failingHandlers.set(name, handler); } },
      shortLoaded,
      {
        openAdapter: async () => ({
          async list() {
            throw new Error(`primary operation failed: ${shortSecrets.password} | ${shortSecrets.passphrase} | ${shortSecrets.privateKeyData}`);
          },
          async close() {
            throw new Error(`secondary close failed: ${shortSecrets.password} | ${shortSecrets.passphrase} | ${shortSecrets.privateKeyData}`);
          },
        }),
      }
    );
    const failed = await failingHandlers.get("ftp_list")({ path: "" }, {});
    const failedText = failed.content.map((item) => item.text || "").join("\n");
    contains(failedText, "primary operation failed", "redaction: operation error remains primary when close also fails");
    contains(failedText, "Connection close also failed", "redaction: close failure is retained as secondary context");
    notContains(failedText, "a | ab | abc", "redaction: strict MCP errors remove isolated a/ab/abc values");
    contains(failedText, "[REDACTED] | [REDACTED] | [REDACTED]", "redaction: strict MCP errors retain readable redaction markers");

    const successHandlers = new Map();
    registerTools(
      { registerTool(name, _definition, handler) { successHandlers.set(name, handler); } },
      shortLoaded,
      {
        openAdapter: async () => ({
          async list() {
            return [{ type: "file", name: `visible-${shortSecrets.password}-${shortSecrets.passphrase}-${shortSecrets.privateKeyData}`, size: 1 }];
          },
          async close() {},
        }),
      }
    );
    const succeeded = await successHandlers.get("ftp_list")({ path: "" }, {});
    const succeededText = succeeded.content.map((item) => item.text || "").join("\n");
    ok(succeeded.isError !== true, "redaction: short-secret success fixture remains a successful tool result");
    for (const [key, secret] of Object.entries(shortSecrets)) {
      contains(succeededText, secret, `redaction: prudent success output does not corrupt short ${key} text`);
    }

    for (const thrown of [null, false, 0]) {
      const falsyHandlers = new Map();
      registerTools(
        { registerTool(name, _definition, handler) { falsyHandlers.set(name, handler); } },
        loaded,
        {
          openAdapter: async () => ({
            async list() { throw thrown; },
            async close() { throw new Error("secondary close failure"); },
          }),
        }
      );
      const falsyResult = await falsyHandlers.get("ftp_list")({ path: "" }, {});
      const falsyText = falsyResult.content.map((item) => item.text || "").join("\n");
      contains(falsyText, String(thrown), `tools: thrown ${String(thrown)} remains the primary operation failure`);
      contains(falsyText, "Connection close also failed", `tools: thrown ${String(thrown)} retains secondary close failure`);
    }
  } finally {
    if (previousEnv === undefined) delete process.env[envName];
    else process.env[envName] = previousEnv;
  }
}

// ---- resources to clean up ------------------------------------------------
let ftpServer = null;
let sftpServer = null;
let child = null;
let baseDir = null;
const allToolTexts = []; // for the global credential-leak check

const watchdog = setTimeout(() => {
  console.log("FAIL: watchdog — test exceeded 120s");
  process.exit(1);
}, 120000);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ---- MCP stdio client -----------------------------------------------------
function makeMcpClient(childProc) {
  let buf = "";
  const pending = new Map();
  const stderr = [];
  const nonJson = [];

  childProc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const t = line.trim();
      if (!t) continue;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        nonJson.push(t);
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  childProc.stderr.on("data", (d) => stderr.push(d.toString()));

  let idc = 0;
  function send(method, params, timeoutMs = 15000) {
    const id = ++idc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      childProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    childProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async function callTool(name, args) {
    const msg = await send("tools/call", { name, arguments: args || {} }, 15000);
    if (msg.error) {
      const text = `Error: ${msg.error.message}`;
      allToolTexts.push(text);
      return { isError: true, text };
    }
    const r = msg.result || {};
    const text = (r.content || []).map((c) => c.text || "").join("\n");
    allToolTexts.push(text);
    return { isError: !!r.isError, text, raw: r };
  }
  return { send, notify, callTool, stderr, nonJson };
}

// ---- scenario (PART E), run per protocol ----------------------------------
async function runScenario(client, serverName, proto, sampleDir, workDir, diskCheck) {
  const tag = `[${proto}]`;

  // 1. connection test
  let r = await client.callTool("ftp_test", { server: serverName });
  contains(r.text, "OK", `${tag} ftp_test returns OK`);

  // 2. mkdir a/b/c then list a/b shows [DIR] c
  r = await client.callTool("ftp_mkdir", { server: serverName, path: "a/b/c" });
  ok(!r.isError, `${tag} ftp_mkdir a/b/c succeeds`, r.text);
  r = await client.callTool("ftp_list", { server: serverName, path: "a/b" });
  contains(r.text, "[DIR] c", `${tag} ftp_list a/b shows [DIR] c`);

  // 3. upload a local file, read it back, list shows size
  const helloLocal = path.join(workDir, `hello-${proto}.txt`);
  const helloContent = `hello-${proto}`;
  fs.writeFileSync(helloLocal, helloContent);
  r = await client.callTool("ftp_upload", {
    server: serverName,
    local_path: helloLocal,
    remote_path: "a/b/c/hello.txt",
  });
  ok(!r.isError, `${tag} ftp_upload hello.txt succeeds`, r.text);
  r = await client.callTool("ftp_read", { server: serverName, path: "a/b/c/hello.txt" });
  contains(r.text, helloContent, `${tag} ftp_read returns uploaded content`);
  r = await client.callTool("ftp_list", { server: serverName, path: "a/b/c" });
  contains(r.text, "hello.txt", `${tag} ftp_list a/b/c shows hello.txt`);
  ok(/hello\.txt \(\d+\s?B/.test(r.text), `${tag} ftp_list shows file size`, r.text);

  // 3b. read honors max_bytes (truncation) and refuses binary files
  r = await client.callTool("ftp_read", { server: serverName, path: "a/b/c/hello.txt", max_bytes: 3 });
  ok(!r.isError && r.text.includes("TRUNCATED"), `${tag} ftp_read honors max_bytes`, r.text);
  const binLocal = path.join(workDir, `bin-${proto}.dat`);
  fs.writeFileSync(binLocal, Buffer.from([104, 105, 0, 104, 105]));
  r = await client.callTool("ftp_upload", { server: serverName, local_path: binLocal, remote_path: "a/b/c/bin.dat" });
  ok(!r.isError, `${tag} upload binary file`, r.text);
  r = await client.callTool("ftp_read", { server: serverName, path: "a/b/c/bin.dat" });
  contains(r.text, "binary file", `${tag} ftp_read refuses binary file`);

  // 4. deploy with excludes + dry run
  let dry = await client.callTool("ftp_deploy", {
    server: serverName,
    local_dir: sampleDir,
    remote_dir: "deploy",
    dry_run: true,
  });
  contains(dry.text, "3 files", `${tag} ftp_deploy dry_run reports 3 files`);
  notContains(dry.text, "node_modules", `${tag} dry_run excludes node_modules`);
  notContains(dry.text, ".env", `${tag} dry_run excludes .env`);
  notContains(dry.text, "debug.log", `${tag} dry_run excludes debug.log`);
  // dry run must not have created anything remote
  let afterDry = await client.callTool("ftp_list", { server: serverName, path: "deploy" });
  notContains(afterDry.text, "index.html", `${tag} dry_run created nothing remote`);

  let real = await client.callTool("ftp_deploy", {
    server: serverName,
    local_dir: sampleDir,
    remote_dir: "deploy",
  });
  ok(!real.isError, `${tag} ftp_deploy real run succeeds`, real.text);
  contains(real.text, "index.html", `${tag} ftp_deploy uploaded index.html`);
  r = await client.callTool("ftp_list", { server: serverName, path: "deploy" });
  contains(r.text, "index.html", `${tag} deploy dir has index.html`);
  contains(r.text, "css", `${tag} deploy dir has css/`);
  contains(r.text, "js", `${tag} deploy dir has js/`);
  notContains(r.text, "node_modules", `${tag} deploy dir excludes node_modules`);
  notContains(r.text, ".env", `${tag} deploy dir excludes .env`);
  notContains(r.text, "debug.log", `${tag} deploy dir excludes debug.log`);
  // nested-only-excluded subtrees must not exist remotely at all (no empty
  // parent dirs created for a subtree whose every file was excluded)
  notContains(r.text, "apps", `${tag} deploy dir has no apps/ (fully-excluded subtree)`);
  notContains(r.text, "sub", `${tag} deploy dir has no sub/ (fully-excluded subtree)`);
  notContains(r.text, "packages", `${tag} deploy dir has no packages/ (fully-excluded subtree)`);
  notContains(r.text, "vendor", `${tag} deploy dir has no vendor/ (fully-excluded subtree)`);

  // 5. download + overwrite guard
  const dlPath = path.join(workDir, `dl-${proto}.txt`);
  r = await client.callTool("ftp_download", {
    server: serverName,
    remote_path: "a/b/c/hello.txt",
    local_path: dlPath,
  });
  ok(!r.isError, `${tag} ftp_download succeeds`, r.text);
  ok(
    fs.existsSync(dlPath) && fs.readFileSync(dlPath, "utf8") === helloContent,
    `${tag} downloaded file has correct content`
  );
  r = await client.callTool("ftp_download", {
    server: serverName,
    remote_path: "a/b/c/hello.txt",
    local_path: dlPath,
  });
  ok(r.isError && r.text.includes("overwrite"), `${tag} download refuses overwrite`, r.text);

  // 6. rename
  r = await client.callTool("ftp_rename", {
    server: serverName,
    from_path: "a/b/c/hello.txt",
    to_path: "a/b/c/hello2.txt",
  });
  ok(!r.isError, `${tag} ftp_rename succeeds`, r.text);
  r = await client.callTool("ftp_list", { server: serverName, path: "a/b/c" });
  contains(r.text, "hello2.txt", `${tag} rename produced hello2.txt`);
  notContains(r.text, "hello.txt\n", `${tag} rename removed hello.txt`);

  // 7. delete file, then dir guard, then recursive delete
  r = await client.callTool("ftp_delete", { server: serverName, path: "a/b/c/hello2.txt" });
  ok(!r.isError, `${tag} delete file succeeds`, r.text);
  r = await client.callTool("ftp_delete", { server: serverName, path: "a" });
  ok(r.isError && r.text.includes("recursive"), `${tag} delete dir without recursive errors`, r.text);
  r = await client.callTool("ftp_delete", { server: serverName, path: "a", recursive: true });
  ok(!r.isError, `${tag} recursive delete succeeds`, r.text);
  r = await client.callTool("ftp_list", { server: serverName, path: "" });
  notContains(r.text, "[DIR] a\n", `${tag} directory a is gone`);

  // 8. jail escapes
  r = await client.callTool("ftp_list", { server: serverName, path: "../.." });
  ok(r.isError && r.text.includes("escapes"), `${tag} jail: list ../.. rejected`, r.text);
  r = await client.callTool("ftp_delete", { server: serverName, path: "/" });
  ok(r.isError, `${tag} jail: delete root rejected`, r.text);

  // 9. SFTP: confirm files really landed under <tmp>/jail
  if (diskCheck) {
    ok(fs.existsSync(diskCheck), `${tag} deployed file exists on disk under jail`, diskCheck);
  }
}

// ---- setup/doctor CLI runner (PART H) -------------------------------------
// Spawns `node <projectRoot>/src/index.js <args>` with FTP_MCP_CONFIG stripped
// and a neutral cwd, so no real config can leak in (the --home flag isolates
// the rest). Resolves { code, stdout, stderr }.
function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(opts.env || {}) };
    delete env.FTP_MCP_CONFIG;
    const cp = spawn(process.execPath, [path.join(projectRoot, "src", "index.js"), ...args], {
      cwd: opts.cwd || projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    cp.stdout.on("data", (d) => (out += d.toString("utf8")));
    cp.stderr.on("data", (d) => (err += d.toString("utf8")));
    cp.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

// ===== PART G: clients.js unit (direct import, fake ctx) =====================
function partG() {
  const gTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-g-"));
  const mkctx = (home) => ({ home, platform: "win32", appData: path.join(home, "AppData", "Roaming") });
  const entry = buildEntry({ absIndexJs: "C:/x/src/index.js" });
  try {
    // G.1 detection
    const h1 = path.join(gTmp, "detect");
    fs.mkdirSync(path.join(h1, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(h1, ".codeium", "windsurf"), { recursive: true });
    fs.mkdirSync(path.join(h1, ".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(path.join(h1, "AppData", "Roaming", "Claude"), { recursive: true });
    fs.writeFileSync(
      path.join(h1, ".claude.json"),
      JSON.stringify({ foo: 1, mcpServers: { other: { command: "x" } } })
    );
    const byId = Object.fromEntries(getClients(mkctx(h1)).map((c) => [c.id, c]));
    ok(byId["claude-code"].detected, "clients G.1: claude-code detected (.claude.json)");
    ok(byId["claude-desktop"].detected, "clients G.1: claude-desktop detected (AppData/Roaming/Claude)");
    ok(byId["cursor"].detected, "clients G.1: cursor detected");
    ok(byId["windsurf"].detected, "clients G.1: windsurf detected");
    ok(byId["antigravity"].detected, "clients G.1: antigravity detected");
    const empty = path.join(gTmp, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const none = getClients(mkctx(empty)).filter((c) => c.kind === "file" && c.detected);
    ok(none.length === 0, "clients G.1: fresh empty home detects no file clients", JSON.stringify(none.map((c) => c.id)));

    // G.2 merge into existing cursor mcp.json with another server + sibling key
    const cursorFile = path.join(h1, ".cursor", "mcp.json");
    fs.writeFileSync(cursorFile, JSON.stringify({ version: 1, mcpServers: { other: { command: "y" } } }, null, 2));
    const r2 = mergeConfigFile(cursorFile, entry);
    ok(r2.status === "updated", "clients G.2: merge into existing cursor → updated", r2.status);
    ok(!!r2.backupPath && fs.existsSync(r2.backupPath), "clients G.2: backup file created", r2.backupPath);
    const p2 = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    ok(p2.mcpServers.ftp && p2.mcpServers.ftp.command === "node", "clients G.2: ftp added");
    ok(p2.mcpServers.other && p2.mcpServers.other.command === "y", "clients G.2: other server preserved");
    ok(p2.version === 1, "clients G.2: sibling top-level key preserved");

    // G.3 idempotence
    const before3 = fs.readFileSync(cursorFile, "utf8");
    const backupsBefore = fs.readdirSync(path.join(h1, ".cursor")).filter((f) => f.includes(".backup-"));
    const r3 = mergeConfigFile(cursorFile, entry);
    ok(r3.status === "already", "clients G.3: second merge → already", r3.status);
    ok(!r3.backupPath, "clients G.3: no backup on already");
    ok(before3 === fs.readFileSync(cursorFile, "utf8"), "clients G.3: file byte-identical");
    const backupsAfter = fs.readdirSync(path.join(h1, ".cursor")).filter((f) => f.includes(".backup-"));
    ok(backupsAfter.length === backupsBefore.length, "clients G.3: no new backup on idempotent merge");

    // G.4 conflict
    const conflictFile = path.join(gTmp, "conflict.json");
    fs.writeFileSync(conflictFile, JSON.stringify({ mcpServers: { ftp: { command: "node", args: ["OLD"] } } }, null, 2));
    const r4a = mergeConfigFile(conflictFile, entry, { force: false });
    ok(r4a.status === "skipped-different", "clients G.4: conflict force=false → skipped-different", r4a.status);
    ok(JSON.parse(fs.readFileSync(conflictFile, "utf8")).mcpServers.ftp.args[0] === "OLD", "clients G.4: file untouched when not forced");
    const r4b = mergeConfigFile(conflictFile, entry, { force: true });
    ok(r4b.status === "updated" && !!r4b.backupPath, "clients G.4: conflict force=true → updated + backup", r4b.status);
    ok(JSON.parse(fs.readFileSync(conflictFile, "utf8")).mcpServers.ftp.args[0] === "C:/x/src/index.js", "clients G.4: entry overwritten when forced");

    // G.5 unparseable
    const badFile = path.join(gTmp, "bad.json");
    fs.writeFileSync(badFile, "{ not json ");
    const r5 = mergeConfigFile(badFile, entry);
    ok(r5.status === "unparseable", "clients G.5: unparseable → status unparseable", r5.status);
    ok(fs.readFileSync(badFile, "utf8") === "{ not json ", "clients G.5: file left untouched");
    ok(fs.readdirSync(gTmp).filter((f) => f.startsWith("bad.json.backup-")).length === 0, "clients G.5: no backup for unparseable");

    // G.6 .claude.json merge keeps foo and other
    const claudeFile = path.join(h1, ".claude.json");
    const r6 = mergeConfigFile(claudeFile, entry);
    ok(r6.status === "updated", "clients G.6: .claude.json merged → updated", r6.status);
    const p6 = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
    ok(p6.foo === 1, "clients G.6: .claude.json keeps foo");
    ok(p6.mcpServers.other && p6.mcpServers.other.command === "x", "clients G.6: .claude.json keeps other");
    ok(p6.mcpServers.ftp && p6.mcpServers.ftp.command === "node", "clients G.6: .claude.json got ftp");

    // G.7 antigravity — create when only .gemini/ exists
    const ag1 = path.join(gTmp, "ag1");
    fs.mkdirSync(path.join(ag1, ".gemini"), { recursive: true });
    const agClient1 = getClients(mkctx(ag1)).find((c) => c.id === "antigravity");
    const agRes1 = applyClient(agClient1, entry);
    const agFile1 = path.join(ag1, ".gemini", "antigravity", "mcp_config.json");
    ok(agRes1.length === 1 && agRes1[0].status === "created", "clients G.7: antigravity created under antigravity/ when only .gemini/ exists", JSON.stringify(agRes1.map((r) => r.status)));
    ok(fs.existsSync(agFile1) && JSON.parse(fs.readFileSync(agFile1, "utf8")).mcpServers.ftp, "clients G.7: antigravity file has ftp");
    // both candidates pre-exist → both updated
    const ag2 = path.join(gTmp, "ag2");
    const f1 = path.join(ag2, ".gemini", "antigravity", "mcp_config.json");
    const f2 = path.join(ag2, ".gemini", "config", "mcp_config.json");
    fs.mkdirSync(path.dirname(f1), { recursive: true });
    fs.mkdirSync(path.dirname(f2), { recursive: true });
    fs.writeFileSync(f1, JSON.stringify({ mcpServers: {} }, null, 2));
    fs.writeFileSync(f2, JSON.stringify({ mcpServers: {} }, null, 2));
    const agClient2 = getClients(mkctx(ag2)).find((c) => c.id === "antigravity");
    const agRes2 = applyClient(agClient2, entry);
    ok(agRes2.length === 2, "clients G.7: antigravity targets both pre-existing files", String(agRes2.length));
    ok(
      JSON.parse(fs.readFileSync(f1, "utf8")).mcpServers.ftp && JSON.parse(fs.readFileSync(f2, "utf8")).mcpServers.ftp,
      "clients G.7: both antigravity files updated"
    );
  } finally {
    try {
      fs.rmSync(gTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ===== PART H: setup/doctor e2e (spawn) =====================================
async function partH() {
  const neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-cwd-"));
  const tmpH = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-h-"));
  const fixture = path.join(projectRoot, "test", "fixtures", "sitemanager.xml");
  const serversPath = path.join(tmpH, ".ftp-mcp", "servers.json");
  const setupArgs = ["setup", "--yes", "--from-filezilla", fixture, "--home", tmpH, "--clients", "all", "--skip-test"];
  try {
    // seed tmpH
    fs.mkdirSync(path.join(tmpH, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(tmpH, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));
    fs.mkdirSync(path.join(tmpH, ".codeium", "windsurf"), { recursive: true });
    fs.mkdirSync(path.join(tmpH, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(tmpH, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { existing: { command: "z" } } }, null, 2));

    // H.1 first setup
    const r1 = await runCli(setupArgs, { cwd: neutralCwd });
    ok(r1.code === 0, "setup H.1: exit 0", `code=${r1.code} err=${r1.stderr.slice(0, 300)}`);
    ok(fs.existsSync(serversPath), "setup H.1: servers.json created at default dest");
    const cfg = JSON.parse(fs.readFileSync(serversPath, "utf8"));
    ok(Object.keys(cfg.servers).length === 3, "setup H.1: 3 fixture servers imported", JSON.stringify(Object.keys(cfg.servers)));
    const cursorCfg = JSON.parse(fs.readFileSync(path.join(tmpH, ".cursor", "mcp.json"), "utf8"));
    ok(cursorCfg.mcpServers.other && cursorCfg.mcpServers.ftp, "setup H.1: cursor merged (other + ftp)");
    const cursorBackups1 = fs.readdirSync(path.join(tmpH, ".cursor")).filter((f) => f.includes(".backup-"));
    ok(cursorBackups1.length === 1, "setup H.1: exactly one cursor backup", String(cursorBackups1.length));
    ok(fs.existsSync(path.join(tmpH, ".codeium", "windsurf", "mcp_config.json")), "setup H.1: windsurf file created");
    ok(fs.existsSync(path.join(tmpH, ".gemini", "antigravity", "mcp_config.json")), "setup H.1: antigravity file created");
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(tmpH, ".claude.json"), "utf8"));
    ok(claudeCfg.numStartups === 3 && claudeCfg.mcpServers.existing && claudeCfg.mcpServers.ftp, "setup H.1: .claude.json merged, unrelated keys intact");
    contains(r1.stdout, "Trae", "setup H.1: stdout mentions Trae");
    contains(r1.stdout, '"mcpServers"', "setup H.1: stdout has the paste block");
    notContains(r1.stdout, "hunter2FTP", "setup H.1: stdout never leaks the fixture password");
    notContains(r1.stdout + r1.stderr, "implicit-Pass-1", "setup H.1: stdout/stderr redact every imported password");
    contains(r1.stdout, "SECURITY WARNING", "setup H.1: warns loudly about insecure imported servers");
    contains(r1.stdout, "allowInsecure", "setup H.1: names the explicit opt-in flag");
    ok(
      !("allowInsecure" in (cfg.servers[Object.keys(cfg.servers)[0]] || {})) &&
        Object.values(cfg.servers).every((s) => s.allowInsecure !== true),
      "setup H.1: non-interactive setup never auto-allows insecure servers (fail closed)"
    );

    // H.2 re-run idempotent
    const r2 = await runCli(setupArgs, { cwd: neutralCwd });
    ok(r2.code === 0, "setup H.2: re-run exit 0", `code=${r2.code}`);
    const cursorBackups2 = fs.readdirSync(path.join(tmpH, ".cursor")).filter((f) => f.includes(".backup-"));
    ok(cursorBackups2.length === 1, "setup H.2: no extra cursor backup on re-run", String(cursorBackups2.length));
    const cursorCfg2 = JSON.parse(fs.readFileSync(path.join(tmpH, ".cursor", "mcp.json"), "utf8"));
    ok(cursorCfg2.mcpServers.other && cursorCfg2.mcpServers.ftp, "setup H.2: cursor config unchanged (other + ftp)");

    // H.2b standalone import: stdout is the historical operational JSON
    // payload; diagnostics remain on stderr and never echo its credentials.
    const printed = await runCli(["import-filezilla", "--file", fixture], { cwd: neutralCwd });
    const printedConfig = JSON.parse(printed.stdout);
    ok(printed.code === 0 && printedConfig.servers["prod-staging"].password === "hunter2FTP", "import H.2b: stdout remains operational JSON with the exact password");
    notContains(printed.stderr, "hunter2FTP", "import H.2b: stderr does not echo the FTP password");
    notContains(printed.stderr, "implicit-Pass-1", "import H.2b: stderr does not echo the FTPS password");
    contains(printed.stderr, "plaintext passwords", "import H.2b: stderr clearly warns that stdout contains plaintext passwords");
    const importedOut = path.join(tmpH, "imported", "servers.json");
    const written = await runCli(["import-filezilla", "--file", fixture, "--out", importedOut], { cwd: neutralCwd });
    ok(written.code === 0 && fs.existsSync(importedOut), "import H.2b: --out creates the destination");
    contains(fs.readFileSync(importedOut, "utf8"), "hunter2FTP", "import H.2b: --out preserves operational credentials on disk");
    notContains(written.stdout + written.stderr, "hunter2FTP", "import H.2b: --out diagnostics remove credentials");
    ok(tempFilesFor(importedOut).length === 0, "import H.2b: --out leaves no temporary file");

    // H.3 no source → exit 2
    const freshH = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-h3-"));
    const r3 = await runCli(["setup", "--yes", "--home", freshH, "--skip-test"], { cwd: neutralCwd });
    ok(r3.code === 2, "setup H.3: no config source → exit 2", `code=${r3.code}`);
    try {
      fs.rmSync(freshH, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // H.4 dry-run writes nothing
    const freshH2 = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-h4-"));
    const r4 = await runCli(["setup", "--yes", "--from-filezilla", fixture, "--home", freshH2, "--clients", "all", "--skip-test", "--dry-run"], { cwd: neutralCwd });
    ok(r4.code === 0, "setup H.4: dry-run exit 0", `code=${r4.code}`);
    ok(fs.readdirSync(freshH2).length === 0, "setup H.4: dry-run created zero files under home", JSON.stringify(fs.readdirSync(freshH2)));
    try {
      fs.rmSync(freshH2, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    // H.5 doctor
    const d = await runCli(["doctor", "--home", tmpH], { cwd: neutralCwd });
    ok(d.code === 0, "doctor H.5: exit 0", `code=${d.code}`);
    contains(d.stdout, serversPath, "doctor H.5: names the config path");
    contains(d.stdout, "prod-staging", "doctor H.5: lists prod-staging");
    contains(d.stdout, "backup-sftp", "doctor H.5: lists backup-sftp");
    contains(d.stdout, "implicit-ftps", "doctor H.5: lists implicit-ftps");
    notContains(d.stdout, "hunter2FTP", "doctor H.5: never prints the fixture password");
    notContains(d.stdout + d.stderr, "implicit-Pass-1", "doctor H.5: stdout/stderr redact every configured password");
    contains(d.stdout, "INSECURE", "doctor H.5: flags the plain-FTP server as insecure");
    contains(d.stdout, "UNSAFE ROOT REFUSED", "doctor H.5: reports blocked FTP sub-root policy");
    contains(d.stdout, "HOST KEY REFUSED", "doctor H.5: reports blocked unpinned SFTP policy");
    contains(d.stdout, "Cursor", "doctor H.5: reports Cursor");
    contains(d.stdout, "Windsurf", "doctor H.5: reports Windsurf");
    contains(d.stdout, "Antigravity", "doctor H.5: reports Antigravity");
    contains(d.stdout, "configured", "doctor H.5: marks clients configured");
    contains(d.stdout, "manual (UI)", "doctor H.5: Trae marked manual");

    const invalidConfig = JSON.parse(fs.readFileSync(serversPath, "utf8"));
    invalidConfig.servers["backup-sftp"].hostKeySha256 = "not-a-valid-pin";
    fs.writeFileSync(serversPath, JSON.stringify(invalidConfig, null, 2) + "\n");
    const dInvalid = await runCli(["doctor", "--home", tmpH], { cwd: neutralCwd });
    contains(dInvalid.stdout, "HOST KEY INVALID", "doctor H.5: distinguishes a present but invalid SFTP host-key pin");
    notContains(dInvalid.stdout + dInvalid.stderr, "implicit-Pass-1", "doctor H.5: invalid-pin diagnostics still redact passwords");

    const overrideConfig = invalidConfig;
    delete overrideConfig.servers["backup-sftp"].hostKeySha256;
    overrideConfig.servers["prod-staging"].allowUnsafeRemoteRoot = true;
    overrideConfig.servers["backup-sftp"].allowUnknownHostKey = true;
    fs.writeFileSync(serversPath, JSON.stringify(overrideConfig, null, 2) + "\n");
    const dOverride = await runCli(["doctor", "--home", tmpH], { cwd: neutralCwd });
    contains(dOverride.stdout, "UNSAFE ROOT explicit override", "doctor H.5: distinguishes FTP sub-root explicit override");
    contains(dOverride.stdout, "HOST KEY explicit override", "doctor H.5: distinguishes SFTP host-key explicit override");
    notContains(dOverride.stdout + dOverride.stderr, "hunter2FTP", "doctor H.5: override diagnostics still redact passwords");
  } finally {
    try {
      fs.rmSync(neutralCwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpH, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  // ===== PART A: jail math (no network) =====
  ok(resolveRemote("/var/www", "dist/app.js") === "/var/www/dist/app.js", "jail: relative path joins under root");
  ok(resolveRemote("/var/www", "/x") === "/var/www/x", "jail: leading slash is root-relative");
  throws(() => resolveRemote("/var/www", ".."), "jail: .. escape throws");
  throws(() => resolveRemote("/var/www", "../../etc"), "jail: ../../etc escape throws");
  throws(() => resolveRemote("/", "../.."), "jail: .. escapes even at filesystem root");
  throws(() => resolveRemote("/var/www", "a/../../x"), "jail: mid-path .. climb-out throws");
  ok(resolveRemote("/var/www", "sub/..") === "/var/www", "jail: sub/.. resolves back to root");
  ok(resolveRemote("/", "a/../b") === "/b", "jail: normalizes . and .. inside root");
  ok(resolveRemote("/var/www", "") === "/var/www", "jail: empty path is the root");
  ok(resolveRemote("/var/www", "/") === "/var/www", "jail: slash is the root");
  ok(resolveRemote("/var/www", ".") === "/var/www", "jail: dot is the root");
  ok(isRootPath("/var/www", "") === true, "jail: isRootPath true for root");
  ok(isRootPath("/var/www", "sub") === false, "jail: isRootPath false for subpath");
  ok(normalizeRoot("/var/www/") === "/var/www", "jail: normalizeRoot strips trailing slash");

  // ===== PART A: FileZilla import =====
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "sitemanager.xml"), "utf8");
  const parsed = parseSiteManager(fixture);
  const keys = Object.keys(parsed.servers);
  ok(keys.length === 3, "filezilla: parsed 3 servers", JSON.stringify(keys));
  const ftpSite = parsed.servers[keys[0]];
  const sftpSite = parsed.servers[keys[1]];
  const implicitSite = parsed.servers[keys[2]];
  ok(ftpSite.host === "ftp.example.com", "filezilla: ftp host parsed", ftpSite.host);
  ok(ftpSite.protocol === "ftp", "filezilla: ftp protocol mapped", ftpSite.protocol);
  ok(ftpSite.password === "hunter2FTP", "filezilla: base64 password decoded", ftpSite.password);
  ok(ftpSite.root === "/site/sub", "filezilla: RemoteDir decoded", ftpSite.root);
  ok(sftpSite.protocol === "sftp", "filezilla: sftp protocol mapped", sftpSite.protocol);
  ok(
    typeof sftpSite.password === "string" && sftpSite.password.startsWith("${ENV:"),
    "filezilla: missing password becomes env placeholder",
    sftpSite.password
  );
  ok(implicitSite.host === "implicit.example.com", "filezilla: implicit ftps host parsed", implicitSite.host);
  ok(implicitSite.protocol === "ftps", "filezilla: implicit ftps protocol mapped", implicitSite.protocol);
  ok(implicitSite.implicitTLS === true, "filezilla: implicit ftps sets implicitTLS", implicitSite.implicitTLS);
  ok(implicitSite.port === 990, "filezilla: implicit ftps port parsed", implicitSite.port);
  ok(
    implicitSite.password === "implicit-Pass-1",
    "filezilla: implicit ftps base64 password decoded",
    implicitSite.password
  );
  ok(decodeRemoteDir("1 0 4 site 3 sub") === "/site/sub", "filezilla: decodeRemoteDir pairs");
  ok(decodeRemoteDir("") === "", "filezilla: empty RemoteDir omitted");
  partAtomicWriter();

  // ===== temp layout =====
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ftpmcp-"));
  const ftpRoot = path.join(baseDir, "ftp");
  const sftpRoot = path.join(baseDir, "sftp");
  const sampleDir = path.join(baseDir, "sample");
  const workDir = path.join(baseDir, "work");
  fs.mkdirSync(ftpRoot, { recursive: true });
  fs.mkdirSync(path.join(sftpRoot, "jail"), { recursive: true });
  fs.mkdirSync(path.join(ftpRoot, "subroot"), { recursive: true });
  fs.mkdirSync(path.join(sftpRoot, "jail", "safe-target", "nested"), { recursive: true });
  fs.mkdirSync(path.join(sftpRoot, "outside-jail", "nested"), { recursive: true });
  fs.symlinkSync(path.join(sftpRoot, "jail"), path.join(sftpRoot, "root-link"), "junction");
  fs.symlinkSync(
    path.join(sftpRoot, "jail", "safe-target"),
    path.join(sftpRoot, "jail", "link-inside"),
    "junction"
  );
  fs.symlinkSync(
    path.join(sftpRoot, "outside-jail"),
    path.join(sftpRoot, "jail", "link-outside"),
    "junction"
  );
  fs.mkdirSync(workDir, { recursive: true });
  await partRedaction(path.join(baseDir, "redaction-root"));
  // sample project for deploy
  fs.mkdirSync(path.join(sampleDir, "css"), { recursive: true });
  fs.mkdirSync(path.join(sampleDir, "js"), { recursive: true });
  fs.mkdirSync(path.join(sampleDir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(sampleDir, "index.html"), "<html>index</html>");
  fs.writeFileSync(path.join(sampleDir, "css", "style.css"), "body{color:red}");
  fs.writeFileSync(path.join(sampleDir, "js", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(sampleDir, "node_modules", "x", "y.js"), "module.exports=1");
  fs.writeFileSync(path.join(sampleDir, ".env"), "SECRET=nope");
  fs.writeFileSync(path.join(sampleDir, "debug.log"), "log line");
  // nested excluded files — must be excluded at ANY depth, not just top level
  fs.mkdirSync(path.join(sampleDir, "apps", "api"), { recursive: true });
  fs.mkdirSync(path.join(sampleDir, "sub"), { recursive: true });
  fs.mkdirSync(path.join(sampleDir, "packages", "x", "node_modules", "y"), { recursive: true });
  fs.mkdirSync(path.join(sampleDir, "vendor", ".git"), { recursive: true });
  fs.writeFileSync(path.join(sampleDir, "apps", "api", ".env"), "NESTED_SECRET=nope");
  fs.writeFileSync(path.join(sampleDir, "sub", "debug.log"), "nested log line");
  fs.writeFileSync(path.join(sampleDir, "packages", "x", "node_modules", "y", "z.js"), "module.exports=2");
  fs.writeFileSync(path.join(sampleDir, "vendor", ".git", "config"), "[core]\n\trepositoryformatversion = 0");

  // ===== PART A.2: config loading is resilient (never throws) =====
  const cfgPath = (name, obj) => {
    const p = path.join(baseDir, name);
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return p;
  };
  const bad = loadConfig(cfgPath("bad.json", "{ not valid json "));
  ok(bad.found && bad.config === null && /JSON/i.test(bad.error || ""), "config: parse error captured, no throw", bad.error);
  const noAuth = loadConfig(cfgPath("noauth.json", { servers: { x: { protocol: "ftp", host: "h", user: "u" } } }));
  ok(noAuth.error && noAuth.error.includes("authentication"), "config: missing auth rejected with server name", noAuth.error);
  const badProto = loadConfig(cfgPath("badproto.json", { servers: { x: { protocol: "gopher", host: "h", user: "u", password: "p" } } }));
  ok(badProto.error && badProto.error.includes("protocol"), "config: unknown protocol rejected", badProto.error);
  process.env.__FTPMCP_TEST_PW = "envpw-value";
  const envCfg = loadConfig(cfgPath("env.json", { servers: { e: { protocol: "ftp", host: "h", user: "u", password: "${ENV:__FTPMCP_TEST_PW}" } } }));
  ok(envCfg.config && envCfg.config.servers.e.password === "envpw-value", "config: ${ENV:...} substitution resolves", envCfg.error);
  const envMissing = loadConfig(cfgPath("envmiss.json", { servers: { e: { protocol: "ftp", host: "h", user: "u", password: "${ENV:__FTPMCP_UNSET__}" } } }));
  ok(envMissing.error && envMissing.error.includes("__FTPMCP_UNSET__"), "config: unset env var reported by name", envMissing.error);
  const badBool = loadConfig(cfgPath("badbool.json", { servers: { x: { protocol: "ftps", host: "h", user: "u", password: "p", insecureTLS: "true" } } }));
  ok(badBool.error && badBool.error.includes("insecureTLS"), "config: non-boolean insecureTLS rejected", badBool.error);
  const badAllow = loadConfig(cfgPath("badallow.json", { servers: { x: { protocol: "ftp", host: "h", user: "u", password: "p", allowInsecure: "yes" } } }));
  ok(badAllow.error && badAllow.error.includes("allowInsecure"), "config: non-boolean allowInsecure rejected", badAllow.error);
  const validTestPin = `SHA256:${Buffer.alloc(32, 7).toString("base64").replace(/=+$/, "")}`;
  const badPin = loadConfig(cfgPath("badpin.json", { servers: { x: { protocol: "sftp", host: "h", user: "u", password: "p", hostKeySha256: "SHA256:not-base64" } } }));
  ok(badPin.error && badPin.error.includes("hostKeySha256"), "config: malformed SFTP host-key pin rejected", badPin.error);
  const emptyPins = loadConfig(cfgPath("emptypins.json", { servers: { x: { protocol: "sftp", host: "h", user: "u", password: "p", hostKeySha256: [] } } }));
  ok(emptyPins.error && emptyPins.error.includes("non-empty"), "config: empty SFTP host-key pin array rejected", emptyPins.error);
  const pinAndBypass = loadConfig(cfgPath("pin-bypass.json", { servers: { x: { protocol: "sftp", host: "h", user: "u", password: "p", hostKeySha256: validTestPin, allowUnknownHostKey: true } } }));
  ok(pinAndBypass.error && pinAndBypass.error.includes("cannot be used together"), "config: host pin and unknown-host bypass are incompatible", pinAndBypass.error);
  const badUnknownType = loadConfig(cfgPath("bad-unknown-type.json", { servers: { x: { protocol: "sftp", host: "h", user: "u", password: "p", allowUnknownHostKey: "yes" } } }));
  ok(badUnknownType.error && badUnknownType.error.includes("allowUnknownHostKey"), "config: non-boolean allowUnknownHostKey rejected", badUnknownType.error);
  const badUnsafeType = loadConfig(cfgPath("bad-unsafe-type.json", { servers: { x: { protocol: "ftp", host: "h", user: "u", password: "p", allowUnsafeRemoteRoot: 1 } } }));
  ok(badUnsafeType.error && badUnsafeType.error.includes("allowUnsafeRemoteRoot"), "config: non-boolean allowUnsafeRemoteRoot rejected", badUnsafeType.error);
  const isolatedBadServer = loadConfig(cfgPath("isolated-bad-server.json", {
    servers: {
      good: { protocol: "ftp", host: "h", user: "u", password: "p", root: "/", allowInsecure: true },
      bad: { protocol: "sftp", host: "h", user: "u", password: "p", hostKeySha256: "bad" },
    },
  }));
  ok(
    isolatedBadServer.config && isolatedBadServer.serverNames.includes("good") && isolatedBadServer.serverErrors.bad,
    "config: invalid server is isolated while valid peer remains usable",
    isolatedBadServer.error
  );
  ok(resolveServer(isolatedBadServer, "good").name === "good", "config: valid peer resolves despite invalid server");
  throws(() => resolveServer(isolatedBadServer, "bad"), "config: selecting invalid server returns its own validation error");
  // Case-variant protocols must not slip past the insecure gate (setup/doctor
  // feed raw JSON.parse'd entries straight into normalizeServer).
  const upNorm = normalizeServer("x", { protocol: "FTP", host: "h", user: "u", password: "p" });
  ok(upNorm.protocol === "ftp", "config: normalizeServer canonicalizes protocol case", upNorm.protocol);
  ok(insecureTransport(upNorm) === "plain-ftp", "config: case-variant FTP still hits the insecure gate", String(insecureTransport(upNorm)));
  const upTls = normalizeServer("x", { protocol: " FTPS ", host: "h", user: "u", password: "p", insecureTLS: true });
  ok(insecureTransport(upTls) === "unverified-tls", "config: case-variant FTPS+insecureTLS still hits the insecure gate", String(insecureTransport(upTls)));
  const homeRoot = normalizeServer("x", { protocol: "sftp", host: "h", user: "u", password: "p", localRoot: "~/site" });
  ok(path.isAbsolute(homeRoot.localRoot) && homeRoot.localRoot === path.join(os.homedir(), "site"), "config: localRoot expands a leading tilde", homeRoot.localRoot);

  await runToolsSecurityTests({
    root: path.join(baseDir, "tools-security"),
    ok,
    contains,
    notContains,
  });
  await runMcpContractTests({
    root: path.join(baseDir, "mcp-contract"),
    ok,
    contains,
    notContains,
  });

  // ===== PART B: FTP server =====
  const ftpPort = await getFreePort();
  ftpServer = new FtpSrv({
    url: `ftp://127.0.0.1:${ftpPort}`,
    pasv_url: "127.0.0.1",
    anonymous: false,
  });
  ftpServer.on("login", (data, resolve, reject) => {
    if (data.username === TEST_USER && data.password === TEST_PASS) resolve({ root: ftpRoot });
    else reject(new Error("invalid credentials"));
  });
  ftpServer.on("error", () => {});
  await ftpServer.listen();
  console.log(`PASS: local FTP server listening on ${ftpPort}`);
  passCount++;

  // ===== PART C: SFTP server =====
  sftpServer = await startSftpServer({ root: sftpRoot, user: TEST_USER, password: TEST_PASS });
  const sftpPort = sftpServer.port;
  const wrongSftpPin = `SHA256:${Buffer.alloc(32, 0).toString("base64").replace(/=+$/, "")}`;
  console.log(`PASS: local SFTP server listening on ${sftpPort}`);
  passCount++;

  // ===== PART D: config + spawn MCP server =====
  const configPath = path.join(baseDir, "ftp-servers.json");
  const config = {
    servers: {
      localftp: { protocol: "ftp", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/", allowInsecure: true },
      localsftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail", hostKeySha256: sftpServer.hostKeySha256 },
      rotationsftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail", hostKeySha256: [wrongSftpPin, sftpServer.hostKeySha256] },
      wrongpinsftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail", hostKeySha256: wrongSftpPin },
      unpinnedsftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail" },
      unknownkeysftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail", allowUnknownHostKey: true },
      rootlinksftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/root-link", hostKeySha256: sftpServer.hostKeySha256 },
      ro: { protocol: "ftp", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/", readOnly: true, allowInsecure: true },
      unsafeftp: { protocol: "ftp", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/subroot", allowInsecure: true },
      allowedunsafeftp: { protocol: "ftp", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/subroot", allowInsecure: true, allowUnsafeRemoteRoot: true },
      // Insecure transports WITHOUT the explicit "allowInsecure" opt-in: any
      // connection attempt must be refused before touching the network.
      blockedftp: { protocol: "ftp", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/" },
      blockedtls: { protocol: "ftps", host: "127.0.0.1", port: ftpPort, user: TEST_USER, password: TEST_PASS, root: "/", insecureTLS: true },
      invalidconfigsftp: { protocol: "sftp", host: "127.0.0.1", port: sftpPort, user: TEST_USER, password: TEST_PASS, root: "/jail", hostKeySha256: "invalid" },
    },
  };
  for (const entry of Object.values(config.servers)) entry.localRoot = baseDir;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  child = spawn(process.execPath, ["src/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, FTP_MCP_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = makeMcpClient(child);

  const initRes = await client.send(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } },
    20000
  );
  ok(initRes.result && initRes.result.serverInfo, "initialize handshake succeeded", JSON.stringify(initRes).slice(0, 300));
  client.notify("notifications/initialized", {});

  const listRes = await client.send("tools/list", {}, 15000);
  const tools = (listRes.result && listRes.result.tools) || [];
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "ftp_delete", "ftp_deploy", "ftp_download", "ftp_list", "ftp_list_servers",
    "ftp_mkdir", "ftp_read", "ftp_rename", "ftp_test", "ftp_upload",
  ];
  ok(names.length === 10 && JSON.stringify(names) === JSON.stringify(expected), "tools/list returns exactly the 10 tools", JSON.stringify(names));
  ok(tools.every((t) => t.inputSchema && t.inputSchema.type === "object"), "every tool has an object inputSchema");
  const deployTool = tools.find((t) => t.name === "ftp_deploy");
  ok(
    deployTool && deployTool.inputSchema.properties && deployTool.inputSchema.properties.local_dir,
    "ftp_deploy schema exposes local_dir property"
  );

  // ===== PART E: scenario twice =====
  await runScenario(client, "localftp", "ftp", sampleDir, workDir, null);
  await runScenario(
    client,
    "localsftp",
    "sftp",
    sampleDir,
    workDir,
    path.join(sftpRoot, "jail", "deploy", "index.html")
  );

  // ===== PART F: read-only + list-servers + bad server =====
  let r = await client.callTool("ftp_upload", { server: "ro", local_path: path.join(sampleDir, "index.html") });
  ok(r.isError && r.text.includes("read-only"), "read-only server blocks upload", r.text);
  r = await client.callTool("ftp_list", { server: "ro" });
  ok(!r.isError, "read-only server still allows list", r.text);

  r = await client.callTool("ftp_deploy", { server: "ro", local_dir: sampleDir, dry_run: true });
  ok(!r.isError, "read-only server allows deploy dry_run", r.text);
  contains(r.text, "read-only", "read-only server dry_run mentions read-only");
  r = await client.callTool("ftp_deploy", { server: "ro", local_dir: sampleDir });
  ok(r.isError, "read-only server still refuses a real deploy", r.text);

  r = await client.callTool("ftp_list_servers", {});
  contains(r.text, "localftp", "list_servers lists localftp");
  contains(r.text, "localsftp", "list_servers lists localsftp");
  contains(r.text, "ro", "list_servers lists ro");
  contains(r.text, "read-only", "list_servers marks ro read-only");
  notContains(r.text, TEST_PASS, "list_servers never shows the password");

  r = await client.callTool("ftp_test", { server: "does-not-exist" });
  ok(r.isError && r.text.includes("does-not-exist") && r.text.includes("localftp"), "bad server name lists available servers", r.text);

  // ===== PART F2: insecure-transport policy =====
  r = await client.callTool("ftp_test", { server: "blockedftp" });
  ok(
    r.isError && r.text.includes("INSECURE CONNECTION REFUSED") && r.text.includes("allowInsecure"),
    "plain FTP without allowInsecure is refused with an explicit-consent message",
    r.text
  );
  r = await client.callTool("ftp_test", { server: "blockedtls" });
  ok(
    r.isError && r.text.includes("INSECURE CONNECTION REFUSED") && r.text.includes("insecureTLS"),
    "unverified FTPS without allowInsecure is refused before any network I/O",
    r.text
  );
  r = await client.callTool("ftp_deploy", { server: "blockedftp", local_dir: sampleDir });
  ok(r.isError && r.text.includes("INSECURE CONNECTION REFUSED"), "deploy to a blocked insecure server is refused", r.text);
  r = await client.callTool("ftp_deploy", { server: "blockedftp", local_dir: sampleDir, dry_run: true });
  ok(!r.isError && r.text.includes("REFUSED"), "dry_run on a blocked insecure server warns the real deploy will be refused", r.text);
  r = await client.callTool("ftp_read", { server: "localftp", path: "no/such/file.txt" });
  ok(r.isError && r.text.includes("SECURITY WARNING"), "error results on an allowed-insecure server still carry the warning", r.text);
  r = await client.callTool("ftp_test", { server: "localftp" });
  contains(r.text, "SECURITY WARNING", "allowed plain FTP appends a visible security warning");
  contains(r.text, "allowInsecure", "the warning names the opt-in flag");
  r = await client.callTool("ftp_test", { server: "localsftp" });
  notContains(r.text, "SECURITY WARNING", "sftp output carries no security warning");
  r = await client.callTool("ftp_list_servers", {});
  contains(r.text, "INSECURE", "list_servers flags insecure servers");
  contains(r.text, "REFUSED", "list_servers says blocked insecure servers are refused");
  contains(r.text, "explicitly allowed", "list_servers distinguishes explicitly-allowed insecure servers");

  // ===== PART F3: SFTP host identity + canonical no-symlink jail =====
  r = await client.callTool("ftp_test", { server: "rotationsftp" });
  ok(!r.isError, "SFTP host-key rotation accepts any configured matching pin", r.text);

  let authBefore = sftpServer.getStats().authenticationAttempts;
  r = await client.callTool("ftp_test", { server: "wrongpinsftp" });
  ok(r.isError && r.text.includes("host key verification failed"), "SFTP mismatched host-key pin is refused", r.text);
  ok(
    sftpServer.getStats().authenticationAttempts === authBefore,
    "SFTP mismatched host-key pin is rejected before authentication"
  );

  authBefore = sftpServer.getStats().authenticationAttempts;
  r = await client.callTool("ftp_test", { server: "unpinnedsftp" });
  ok(
    r.isError && r.text.includes("HOST KEY VERIFICATION REQUIRED") && r.text.includes("hostKeySha256"),
    "SFTP without a host-key pin is refused with migration guidance",
    r.text
  );
  ok(
    sftpServer.getStats().authenticationAttempts === authBefore,
    "SFTP missing host-key pin is rejected before network authentication"
  );

  r = await client.callTool("ftp_test", { server: "unknownkeysftp" });
  ok(!r.isError && r.text.includes("allowUnknownHostKey"), "SFTP unknown-host-key override is visible on success", r.text);
  r = await client.callTool("ftp_read", { server: "unknownkeysftp", path: "missing.txt" });
  ok(r.isError && r.text.includes("allowUnknownHostKey"), "SFTP unknown-host-key override is visible on error", r.text);

  r = await client.callTool("ftp_test", { server: "rootlinksftp" });
  ok(r.isError && r.text.includes("symbolic link"), "SFTP configured root symlink is refused", r.text);
  r = await client.callTool("ftp_list", { server: "localsftp", path: "link-outside/nested" });
  ok(r.isError && r.text.includes("symbolic link"), "SFTP internal symlink escaping the root is refused", r.text);
  r = await client.callTool("ftp_list", { server: "localsftp", path: "link-inside/nested" });
  ok(r.isError && r.text.includes("symbolic link"), "SFTP internal symlink staying inside the root is still refused", r.text);
  r = await client.callTool("ftp_list", { server: "localsftp", path: "link-inside" });
  ok(r.isError && r.text.includes("symbolic link"), "SFTP final symlink component is refused", r.text);

  r = await client.callTool("ftp_test", { server: "invalidconfigsftp" });
  ok(r.isError && r.text.includes("hostKeySha256"), "invalid SFTP config is reported only for the selected server", r.text);
  r = await client.callTool("ftp_test", { server: "localsftp" });
  ok(!r.isError, "valid SFTP peer remains usable beside invalid server config", r.text);

  // ===== PART F4: FTP sub-root risk acceptance =====
  r = await client.callTool("ftp_test", { server: "unsafeftp" });
  ok(
    r.isError && r.text.includes("UNSAFE REMOTE ROOT REFUSED") && r.text.includes("allowUnsafeRemoteRoot"),
    "FTP client-side sub-root is refused by default",
    r.text
  );
  r = await client.callTool("ftp_deploy", { server: "unsafeftp", local_dir: sampleDir, dry_run: true });
  ok(
    !r.isError && r.text.includes("REFUSED") && r.text.includes("No connection was made") && r.text.includes("allowUnsafeRemoteRoot"),
    "FTP sub-root dry-run performs no network I/O and warns that a real deploy is refused",
    r.text
  );
  r = await client.callTool("ftp_test", { server: "allowedunsafeftp" });
  ok(!r.isError && r.text.includes("allowUnsafeRemoteRoot"), "FTP sub-root override is visible on success", r.text);
  r = await client.callTool("ftp_read", { server: "allowedunsafeftp", path: "missing.txt" });
  ok(r.isError && r.text.includes("allowUnsafeRemoteRoot"), "FTP sub-root override is visible on error", r.text);
  r = await client.callTool("ftp_deploy", { server: "allowedunsafeftp", local_dir: sampleDir, dry_run: true });
  ok(!r.isError && r.text.includes("allowUnsafeRemoteRoot"), "FTP sub-root override is visible on dry-run", r.text);
  r = await client.callTool("ftp_list_servers", {});
  contains(r.text, "allowUnsafeRemoteRoot", "list_servers exposes FTP sub-root refusal and override");
  contains(r.text, "allowUnknownHostKey", "list_servers exposes SFTP unknown-host-key override");

  // ===== global checks =====
  const leaked = allToolTexts.some((t) => t.includes(TEST_PASS));
  ok(!leaked, "no tool output ever contained the test password");
  ok(client.nonJson.length === 0, "server stdout carried only JSON-RPC (no stray lines)", client.nonJson.join(" | "));
  ok(!client.stderr.join("").includes(TEST_PASS), "server stderr never contained the configured password");

  // ===== PART G: clients.js unit ===== / ===== PART H: setup+doctor e2e =====
  partG();
  await partH();

  return client;
}

// ---- run + cleanup --------------------------------------------------------
let client = null;
try {
  client = await main();
} catch (err) {
  failCount++;
  console.log(`FAIL: uncaught error — ${err && err.stack ? err.stack : err}`);
} finally {
  clearTimeout(watchdog);
  try {
    if (child) {
      child.stdin.end();
      child.kill();
    }
  } catch {
    /* ignore */
  }
  try {
    if (ftpServer) await ftpServer.close();
  } catch {
    /* ignore */
  }
  try {
    if (sftpServer) await sftpServer.close();
  } catch {
    /* ignore */
  }
  try {
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log("");
  console.log(`SUMMARY: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log("");
    console.log("--- failure details ---");
    for (const d of failDetails) console.log(d);
    if (client && client.stderr && client.stderr.length) {
      console.log("");
      console.log("--- MCP server stderr ---");
      process.stdout.write(client.stderr.join(""));
    }
  }
  process.exit(failCount > 0 ? 1 : 0);
}
