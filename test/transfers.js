import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { registerTools } from "../src/tools.js";
import { loadConfig, normalizeServer } from "../src/config.js";
import { connect as connectSftp } from "../src/adapters/sftp.js";
import { startSftpServer } from "./sftp-server.js";
import { checkTransferSize, cleanupVerifiedStage, hashLocalFile, hashRemoteStream, promoteVerifiedStage,
  receiveLocalStream, sendLocalStream, stageVerifiedSource, uploadVerified } from "../src/transfers.js";

const digest = (buffer) => ({ sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length });
const temporaryName = /^\.ftp-mcp-[a-f0-9]{32}\.tmp$/;
const SECRET = "staging-test-secret";
const PIN = `SHA256:${Buffer.alloc(32, 19).toString("base64").replace(/=+$/, "")}`;

// Store actual source bytes and promote only those stored temporary bytes.
// Hooks retain existing tests' failure/delay instrumentation without replacing
// the virtual transfer or its independently computed digest.
export function virtualTransferAdapter(hooks = {}, files = new Map()) {
  const read = (remote) => {
    if (files.has(remote)) return files.get(remote);
    if (temporaryName.test(path.posix.basename(remote))) throw new Error("temporary file does not exist");
    return Buffer.from("downloaded");
  };
  return {
    files,
    async list() { return []; },
    async stat(remote) { return { type: "file", size: read(remote).length }; },
    async mkdirp() {},
    async readFile() { return { buffer: Buffer.from("ok"), truncated: false }; },
    async close() {},
    ...hooks,
    async uploadFile(local, remote, maxBytes, options = {}) {
      if (options.staged) {
        if (files.has(remote)) throw new Error("temporary file already exists");
        files.set(remote, Buffer.alloc(0));
        options.onOwned?.();
      }
      await hooks.uploadFile?.(local, remote, maxBytes);
      const bytes = fs.readFileSync(local);
      if (maxBytes !== undefined) checkTransferSize(bytes.length, maxBytes);
      files.set(remote, bytes);
    },
    async hashFile(remote, maxBytes) {
      if (hooks.hashFile) return hooks.hashFile(remote, maxBytes);
      const bytes = read(remote);
      checkTransferSize(bytes.length, maxBytes);
      return digest(bytes);
    },
    async downloadFile(remote, local, maxBytes) {
      if (hooks.downloadFile) return hooks.downloadFile(remote, local, maxBytes);
      const bytes = read(remote);
      checkTransferSize(bytes.length, maxBytes);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, bytes);
    },
    async rename(from, to) {
      await hooks.rename?.(from, to);
      files.set(to, read(from));
      files.delete(from);
    },
    async deleteFile(remote) {
      await hooks.deleteFile?.(remote);
      files.delete(remote);
    },
    async deleteDir(remote) { await hooks.deleteDir?.(remote); },
  };
}

function loaded(root, extra = {}) {
  return {
    found: true, error: null, serverNames: ["test"], invalidServerNames: [], serverErrors: {}, defaultServer: "test",
    config: { servers: { test: {
      protocol: "sftp", host: "staging.invalid", user: "test", password: SECRET,
      root: "/", localRoot: root, hostKeySha256: PIN, ...extra,
    } } },
  };
}
function capture(config, openAdapter) {
  const registry = registerTools(null, config, { openAdapter });
  return (name, args, extra = {}) => registry.call(name, args, extra);
}
function resultText(result) { return result.content.map((item) => item.text || "").join("\n"); }

