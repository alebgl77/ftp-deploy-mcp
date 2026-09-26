import { assertReleaseToolchain } from "../scripts/release-toolchain.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NPM_PACKAGE_FILES, SOURCE_FILES, buildSourceArtifact, captureSourceInventory, inspectArtifact, validatePack } from "../scripts/release-artifact.mjs";

assertReleaseToolchain();

const repo = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
// npm run supplies npm_execpath. Direct node --test also works with the standard
// Windows installation and the Unix Node distributions used by actions/setup-node.
const npmCli = [process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find((file) => file && path.basename(file) === "npm-cli.js" && existsSync(file));

function npmPack(source, output) {
  assert.ok(npmCli, "A real npm CLI is required for package qualification");
  mkdirSync(output, { recursive: true });
  const bytes = execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--offline", "--json",
    "--cache", path.join(output, "cache"), "--pack-destination", output], {
    cwd: source, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const file = path.join(output, "pack.json");
  writeFileSync(file, bytes);
  return { file, pack: JSON.parse(bytes) };
}

test("real npm pack contains exactly 83 reviewed files and no lockfile", () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ftp-real-npm-pack-")));
  try {
    const inventory = captureSourceInventory(path.join(temp, "inventory.json"), { sourceRoot: repo, sourceOnly: true });
    const { file, pack } = npmPack(repo, path.join(temp, "artifact"));
    const item = validatePack(pack, inventory.snapshot.release);
    assert.equal(item.files.length, 83);
    assert.ok(!item.files.some((entry) => ["package-lock.json", "npm-shrinkwrap.json"].includes(entry.path)));
    const { record } = inspectArtifact(file, { sourceRoot: repo, sourceOnly: true, inventoryPath: inventory.inventoryPath,
      expectedInventorySha256: inventory.inventorySha256 });
    assert.equal(record.integrity, item.integrity);
    assert.equal(record.scope, "source-only");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("source installation archive includes the authoritative lock separately from npm", () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ftp-source-distribution-")));
  try {
    const inventory = captureSourceInventory(path.join(temp, "inventory.json"), { sourceRoot: repo, sourceOnly: true });
    const options = { sourceRoot: repo, sourceOnly: true, distribution: "source", inventoryPath: inventory.inventoryPath, expectedInventorySha256: inventory.inventorySha256 };
    const file = path.join(temp, "source-pack.json");
    const { item } = buildSourceArtifact(file, options);
    assert.equal(item.files.length, 84);
    assert.ok(item.files.some((entry) => entry.path === "package-lock.json"));
    assert.ok(!item.files.some((entry) => entry.path === "npm-shrinkwrap.json"));
    const { record } = inspectArtifact(file, options);
    assert.equal(record.distribution, "source");
    assert.throws(() => inspectArtifact(file, { ...options, distribution: "npm" }));
    assert.equal(SOURCE_FILES.length, NPM_PACKAGE_FILES.length + 1);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
