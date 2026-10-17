import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { normalizeServer } from "../../src/config.js";
import { appError } from "../../src/errors.js";
import { validateStateLimits } from "../../src/state/index.mjs";

export const scratch = fileURLToPath(new URL("../../.tmp/durable-tests/", import.meta.url));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const operation = (signal = new AbortController().signal) => ({ signal, check() { if (signal.aborted) throw signal.reason; } });

export async function fixture(t, { protocol = "sftp", serverOverrides = {}, configOverrides = {} } = {}) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, "case-"));
  const localRoot = path.join(root, "local");
  const stateDir = path.join(root, "state");
  await fs.mkdir(localRoot);
  const raw = {
    protocol,
    host: "EXAMPLE.test.",
    user: "Deploy",
    password: "credential-secret",
    passphrase: "passphrase-secret",
    privateKeyPath: path.join(root, "private-key-secret"),
    localRoot,
    root: "/root",
    allowInsecure: protocol === "ftp",
    hostKeySha256: protocol === "sftp" ? `SHA256:${Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "")}` : undefined,
    ...serverOverrides,
  };
  const stateLimits = validateStateLimits(configOverrides.stateLimits);
  const { stateLimits: _stateLimits, ...otherConfig } = configOverrides;
  const config = { defaultServer: "prod", servers: { prod: raw }, stateDir,
    requirePlan: configOverrides.requirePlan ?? true, ...otherConfig, stateLimits };
  const loaded = { found: true, error: null, failure: null, config, serverNames: ["prod"],
    invalidServerNames: [], serverErrors: {}, serverFailures: {}, defaultServer: "prod" };
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(scratch));
    assert.ok(path.basename(root).startsWith("case-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, localRoot, stateDir, domainId: randomUUID(), raw, server: normalizeServer("prod", raw), loaded, stateLimits,
    file: (...parts) => path.join(localRoot, ...parts) };
}

export async function write(root, relative, data) {
  const file = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return file;
}

export function fakeAdapter(server, observations = {}) {
  const calls = [];
  return {
    calls,
    async inspectFile(remotePath, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
      calls.push(remotePath);
      const relative = path.posix.relative(server.root, remotePath);
      const supplied = observations[relative];
      if (supplied instanceof Error) throw supplied;
      const kind = supplied?.kind ?? "file";
      const canonicalRoot = server.protocol === "sftp" ? "/canonical" : server.root;
      const canonicalPath = server.protocol === "sftp" ? path.posix.join(canonicalRoot, relative) : remotePath;
      const parent = path.posix.dirname(canonicalPath);
      if (kind === "absent") return { type: "absent", path: canonicalPath, parent, canonicalRoot };
      const data = supplied?.data ?? Buffer.from(`remote:${relative}`);
      if (data.length > maxBytes) throw appError("TRANSFER_LIMIT", "runtime.transfer.byteLimit");
      return { type: "file", path: canonicalPath, parent, canonicalRoot, bytes: data.length,
        sha256: sha256(data), ...(server.protocol === "sftp" ? { mode: supplied?.mode ?? 0o644 } : {}) };
    },
  };
}
