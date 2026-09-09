import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const TEST_SECRET = "TEST_ONLY_evaluation_password_9a1f";
export const TEMPORARY = /^\.ftp-mcp-[a-f0-9]{32}\.tmp$/;
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const textOf = (result) => (result?.content ?? []).map((item) => item.text ?? "").join("\n");
export const MUTATORS = new Set(["ftp_upload", "ftp_deploy", "ftp_download", "ftp_mkdir", "ftp_rename", "ftp_delete"]);

export function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("FIXTURE_PATH_OUTSIDE_SANDBOX");
  return path.resolve(file);
}
export function localSnapshot(root) {
  const records = [];
  let bytes = 0;
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (records.length >= 1024) throw new Error("FIXTURE_ENTRY_BUDGET");
      const relative = path.relative(root, file);
      if (stat.isSymbolicLink()) records.push([relative, "link", fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { records.push([relative, "directory"]); walk(file); }
      else {
        bytes += stat.size;
        if (bytes > 4 * 1024 * 1024) throw new Error("FIXTURE_BYTE_BUDGET");
        records.push([relative, "file", stat.size, sha(fs.readFileSync(file))]);
      }
    }
  }
  walk(root);
  return records;
}

// A transport fixture, not an implementation of the handlers' policy. It stores
// real bytes and computes its own hashes. Transfer streaming uses the repository's
// actual primitive, just as the real adapters do. Every remote effect is journaled.
export class MemoryRemote {
  constructor(id, journal) {
    this.id = id;
    this.journal = journal;
    this.files = new Map([["/", { type: "dir" }]]);
    this.hooks = {};
  }
  seed(file, bytes = "", type = "file") {
    if (this.files.size >= 512) throw new Error("FIXTURE_REMOTE_ENTRY_BUDGET");
    const value = Buffer.from(bytes);
    if (value.length > 2 * 1024 * 1024) throw new Error("FIXTURE_REMOTE_BYTE_BUDGET");
    this.files.set(file, type === "file" ? { type, bytes: value } : { type });
  }
  bytes(file) {
    const record = this.files.get(file);
    if (!record || record.type !== "file") throw Object.assign(new Error("TEST_ONLY missing fixture file"), { code: "ENOENT" });
    return record.bytes;
  }
  snapshot() {
    return JSON.stringify([...this.files].sort(([a], [b]) => a.localeCompare(b)).map(([file, entry]) => [file, entry.type, entry.bytes?.length ?? null, entry.bytes ? sha(entry.bytes) : null]));
  }
  record(method, kind, data = {}) {
    this.journal.push({ index: this.journal.length, actor: "sut", endpoint: this.id, method, kind, ...data });
  }
  effect(method, file, bytes = 0) { this.record(method, "effect", { path: file, bytes }); }
  async adapter(server, operation, primitives) {
    this.record("connect", "observation", { alias: server.name });
    await this.hooks.open?.({ server, operation, remote: this });
    const remote = this;
    return {
      async list(directory) {
        remote.record("list", "observation", { path: directory });
        await remote.hooks.list?.({ directory, remote });
        const prefix = directory === "/" ? "/" : directory + "/";
        return [...remote.files].filter(([file]) => file.startsWith(prefix) && file !== directory && !file.slice(prefix.length).includes("/"))
          .map(([file, entry]) => ({ name: file.slice(prefix.length), type: entry.type, size: entry.bytes?.length ?? 0, modifiedAt: "2026-09-09T00:00:00.000Z" }));
      },
      async stat(file) {
        remote.record("stat", "observation", { path: file });
        const entry = remote.files.get(file);
        if (!entry) throw Object.assign(new Error("TEST_ONLY missing fixture entry"), { code: "ENOENT" });
        return { type: entry.type, size: entry.bytes?.length ?? 0 };
      },
      async readFile(file, maxBytes) {
        remote.record("readFile", "observation", { path: file });
        const bytes = remote.bytes(file);
        const buffer = bytes.subarray(0, maxBytes);
        remote.record("readFile", "bytes", { bytes: buffer.length });
        return { buffer, truncated: bytes.length > maxBytes };
      },
      async hashFile(file, maxBytes) {
        remote.record("hashFile", "observation", { path: file, maxBytes });
        await remote.hooks.hash?.({ file, remote });
        const bytes = remote.bytes(file);
        primitives.checkTransferSize(bytes.length, maxBytes);
        remote.record("hashFile", "bytes", { bytes: bytes.length });
        return { bytes: bytes.length, sha256: sha(bytes) };
      },
      async mkdirp(directory) {
        remote.record("mkdirp", "attempt", { path: directory });
        const parts = directory.split("/").filter(Boolean);
        for (let index = 1; index <= parts.length; index++) {
          const file = "/" + parts.slice(0, index).join("/");
          if (!remote.files.has(file)) { remote.seed(file, "", "dir"); remote.effect("mkdirp", file); }
        }
      },
      async uploadFile(local, file, maxBytes, options = {}) {
        remote.record("uploadFile", "attempt", { path: file, staged: options.staged === true });
        await remote.hooks.beforeUpload?.({ local, file, remote, operation });
        if (options.staged) {
          if (remote.files.has(file)) throw Object.assign(new Error("TEST_ONLY temporary collision"), { code: "EEXIST" });
          options.onCreating?.();
          remote.seed(file);
          remote.effect("createTemporary", file);
          options.onOwned?.();
        }
        let count = 0;
        await primitives.sendLocalStream(local, maxBytes, operation, async (input) => {
          for await (const chunk of input) {
            const value = Buffer.from(chunk);
            const prior = remote.files.get(file)?.bytes ?? Buffer.alloc(0);
            const kept = remote.hooks.cutUpload ? value.subarray(0, Math.max(1, Math.floor(value.length / 2))) : value;
            remote.seed(file, Buffer.concat([prior, kept]));
            count += kept.length;
            remote.effect("writeTemporary", file, kept.length);
            remote.record("uploadFile", "bytes", { bytes: kept.length });
            if (remote.hooks.cutUpload) throw new Error("TEST_ONLY injected transfer cut");
          }
        });
        await remote.hooks.afterUpload?.({ local, file, remote, operation });
        return { mode: 0o600, bytes: count };
      },
      async downloadFile(file, local, maxBytes) {
        remote.record("downloadFile", "observation", { path: file });
        const bytes = remote.bytes(file);
        primitives.checkTransferSize(bytes.length, maxBytes);
        inside(primitives.caseRoot, local);
        fs.writeFileSync(local, bytes);
        remote.record("downloadFile", "bytes", { bytes: bytes.length });
        remote.record("downloadFile", "local_adapter_write", { bytes: bytes.length });
        await remote.hooks.download?.({ file, local, remote, operation });
      },
      async rename(from, to) {
        remote.record("rename", "attempt", { path: from, to });
        await remote.hooks.rename?.({ from, to, remote, operation });
        const value = remote.files.get(from);
        if (!value) throw new Error("TEST_ONLY missing rename source");
        remote.files.set(to, value);
        remote.files.delete(from);
        remote.effect("rename", to, value.bytes?.length ?? 0);
      },
      async deleteFile(file) {
        remote.record("deleteFile", "attempt", { path: file });
        await remote.hooks.delete?.({ file, remote });
        if (remote.files.delete(file)) remote.effect("deleteFile", file);
      },
      async deleteDir(directory) {
        remote.record("deleteDir", "attempt", { path: directory });
        for (const file of [...remote.files.keys()]) if (file === directory || file.startsWith(directory + "/")) {
          remote.files.delete(file); remote.effect("deleteDir", file);
        }
      },
      async close() { remote.record("close", "observation"); },
    };
  }
}