async function durableSeamTests(root, ok) {
  const source = path.join(root, "durable-source.txt");
  const payload = Buffer.from("durable-stage-bytes");
  fs.writeFileSync(source, payload);
  const expected = digest(payload);
  const files = new Map([
    ["/ready/directory", { type: "dir" }],
    ["/ready/link", { type: "link" }],
  ]);
  let creates = 0, owns = 0, uploads = 0, removals = 0, renames = 0, lostAck = false;
  const identity = (remote, record) => Object.freeze({ canonicalRoot: record.root ?? "/", path: remote,
    parent: path.posix.dirname(remote), bytes: record.bytes.length, sha256: digest(record.bytes).sha256, mode: record.mode });
  const adapter = {
    async uploadStream(readable, remote, wanted, options) {
      ok(options.staged === true && options.createParents === false,
        "transfers: durable staging requests staged upload without creating parents");
      if (path.posix.dirname(remote) !== "/ready") throw new Error("missing parent");
      options.onCreating(); creates++;
      if (files.has(remote)) throw new Error("collision");
      const record = { type: "file", bytes: Buffer.alloc(0), mode: 0o600 };
      files.set(remote, record);
      const owned = Object.freeze({ canonicalRoot: "/", path: remote, parent: path.posix.dirname(remote) });
      options.onOwned(owned); owns++;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      record.bytes = Buffer.concat(chunks); uploads++;
      checkTransferSize(record.bytes.length, wanted.bytes);
      return { mode: 0o644 };
    },
    async inspectFile(remote, { maxBytes }) {
      const record = files.get(remote);
      if (!record) return { type: "absent", path: remote, parent: path.posix.dirname(remote), canonicalRoot: "/" };
      if (record.type !== "file") throw new Error(`refused ${record.type}`);
      checkTransferSize(record.bytes.length, maxBytes);
      const actual = digest(record.bytes);
      const current = identity(remote, record);
      return { type: "file", path: remote, parent: path.posix.dirname(remote), canonicalRoot: record.root ?? "/",
        bytes: actual.bytes, sha256: actual.sha256, mode: record.mode, identity: current };
    },
    async downloadStream(remote, writable, maxBytes, options = {}) {
      const observed = await this.inspectFile(remote, { maxBytes });
      if (options.identity?.sha256 !== undefined && options.identity.sha256 !== observed.sha256) throw new Error("identity changed");
      await pipeline(Readable.from([files.get(remote).bytes]), writable);
      return { bytes: observed.bytes };
    },
    async rename(from, to, options) {
      ok(options.createParents === false && options.staged === true,
        "transfers: durable promotion never creates parents");
      renames++;
      const record = files.get(from);
      if (options.mode !== undefined) record.mode = options.mode;
      files.set(to, record); files.delete(from);
      if (lostAck) throw new Error("rename acknowledgement lost");
    },
    async deleteFile(remote) { removals++; files.delete(remote); },
  };
  const operation = { check() {}, async promote(_bytes, run) { return run(); }, confirmFile() {} };
  const tokenA = "a".repeat(32), tokenB = "b".repeat(32);
  const temporaryA = `/ready/.ftp-mcp-${tokenA}.tmp`;
  const staged = await stageVerifiedSource({ adapter, source, temporary: temporaryA, expected, operation });
  ok(staged.bytes === expected.bytes && staged.sha256 === expected.sha256 && staged.mode === 0o644 &&
    creates === 1 && owns === 1 && uploads === 1,
  "transfers: durable stage returns the verified observation and promotion mode");
  const downloaded = [];
  await adapter.downloadStream(temporaryA, new Writable({ write(chunk, _encoding, callback) { downloaded.push(chunk); callback(); } }),
    expected.bytes, { identity: staged.identity });
  ok(Buffer.concat(downloaded).equals(payload), "transfers: durable downloadStream preserves verified bytes and identity");
  lostAck = true;
  const promoted = await promoteVerifiedStage({ adapter, temporary: temporaryA, target: "/ready/final.txt",
    mode: staged.mode, identity: staged, operation });
  ok(promoted.bytes === payload.length && files.get("/ready/final.txt").bytes.equals(payload) && !files.has(temporaryA),
    "transfers: lost promotion acknowledgement is recovered only from the observed postcondition");
  lostAck = false;
  const temporaryB = `/ready/.ftp-mcp-${tokenB}.tmp`;
  const stagedForCleanup = await stageVerifiedSource({ adapter, source, temporary: temporaryB, expected, operation });
  const cleaned = await cleanupVerifiedStage({ adapter, temporary: temporaryB, expected, identity: stagedForCleanup, operation });
  ok(cleaned.removed === true && removals === 1 && !files.has(temporaryB),
    "transfers: durable cleanup removes only the reverified owned stage");

  const substitutions = [
    { token: "d", mutate(record) { record.bytes = Buffer.alloc(payload.length, 0x78); }, label: "same-length digest" },
    { token: "e", mutate(record) { record.mode = 0o601; }, label: "mode identity" },
    { token: "f", mutate(record) { record.root = "/other"; }, label: "root identity" },
  ];
  for (const { token, mutate, label } of substitutions) {
    const temporary = `/ready/.ftp-mcp-${token.repeat(32)}.tmp`;
    const stage = await stageVerifiedSource({ adapter, source, temporary, expected, operation });
    const target = `/ready/${token}-target.txt`;
    const preserved = { type: "file", bytes: Buffer.from("preserved"), mode: 0o644 };
    files.set(target, preserved);
    mutate(files.get(temporary));
    const beforeRenames = renames;
    const failure = await promoteVerifiedStage({ adapter, temporary, target, mode: stage.mode,
      identity: stage, operation }).catch((error) => error);
    ok(failure instanceof Error && renames === beforeRenames && files.get(target) === preserved,
      `transfers: durable ${label} drift rejects before rename and preserves the target`);
    files.delete(temporary); files.delete(target);
  }

  const cleanupTemporary = `/ready/.ftp-mcp-${"7".repeat(32)}.tmp`;
  const cleanupStage = await stageVerifiedSource({ adapter, source, temporary: cleanupTemporary, expected, operation });
  files.get(cleanupTemporary).bytes = Buffer.alloc(payload.length, 0x79);
  const cleanupRemovals = removals;
  const cleanupFailure = await cleanupVerifiedStage({ adapter, temporary: cleanupTemporary, expected,
    identity: cleanupStage, operation }).catch((error) => error);
  ok(cleanupFailure instanceof Error && removals === cleanupRemovals && files.has(cleanupTemporary),
    "transfers: durable cleanup rejects a same-length third-party substitution without deleting it");
  files.delete(cleanupTemporary);

  let unverifiedUploads = 0, unverifiedRenames = 0, unverifiedDeletes = 0;
  const withoutInspection = {
    async uploadStream() { unverifiedUploads++; },
    async hashFile() { return expected; },
    async rename() { unverifiedRenames++; },
    async deleteFile() { unverifiedDeletes++; },
  };
  const unverifiedTemporary = `/ready/.ftp-mcp-${"8".repeat(32)}.tmp`;
  const unverifiedIdentity = { canonicalRoot: "/", path: unverifiedTemporary, parent: "/ready", ...expected };
  const refusedWithoutInspection = await Promise.all([
    stageVerifiedSource({ adapter: withoutInspection, source, temporary: unverifiedTemporary, expected, operation })
      .catch((error) => error),
    promoteVerifiedStage({ adapter: withoutInspection, temporary: unverifiedTemporary, target: "/ready/no-inspect.txt",
      mode: 0o600, identity: unverifiedIdentity, operation }).catch((error) => error),
    cleanupVerifiedStage({ adapter: withoutInspection, temporary: unverifiedTemporary, expected,
      identity: unverifiedIdentity, operation }).catch((error) => error),
  ]);
  ok(refusedWithoutInspection.every((error) => error instanceof Error) &&
    unverifiedUploads === 0 && unverifiedRenames === 0 && unverifiedDeletes === 0,
  "transfers: every durable seam requires strict inspectFile support before any mutation");

  for (const preflight of ["missing parent", "collision"]) {
    let readable;
    const failure = await stageVerifiedSource({
      adapter: {
        async uploadStream(stream) { readable = stream; throw new Error(preflight); },
        async inspectFile() { throw new Error("inspection must not run after rejected preflight"); },
      },
      source, temporary: `/ready/.ftp-mcp-${(preflight === "collision" ? "9" : "0").repeat(32)}.tmp`,
      expected, operation,
    }).catch((error) => error);
    ok(failure instanceof Error && readable?.destroyed === true && readable?.closed === true,
      `transfers: durable ${preflight} preflight closes the caller-owned source stream`);
  }

  let legacyHashes = 0, legacyInspections = 0;
  const legacyFiles = new Map();
  const legacyAdapter = {
    async uploadFile(local, remote, maxBytes, options) {
      const bytes = fs.readFileSync(local);
      checkTransferSize(bytes.length, maxBytes);
      legacyFiles.set(remote, bytes);
      options.onOwned?.(Object.freeze({ path: remote }));
      return { mode: 0o644 };
    },
    async hashFile(remote, maxBytes) {
      legacyHashes++;
      const bytes = legacyFiles.get(remote);
      checkTransferSize(bytes.length, maxBytes);
      return digest(bytes);
    },
    async inspectFile() { legacyInspections++; throw new Error("legacy upload must not inspect"); },
    async rename(from, to) { legacyFiles.set(to, legacyFiles.get(from)); legacyFiles.delete(from); },
    async deleteFile(remote) { legacyFiles.delete(remote); },
  };
  await uploadVerified({ adapter: legacyAdapter, source, target: "/ready/legacy.txt", maxBytes: expected.bytes,
    expected, operation });
  ok(legacyHashes === 1 && legacyInspections === 0 && legacyFiles.get("/ready/legacy.txt").equals(payload),
    "transfers: legacy successful upload hashes exactly once and never uses durable inspection");

  let invalidAccepted = 0;
  for (const temporary of [
    "/ready/.ftp-mcp-short.tmp", `/ready/.ftp-mcp-${"A".repeat(32)}.tmp`,
    `/ready/prefix.ftp-mcp-${tokenA}.tmp`, `/ready/.ftp-mcp-${tokenA}.tmp.extra`,
  ]) {
    try { await stageVerifiedSource({ adapter, source, temporary, expected, operation }); invalidAccepted++; } catch { /* required */ }
  }
  try {
    await promoteVerifiedStage({ adapter, temporary: temporaryA, target: "/other/final.txt", mode: 0o644,
      identity: staged, operation });
    invalidAccepted++;
  } catch { /* required */ }
  ok(invalidAccepted === 0, "transfers: durable temporary validation accepts only exact lowercase-hex sibling names");

  const rejectedKinds = [];
  for (const name of ["directory", "link"]) {
    try { await adapter.inspectFile(`/ready/${name}`, { maxBytes: 100 }); }
    catch { rejectedKinds.push(name); }
  }
  ok(rejectedKinds.join(",") === "directory,link", "transfers: strict inspection rejects directories and links");

  const wrong = `/ready/.ftp-mcp-${"c".repeat(32)}.tmp`;
  const beforeRemovals = removals;
  const corrupt = { ...expected, sha256: "0".repeat(64) };
  const mismatch = await stageVerifiedSource({ adapter, source, temporary: wrong, expected: corrupt, operation }).catch((error) => error);
  ok(mismatch instanceof Error && files.has(wrong) && removals === beforeRemovals && /temporary/i.test(mismatch.message),
    "transfers: unverified durable staging failure leaves the temporary with a bounded cleanup warning");
  files.delete(wrong);
}

