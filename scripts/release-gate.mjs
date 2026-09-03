import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "ftp-deploy-mcp";
export const MCP_NAME = "io.github.alebgl77/ftp-deploy-mcp";
export const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export function validateMetadata(pkg, lock, server, ref, runtimeVersion) {
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Release version must be stable SemVer");
  assert.equal(pkg.version.trim(), pkg.version, "Release version must not contain surrounding whitespace");
  assert.equal(ref, `refs/tags/v${pkg.version}`, "Release must run from its exact version tag");
  for (const [label, actual, expected] of [
    ["package name", pkg.name, PACKAGE_NAME],
    ["mcpName", pkg.mcpName, MCP_NAME],
    ["lock name", lock.name, pkg.name],
    ["lock version", lock.version, pkg.version],
    ["lock root name", lock.packages?.[""]?.name, pkg.name],
    ["lock root version", lock.packages?.[""]?.version, pkg.version],
    ["server schema", server.$schema, SCHEMA],
    ["server name", server.name, pkg.mcpName],
    ["server version", server.version, pkg.version],
    ["package count", server.packages?.length, 1],
    ["registry type", server.packages?.[0]?.registryType, "npm"],
    ["registry URL", server.packages?.[0]?.registryBaseUrl, "https://registry.npmjs.org"],
    ["package identifier", server.packages?.[0]?.identifier, pkg.name],
    ["package version", server.packages?.[0]?.version, pkg.version],
    ["transport", server.packages?.[0]?.transport?.type, "stdio"],
    ["executable", pkg.bin?.[PACKAGE_NAME], "src/index.js"],
  ]) assert.equal(actual, expected, `Release mismatch: ${label}`);
  assert.equal(typeof server.description, "string", "Server description is required");
  assert.ok(server.description.length > 0 && server.description.length <= 100, "Server description must be 1-100 characters");
  if (runtimeVersion !== undefined) assert.equal(runtimeVersion, pkg.version, "Runtime version mismatch");
  return { name: pkg.name, version: pkg.version, mcpName: pkg.mcpName };
}

export function readRelease(root = process.cwd(), ref = process.env.GITHUB_REF) {
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const server = read("server.json");
  return { pkg, lock, server, release: validateMetadata(pkg, lock, server, ref) };
}

export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--runtime"), "Usage: node scripts/release-gate.mjs [--runtime]");
  const { pkg, lock, server, release } = readRelease();
  if (process.argv[2] === "--runtime") {
    const version = execFileSync(process.execPath, ["src/index.js", "--version"], { encoding: "utf8", timeout: 15000 }).trim();
    validateMetadata(pkg, lock, server, process.env.GITHUB_REF, version);
  }
  console.log(`Release gate passed: ${release.name}@${release.version}`);
}
