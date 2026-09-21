import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_NODE_VERSION = "24.20.0";

export function assertReleaseToolchain(nodeVersion = process.versions.node) {
  if (nodeVersion !== RELEASE_NODE_VERSION) {
    const error = new Error(`Release tooling requires Node.js ${RELEASE_NODE_VERSION} exactly; received ${nodeVersion}. The MCP runtime still supports Node.js >=22.`);
    error.code = "ERR_RELEASE_TOOLCHAIN";
    throw error;
  }
}

export function releaseToolchainVersions() {
  assertReleaseToolchain();
  const npmCli = [
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find((file) => existsSync(file));
  if (!npmCli) throw new Error("The npm CLI bundled with the qualified Node.js distribution is required");
  const options = { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true };
  return {
    node: process.versions.node, libuv: process.versions.uv, platform: process.platform, arch: process.arch,
    npm: execFileSync(process.execPath, [npmCli, "--version"], options).trim(),
    tar: execFileSync("tar", ["--version"], options).trim(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertReleaseToolchain();
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/release-toolchain.mjs");
  console.log(JSON.stringify(releaseToolchainVersions(), null, 2));
}