export async function runTransferTests({ root, ok }) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "complete source bytes");
  fs.writeFileSync(path.join(root, "empty.txt"), "");
  await durableSeamTests(root, ok);
  const base = loaded(root).config.servers.test;
  const configPath = path.join(root, "limits.json");
  for (const [field, maximum] of [["maxTransferBytes", 1099511627776], ["maxDeployBytes", 1099511627776], ["maxDeployFiles", 100000]]) {
    for (const value of [1, maximum, 0, -1, maximum + 1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      fs.writeFileSync(configPath, JSON.stringify({ servers: { test: { ...base, [field]: value } } }));
      const result = loadConfig(configPath);
      const valid = value === 1 || value === maximum;
      ok(valid ? !result.error : result.error?.includes(field), `transfers: validates ${field}=${JSON.stringify(value)}`);
    }
  }
  const normalized = normalizeServer("test", base);
  ok(normalized.maxTransferBytes === 268435456 && normalized.maxDeployFiles === 10000 &&
    normalized.maxDeployBytes === 1073741824, "transfers: server-side limits have the documented defaults");

  let opens = 0;
  const limited = capture(loaded(root, { maxTransferBytes: 4 }), async () => { opens += 1; return virtualTransferAdapter(); });
  const oversized = await limited("ftp_upload", { local_path: "source.txt" });
  ok(oversized.isError && opens === 0 && resultText(oversized).includes("TRANSFER_LIMIT"),
    "transfers: oversized upload is rejected before connection");
  const deploy = path.join(root, "deploy");
  fs.mkdirSync(deploy);
  fs.writeFileSync(path.join(deploy, "a.txt"), "abc");
  fs.writeFileSync(path.join(deploy, "b.txt"), "def");
  for (const extra of [{ maxDeployFiles: 1 }, { maxDeployBytes: 5 }, { maxTransferBytes: 2 }]) {
    const call = capture(loaded(root, extra), async () => { opens += 1; return virtualTransferAdapter(); });
    const result = await call("ftp_deploy", { local_dir: "deploy" });
    ok(result.isError && opens === 0 && resultText(result).includes("TRANSFER_LIMIT"),
      "transfers: selected deployment exceeding count/total/file quota is rejected before network");
  }
  fs.mkdirSync(path.join(deploy, "nested"));
  fs.writeFileSync(path.join(deploy, ".ftp-mcp-root.tmp"), "incomplete");
  fs.writeFileSync(path.join(deploy, "nested", ".ftp-mcp-child.tmp"), "incomplete");
  const excluded = await capture(loaded(root), async () => { opens += 1; return virtualTransferAdapter(); })(
    "ftp_deploy", { local_dir: "deploy", dry_run: true, include: ["**/.ftp-mcp-*.tmp"] });
  ok(!excluded.isError && excluded.structuredContent.total_files === 0 && opens === 0,
    "transfers: reserved temporary names are excluded at root and depth even with explicit include");

  for (const name of ["source.txt", "empty.txt"]) {
    const files = new Map([["/final.txt", Buffer.from("prior target")]]);
    const promotions = [];
    const call = capture(loaded(root), async () => virtualTransferAdapter({
      async rename(from, to) { promotions.push([from, to]); },
    }, files));
    const upload = await call("ftp_upload", { local_path: name, remote_path: "final.txt" });
    const expected = fs.readFileSync(path.join(root, name));
    ok(!upload.isError && files.get("/final.txt").equals(expected) && promotions.length === 1 &&
      temporaryName.test(path.posix.basename(promotions[0][0])) && promotions[0][1] === "/final.txt" &&
      upload.structuredContent.remote_path === "/final.txt" && upload.structuredContent.size_bytes === expected.length,
    `transfers: verified upload promotes complete final bytes for ${name}`);
    const downloadName = `download-${name}`;
    const downloaded = await call("ftp_download", { remote_path: "final.txt", local_path: downloadName });
    ok(!downloaded.isError && fs.readFileSync(path.join(root, downloadName)).equals(expected) &&
      downloaded.structuredContent.size_bytes === expected.length &&
      !fs.readdirSync(root).some((entry) => temporaryName.test(entry)),
    `transfers: verified download promotes complete final bytes for ${name}`);
  }

  for (const fault of ["partial upload", "hash mismatch", "rename failure", "cleanup failure"]) {
    const files = new Map([["/final.txt", Buffer.from("prior")]]);
    let promotions = 0;
    const deleted = [];
    const call = capture(loaded(root), async () => {
      const adapter = virtualTransferAdapter({}, files);
      const upload = adapter.uploadFile;
      adapter.uploadFile = async (local, remote, max, options) => {
        await upload(local, remote, max, options);
        if (fault === "partial upload" || fault === "cleanup failure") {
          files.set(remote, Buffer.from("partial"));
          throw new Error("primary upload failure");
        }
        if (fault === "hash mismatch") files.set(remote, Buffer.from("wrong"));
      };
      const rename = adapter.rename;
      adapter.rename = async (...args) => {
        promotions += 1;
        if (fault === "rename failure") throw new Error("primary rename failure");
        return rename(...args);
      };
      const remove = adapter.deleteFile;
      adapter.deleteFile = async (remote) => {
        deleted.push(remote);
        if (fault === "cleanup failure") throw new Error(SECRET);
        return remove(remote);
      };
      return adapter;
    });
    const result = await call("ftp_upload", { local_path: "source.txt", remote_path: "final.txt" });
    ok(result.isError && files.get("/final.txt").toString() === "prior" &&
      promotions === (fault === "rename failure" ? 1 : 0) &&
      deleted.length === 1 && temporaryName.test(path.posix.basename(deleted[0])),
    `transfers: ${fault} preserves prior target and only cleans the owned temporary`);
    if (fault === "cleanup failure") ok(resultText(result).includes("primary upload failure") &&
      resultText(result).includes("temporary file may remain") && !resultText(result).includes(SECRET),
    "transfers: cleanup failure retains primary error with a bounded sanitized warning");
  }

  for (const fault of ["partial", "mismatch", "oversized"]) {
    const target = path.join(root, `old-${fault}.txt`);
    fs.writeFileSync(target, "prior");
    const files = new Map([["/source", Buffer.from("expected")]]);
    const call = capture(loaded(root, { maxTransferBytes: 10 }), async () => virtualTransferAdapter({
      async downloadFile(_remote, local) {
        fs.writeFileSync(local, fault === "oversized" ? "x".repeat(11) : "changed!");
        if (fault === "partial") throw new Error("partial download");
      },
    }, files));
    const result = await call("ftp_download", { remote_path: "source", local_path: target, overwrite: true });
    ok(result.isError && fs.readFileSync(target, "utf8") === "prior" &&
      !fs.readdirSync(root).some((entry) => temporaryName.test(entry)),
    `transfers: ${fault} download never replaces the prior destination`);
  }

  for (const fault of ["appeared", "unsupported"]) {
    const target = path.join(root, `link-${fault}.txt`);
    const link = fs.linkSync;
    const rename = fs.renameSync;
    let renames = 0;
    fs.linkSync = (from, to) => {
      if (to === target) {
        if (fault === "appeared") fs.writeFileSync(to, "external");
        else throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
      }
      return link(from, to);
    };
    fs.renameSync = (...args) => { renames += 1; return rename(...args); };
    try {
      const result = await capture(loaded(root), async () => virtualTransferAdapter())(
        "ftp_download", { remote_path: "source", local_path: target });
      ok(result.isError && renames === 0 &&
        (fault === "appeared" ? fs.readFileSync(target, "utf8") === "external" : !fs.existsSync(target)),
      `transfers: no-clobber download fails closed when destination ${fault}`);
    } finally { fs.linkSync = link; fs.renameSync = rename; }
  }

  const lyingStat = fs.statSync;
  fs.statSync = (name, ...args) => {
    const actual = lyingStat(name, ...args);
    return name === source ? new Proxy(actual, { get(target, key) {
      return key === "size" ? 0 : typeof target[key] === "function" ? target[key].bind(target) : target[key];
    } }) : actual;
  };
  try {
    const result = await limited("ftp_upload", { local_path: "source.txt" });
    ok(result.isError && opens === 0, "transfers: actual source bytes enforce the bound even when stat lies");
  } finally { fs.statSync = lyingStat; }
  const over = Buffer.alloc(11);
  const remoteFailure = await hashRemoteStream((sink) => pipeline(Readable.from([over]), sink), 10).catch((error) => error);
  const localFailure = await receiveLocalStream(path.join(root, "bounded.tmp"), 10, undefined,
    (sink) => pipeline(Readable.from([over]), sink)).catch((error) => error);
  ok(remoteFailure instanceof Error && localFailure instanceof Error &&
    fs.statSync(path.join(root, "bounded.tmp")).size <= 10, "transfers: streaming hash and download reject actual over-limit bytes");
  const emptyHash = await hashLocalFile(path.join(root, "empty.txt"), 1);
  ok(emptyHash.bytes === 0 && emptyHash.sha256 === digest(Buffer.alloc(0)).sha256,
    "transfers: zero-byte sources receive a complete SHA256 digest");

  for (const stage of ["upload", "verification"]) {
    const controller = new AbortController();
    const files = new Map([["/a.txt", Buffer.from("prior")]]);
    let uploads = 0;
    let hashes = 0;
    let promotions = 0;
    const call = capture(loaded(root), async () => virtualTransferAdapter({
      async uploadFile() { uploads++; if (stage === "upload") controller.abort(); },
      async hashFile(remote) { hashes++; controller.abort(); return digest(files.get(remote)); },
      async rename() { promotions++; },
    }, files));
    const result = await call("ftp_deploy", { local_dir: "deploy" }, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    ok(result.isError && resultText(result).includes("CANCELLED") && uploads === 1 &&
      hashes === (stage === "upload" ? 0 : 1) && promotions === 0 && files.get("/a.txt").toString() === "prior",
    "transfers: abort during " + stage + " prevents promotion and the following deployment file");
  }

  const shared = new Map();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let verifying = false;
  let connections = 0;
  const serial = capture(loaded(root), async () => {
    const first = ++connections === 1;
    return virtualTransferAdapter({ async hashFile(remote) {
      if (first) { verifying = true; await gate; }
      return digest(shared.get(remote));
    } }, shared);
  });
  const a = serial("ftp_upload", { local_path: "source.txt", remote_path: "serial.txt" });
  const until = Date.now() + 3000;
  while (!verifying) {
    if (Date.now() > until) throw new Error("verification stage did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const b = serial("ftp_upload", { local_path: "empty.txt", remote_path: "serial.txt" });
  await new Promise((resolve) => setImmediate(resolve));
  ok(connections === 1, "transfers: endpoint lock remains owned during readback verification");
  unblock();
  const serialResults = await Promise.all([a, b]);
  ok(serialResults.every((result) => !result.isError) && connections === 2 && shared.get("/serial.txt").length === 0,
    "transfers: two staged uploads serialize through the final promotion");

  for (const stage of ["download", "chmod", "fsync", "close", "rename"]) {
    const target = path.join(root, "preserve-" + stage + ".txt");
    fs.writeFileSync(target, "prior");
    const controller = new AbortController();
    const sync = fs.fsyncSync;
    const chmod = fs.fchmodSync;
    const close = fs.closeSync;
    const rename = fs.renameSync;
    const open = fs.openSync;
    let temporaryFd;
    let closeInjected = false;
    let promotion = 0;
    fs.openSync = (file, ...args) => {
      const fd = open(file, ...args);
      if (temporaryName.test(path.basename(String(file))) && args[0] === "wx") temporaryFd = fd;
      return fd;
    };
    fs.fsyncSync = (fd) => { if (fd === temporaryFd && stage === "fsync") throw new Error("injected fsync"); return sync(fd); };
    fs.fchmodSync = (fd, mode) => { if (fd === temporaryFd && stage === "chmod") throw new Error("injected chmod"); return chmod(fd, mode); };
    fs.closeSync = (fd) => {
      const value = close(fd);
      if (fd === temporaryFd && stage === "close" && !closeInjected) {
        closeInjected = true;
        throw new Error("injected close");
      }
      return value;
    };
    fs.renameSync = (from, to) => {
      if (to === target) { promotion++; if (stage === "rename") throw new Error("injected rename"); }
      return rename(from, to);
    };
    try {
      const call = capture(loaded(root), async () => virtualTransferAdapter({
        async downloadFile(_remote, local) {
          fs.writeFileSync(local, "downloaded");
          if (stage === "download") controller.abort();
        },
      }));
      const result = await call("ftp_download", {
        remote_path: "source", local_path: target, overwrite: true,
      }, { signal: controller.signal });
      // Cancellation can return before the owned worker finishes its cleanup.
      await new Promise((resolve) => setImmediate(resolve));
      ok(result.isError && fs.readFileSync(target, "utf8") === "prior" &&
        promotion === (stage === "rename" ? 1 : 0) &&
        !fs.readdirSync(root).some((name) => temporaryName.test(name)),
      "transfers: " + stage + " failure preserves the prior local destination and cleans its owned temporary");
    } finally { fs.openSync = open; fs.fsyncSync = sync; fs.fchmodSync = chmod; fs.closeSync = close; fs.renameSync = rename; }
  }

  for (const primaryFailure of [false, true]) {
    const target = path.join(root, "cleanup-" + primaryFailure + ".txt");
    const unlink = fs.unlinkSync;
    let remaining;
    fs.unlinkSync = (file) => {
      if (temporaryName.test(path.basename(String(file)))) { remaining = file; throw new Error(SECRET); }
      return unlink(file);
    };
    let result;
    try {
      result = await capture(loaded(root), async () => virtualTransferAdapter({
        async downloadFile(_remote, local) {
          fs.writeFileSync(local, "downloaded");
          if (primaryFailure) throw new Error("primary download failure");
        },
      }))("ftp_download", { remote_path: "source", local_path: target });
      ok(Boolean(result.isError) === primaryFailure && resultText(result).includes("temporary file may remain") &&
        !resultText(result).includes(SECRET) &&
        (primaryFailure ? resultText(result).includes("primary download failure") && !fs.existsSync(target) :
          fs.readFileSync(target, "utf8") === "downloaded"),
      "transfers: local cleanup warning preserves " + (primaryFailure ? "the primary failure" : "successful promotion"));
    } finally { fs.unlinkSync = unlink; if (remaining) fs.unlinkSync(remaining); }
  }

  const aliasCase = path.join(root, "retarget-during-transfer");
  const realParent = path.join(aliasCase, "real");
  const alternateParent = path.join(aliasCase, "alternate");
  const aliasParent = path.join(aliasCase, "alias");
  const realRoot = path.join(realParent, "site");
  const alternateRoot = path.join(alternateParent, "site");
  fs.mkdirSync(realRoot, { recursive: true });
  fs.mkdirSync(alternateRoot, { recursive: true });
  fs.writeFileSync(path.join(realRoot, "final.txt"), "prior");
  const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  linkDirectory(realParent, aliasParent);
  let ownedTemporary;
  let unrelatedTemporary;
  const retargeted = await capture(loaded(path.join(aliasParent, "site")), async () => virtualTransferAdapter({
    async downloadFile(_remote, local) {
      ownedTemporary = local;
      fs.writeFileSync(local, "downloaded");
      unrelatedTemporary = path.join(alternateRoot, path.basename(local));
      fs.writeFileSync(unrelatedTemporary, "unrelated");
      fs.renameSync(aliasParent, path.join(aliasCase, "saved-alias"));
      linkDirectory(alternateParent, aliasParent);
    },
  }))("ftp_download", { remote_path: "source", local_path: "final.txt", overwrite: true });
  ok(retargeted.isError && resultText(retargeted).includes("TARGET_CHANGED") &&
    fs.readFileSync(path.join(realRoot, "final.txt"), "utf8") === "prior" &&
    !fs.existsSync(ownedTemporary) && fs.readFileSync(unrelatedTemporary, "utf8") === "unrelated",
  "transfers: retargeted ancestor refuses promotion and cleanup remains anchored to its owned canonical temporary");

  let downloads = 0;
  const remoteOversized = await capture(loaded(root, { maxTransferBytes: 10 }), async () => virtualTransferAdapter({
    async stat() { return { type: "file", size: 0 }; },
    async downloadFile() { downloads++; },
  }, new Map([["/lying-size", Buffer.alloc(11)]])))(
    "ftp_download", { remote_path: "lying-size", local_path: "never-created.txt" });
  ok(remoteOversized.isError && resultText(remoteOversized).includes("TRANSFER_LIMIT") && downloads === 0 &&
    !fs.existsSync(path.join(root, "never-created.txt")),
  "transfers: bounded remote digest rejects actual bytes despite a lying advertised size before download");

  const openExclusive = fs.openSync;
  let collision;
  fs.openSync = (file, flags, ...args) => {
    if (flags === "wx" && temporaryName.test(path.basename(String(file)))) {
      collision = file;
      const other = openExclusive(file, flags, ...args);
      fs.closeSync(other);
      fs.writeFileSync(file, "owned by somebody else");
    }
    return openExclusive(file, flags, ...args);
  };
  try {
    const result = await capture(loaded(root), async () => virtualTransferAdapter())(
      "ftp_download", { remote_path: "source", local_path: "exclusive.txt" });
    ok(result.isError && !fs.existsSync(path.join(root, "exclusive.txt")) &&
      fs.readFileSync(collision, "utf8") === "owned by somebody else",
    "transfers: exclusive temporary creation never overwrites or cleans a preexisting colliding file");
  } finally { fs.openSync = openExclusive; if (collision) fs.unlinkSync(collision); }

  for (const mode of [0o755, 0o600]) {
    const target = path.join(root, "mode-" + mode + ".txt");
    fs.writeFileSync(target, "prior");
    fs.chmodSync(target, mode);
    const lstat = fs.lstatSync;
    const chmod = fs.fchmodSync;
    const requested = [];
    if (process.platform === "win32") fs.lstatSync = (file, ...args) => {
      const actual = lstat(file, ...args);
      return file === target ? new Proxy(actual, { get(value, key) {
        return key === "mode" ? 0o100000 | mode : typeof value[key] === "function" ? value[key].bind(value) : value[key];
      } }) : actual;
    };
    fs.fchmodSync = (fd, value) => { requested.push(value); return chmod(fd, value); };
    try {
      const result = await capture(loaded(root), async () => virtualTransferAdapter())(
        "ftp_download", { remote_path: "source", local_path: target, overwrite: true });
      ok(!result.isError && requested.length === 1 && requested[0] === mode &&
        (process.platform === "win32" || (fs.statSync(target).mode & 0o777) === mode),
      "transfers: local replacement preserves permission bits " + mode.toString(8) +
        (process.platform === "win32" ? " (requested mode; POSIX assertions run on Unix)" : ""));
    } finally { fs.lstatSync = lstat; fs.fchmodSync = chmod; }
  }
  const newTarget = path.join(root, "new-private.txt");
  const chmod = fs.fchmodSync;
  const open = fs.openSync;
  let creationMode;
  let unnecessaryChmod = 0;
  fs.openSync = (file, flags, mode) => {
    if (flags === "wx" && temporaryName.test(path.basename(String(file)))) creationMode = mode;
    return open(file, flags, mode);
  };
  fs.fchmodSync = (...args) => { unnecessaryChmod++; return chmod(...args); };
  try {
    const result = await capture(loaded(root), async () => virtualTransferAdapter())(
      "ftp_download", { remote_path: "source", local_path: newTarget });
    ok(!result.isError && creationMode === 0o600 && unnecessaryChmod === 0 &&
      (process.platform === "win32" || (fs.statSync(newTarget).mode & 0o777) === 0o600),
    "transfers: new local destination keeps the exclusive temporary's restrictive creation mode");
  } finally { fs.openSync = open; fs.fchmodSync = chmod; }

  await sftpPermissionTests(root, ok);
  await transferIdentityTests(root, ok);
}

async function transferIdentityTests(root, ok) {
  for (const initialBytes of [0, 1]) {
    const remoteRoot = path.join(root, "growth-" + initialBytes);
    fs.mkdirSync(remoteRoot);
    fs.writeFileSync(path.join(remoteRoot, "final.txt"), "prior");
    const local = path.join(root, "growing-" + initialBytes + ".txt");
    fs.writeFileSync(local, Buffer.alloc(initialBytes));
    const fixture = await startSftpServer({ root: remoteRoot, user: "test", password: SECRET });
    try {
      const call = capture(loaded(root, {
        host: "127.0.0.1", port: fixture.port, hostKeySha256: fixture.hostKeySha256, maxTransferBytes: 100,
      }), async (server, operation) => {
        // Tool preflight has hashed the original size before connecting.
        fs.writeFileSync(local, Buffer.alloc(20));
        return connectSftp(server, operation);
      });
      const result = await call("ftp_upload", { local_path: local, remote_path: "final.txt" });
      const stats = fixture.getStats();
      ok(result.isError && resultText(result).includes("TRANSFER_LIMIT") &&
        stats.permissions.filter((event) => event.action === "write").length === 0 && stats.renames.length === 0 &&
        fs.readFileSync(path.join(remoteRoot, "final.txt"), "utf8") === "prior" && fs.readdirSync(remoteRoot).length === 1,
      "transfers: real upload caps a growing source at its hashed " + initialBytes + "-byte reservation");
    } finally { await fixture.close(); }
  }

  const quotaRoot = path.join(root, "failed-quota");
  fs.mkdirSync(quotaRoot);
  const names = ["a", "b", "c"];
  for (const name of names) fs.writeFileSync(path.join(quotaRoot, name), "x");
  let attempts = 0;
  let wireBytes = 0;
  const quota = await capture(loaded(root, { maxDeployBytes: 3, maxTransferBytes: 100 }),
    async (_server, operation) => {
      for (const name of names) fs.writeFileSync(path.join(quotaRoot, name), "xx");
      const adapter = virtualTransferAdapter();
      adapter.uploadFile = async (local, remote, limit, options) => {
        attempts++;
        options.onOwned();
        const chunks = [];
        await sendLocalStream(local, limit, operation, async (input) => {
          for await (const chunk of input) { wireBytes += chunk.length; chunks.push(chunk); }
        });
        adapter.files.set(remote, Buffer.concat(chunks));
        throw new Error("injected failure after transmission");
      };
      return adapter;
    })("ftp_deploy", { local_dir: "failed-quota" });
  ok(quota.isError && attempts === 1 && wireBytes === 2 && resultText(quota).includes("maxDeployBytes"),
    "transfers: failed attempts retain reservations and cumulative transmitted bytes remain within deployment quota");

  const small = path.join(root, "small-expectation.txt");
  fs.writeFileSync(small, "x");
  const files = new Map([["/final.txt", Buffer.from("prior")]]);
  let verificationCap;
  const changedReadback = await capture(loaded(root, { maxTransferBytes: 100 }), async () => {
    const adapter = virtualTransferAdapter({}, files);
    const hash = adapter.hashFile;
    adapter.hashFile = async (remote, limit) => {
      verificationCap = limit;
      files.set(remote, Buffer.alloc(20));
      return hash(remote, limit);
    };
    return adapter;
  })("ftp_upload", { local_path: small, remote_path: "final.txt" });
  ok(changedReadback.isError && verificationCap === 1 && resultText(changedReadback).includes("TRANSFER_LIMIT") &&
    files.get("/final.txt").toString() === "prior",
  "transfers: readback is capped at the hashed source size rather than only the larger server policy");

  const remoteRoot = path.join(root, "changed-remote-root");
  for (const name of ["alias", "A", "B"]) fs.mkdirSync(path.join(remoteRoot, name), { recursive: true });
  fs.writeFileSync(path.join(remoteRoot, "B", "final.txt"), "unrelated final");
  let canonical = "/A";
  let owned;
  let unrelated;
  const fixture = await startSftpServer({
    root: remoteRoot, user: "test", password: SECRET,
    realPath(value) { return value === "/alias" ? canonical : value; },
    onWrite(event) {
      owned = event.path;
      unrelated = path.join(remoteRoot, "B", path.basename(owned));
      fs.writeFileSync(unrelated, "unrelated temporary");
      canonical = "/B";
    },
  });
  try {
    const result = await capture(loaded(root, {
      root: "/alias", host: "127.0.0.1", port: fixture.port, hostKeySha256: fixture.hostKeySha256,
    }), connectSftp)("ftp_upload", { local_path: small, remote_path: "final.txt" });
    const stats = fixture.getStats();
    ok(result.isError && resultText(result).includes("TARGET_CHANGED") &&
      resultText(result).includes("temporary file may remain") &&
      stats.removes.length === 0 && stats.renames.length === 0 &&
      fs.readFileSync(owned, "utf8") === "x" && fs.readFileSync(unrelated, "utf8") === "unrelated temporary" &&
      fs.readFileSync(path.join(remoteRoot, "B", "final.txt"), "utf8") === "unrelated final",
    "transfers: changed SFTP canonical root refuses rebased verification, cleanup and promotion, preserving both owned and unrelated files");
  } finally { await fixture.close(); }
}

async function sftpPermissionTests(root, ok) {
  const seamRoot = path.join(root, "sftp-durable-seams");
  fs.mkdirSync(path.join(seamRoot, "stage"), { recursive: true });
  fs.mkdirSync(path.join(seamRoot, "directory"));
  fs.writeFileSync(path.join(seamRoot, "file.txt"), "inspect me");
  let linkCreated = false;
  try {
    fs.symlinkSync(path.join(seamRoot, "directory"), path.join(seamRoot, "link"), process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;
  } catch { /* platform policy can forbid local symlink creation */ }
  const seamFixture = await startSftpServer({ root: seamRoot, user: "test", password: SECRET });
  let seamAdapter;
  try {
    seamAdapter = await connectSftp(loaded(root, {
      host: "127.0.0.1", port: seamFixture.port, hostKeySha256: seamFixture.hostKeySha256,
    }).config.servers.test);
    const observed = await seamAdapter.inspectFile("/file.txt", { maxBytes: 100 });
    const absent = await seamAdapter.inspectFile("/absent.txt", { maxBytes: 100 });
    ok(observed.type === "file" && observed.bytes === 10 && observed.sha256 === digest(Buffer.from("inspect me")).sha256 &&
      Number.isInteger(observed.mode) && observed.parent === "/" && observed.canonicalRoot === "/" &&
      absent.type === "absent" && absent.parent === "/" && absent.canonicalRoot === "/",
    "transfers: real SFTP inspectFile returns strict file/absent observations with digest, mode, parent and canonical root");
    const rejected = [];
    for (const name of ["directory", ...(linkCreated ? ["link"] : [])]) {
      try { await seamAdapter.inspectFile(`/${name}`, { maxBytes: 100 }); }
      catch { rejected.push(name); }
    }
    ok(rejected.length === 1 + Number(linkCreated),
      "transfers: real SFTP inspectFile rejects directories and links without downloading them");
    let missingParentRejected = false;
    try {
      await seamAdapter.uploadStream(Readable.from([Buffer.from("x")]),
        `/missing/.ftp-mcp-${"d".repeat(32)}.tmp`, digest(Buffer.from("x")),
        { staged: true, createParents: false });
    } catch { missingParentRejected = true; }
    ok(missingParentRejected && !fs.existsSync(path.join(seamRoot, "missing")),
      "transfers: real SFTP uploadStream createParents:false rejects a missing parent without creating it");
    let creating = 0, owned;
    const stagePath = `/stage/.ftp-mcp-${"e".repeat(32)}.tmp`;
    await seamAdapter.uploadStream(Readable.from([Buffer.from("streamed")]), stagePath, digest(Buffer.from("streamed")), {
      staged: true, createParents: false, onCreating() { creating++; }, onOwned(value) { owned = value; },
    });
    const staged = await seamAdapter.inspectFile(stagePath, { maxBytes: 8 });
    const chunks = [];
    await seamAdapter.downloadStream(stagePath,
      new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }), 8, { identity: staged.identity });
    ok(creating === 1 && owned?.path === staged.path && Buffer.concat(chunks).toString() === "streamed",
      "transfers: real SFTP stream seams retain exclusive ownership and verified identity");

    const stageBacking = path.join(seamRoot, "stage", path.posix.basename(stagePath));
    const promotionTarget = path.join(seamRoot, "stage", "preserved.txt");
    fs.writeFileSync(promotionTarget, "preserved");
    fs.writeFileSync(stageBacking, "thirdpty");
    const beforeRename = seamFixture.getStats().renames.length;
    const renameFailure = await seamAdapter.rename(stagePath, "/stage/preserved.txt", {
      staged: true, createParents: false, mode: staged.mode, identity: staged.identity,
    }).catch((error) => error);
    ok(renameFailure instanceof Error && seamFixture.getStats().renames.length === beforeRename &&
      fs.readFileSync(promotionTarget, "utf8") === "preserved" && fs.readFileSync(stageBacking, "utf8") === "thirdpty",
    "transfers: SFTP adapter rehashes a durable identity immediately before rename and preserves substituted bytes");

    const deletePath = `/stage/.ftp-mcp-${"f".repeat(32)}.tmp`;
    const deleteBacking = path.join(seamRoot, "stage", path.posix.basename(deletePath));
    fs.writeFileSync(deleteBacking, "deletion");
    const deleteIdentity = await seamAdapter.inspectFile(deletePath, { maxBytes: 8 });
    fs.writeFileSync(deleteBacking, "intruder");
    const beforeDelete = seamFixture.getStats().removes.length;
    const deleteFailure = await seamAdapter.deleteFile(deletePath, { identity: deleteIdentity.identity })
      .catch((error) => error);
    ok(deleteFailure instanceof Error && seamFixture.getStats().removes.length === beforeDelete &&
      fs.readFileSync(deleteBacking, "utf8") === "intruder",
    "transfers: SFTP adapter rehashes a durable identity immediately before delete and leaves substitutions intact");
  } finally {
    await seamAdapter?.close();
    await seamFixture.close();
  }

  for (const policy of ["executable", "private", "new", "deny restriction", "deny restoration", "ignored restriction", "ignored restoration"]) {
    const remoteRoot = path.join(root, "sftp-" + policy.replaceAll(" ", "-"));
    fs.mkdirSync(remoteRoot);
    const target = path.join(remoteRoot, "final.txt");
    const priorMode = policy === "private" ? 0o600 : 0o755;
    if (policy !== "new") fs.writeFileSync(target, "prior");
    const oldMask = process.umask(0o022);
    const fixture = await startSftpServer({
      root: remoteRoot, user: "test", password: SECRET,
      initialModes: policy === "new" ? {} : { "/final.txt": priorMode },
      denyChmod: policy === "deny restriction" ? true :
        policy === "deny restoration" ? (mode) => mode !== 0o600 : false,
      ignoreChmod: policy === "ignored restriction" ? true :
        policy === "ignored restoration" ? (mode) => mode !== 0o600 : false,
    });
    try {
      const call = capture(loaded(root, {
        host: "127.0.0.1", port: fixture.port, hostKeySha256: fixture.hostKeySha256,
      }), connectSftp);
      const result = await call("ftp_upload", { local_path: "source.txt", remote_path: "final.txt" });
      const events = fixture.getStats().permissions;
      const created = events.filter((event) => event.action === "create");
      const writes = events.filter((event) => event.action === "write");
      const modes = events.filter((event) => event.action === "chmod").map((event) => event.mode);
      if (policy.startsWith("deny") || policy.startsWith("ignored")) {
        ok(result.isError && fs.readFileSync(target, "utf8") === "prior" &&
          fs.readdirSync(remoteRoot).length === 1 && (policy.endsWith("restriction") ? writes.length === 0 : writes.length > 0),
        "transfers: SFTP " + policy + " keeps old content and only cleans the owned temporary");
      } else {
        const desired = policy === "new" ? created[0].mode : priorMode;
        ok(!result.isError && fs.readFileSync(target).equals(fs.readFileSync(path.join(root, "source.txt"))) &&
          created.length === 1 && created[0].flags === "wx" && modes.join(",") === [0o600, desired].join(",") &&
          writes.length > 0 && writes.every((event) => event.mode === 0o600) &&
          (process.platform === "win32" || (fs.statSync(target).mode & 0o777) === desired),
        "transfers: SFTP " + policy + " uses exclusive empty creation, private content writes and correct promotion mode");
      }
    } finally { process.umask(oldMask); await fixture.close(); }
  }

  const remoteRoot = path.join(root, "sftp-abort-handle");
  fs.mkdirSync(remoteRoot);
  fs.writeFileSync(path.join(remoteRoot, "final.txt"), "prior");
  fs.writeFileSync(path.join(root, "many-chunks.txt"), Buffer.alloc(200000));
  const controller = new AbortController();
  const fixture = await startSftpServer({
    root: remoteRoot, user: "test", password: SECRET, onWrite() { controller.abort(); },
  });
  try {
    const call = capture(loaded(root, {
      host: "127.0.0.1", port: fixture.port, hostKeySha256: fixture.hostKeySha256,
    }), connectSftp);
    const result = await call("ftp_upload", {
      local_path: "many-chunks.txt", remote_path: "final.txt",
    }, { signal: controller.signal });
    // An independent request to the same endpoint also waits for settlement
    // of the cancelled raw-handle worker and its close before connecting.
    const next = await call("ftp_mkdir", { path: "after-cancellation" });
    const events = fixture.getStats().permissions;
    ok(result.isError && resultText(result).includes("CANCELLED") && !next.isError &&
      fs.readFileSync(path.join(remoteRoot, "final.txt"), "utf8") === "prior" &&
      events.filter((event) => event.action === "write").length === 1 &&
      events.filter((event) => event.action === "chmod").length === 1,
    "transfers: cancellation during a real SFTP handle write stops further chunks and promotion before releasing ownership");
  } finally { await fixture.close(); }
}
