import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_NAME = "ftp-deploy-mcp";
export const MCP_NAME = "io.github.alebgl77/ftp-deploy-mcp";
export const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export const PRODUCTION_PINS = Object.freeze({
  "@modelcontextprotocol/sdk": "1.29.0", "basic-ftp": "6.0.1", "picomatch": "4.0.5",
  "ssh2-sftp-client": "12.1.1", "zod": "3.25.76", "zod-to-json-schema": "3.25.2",
});
export function validateDependencies(pkg, lock) {
  assert.equal(lock.lockfileVersion, 3, "package-lock.json must use lockfile version 3");
  const root = lock.packages?.[""];
  assert.ok(root, "Package lock root is required");
  for (const [label, manifest] of [["package.json", pkg], ["Package lock root", root]]) {
    for (const field of ["optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "overrides", "workspaces"]) {
      assert.ok(!Object.hasOwn(manifest, field), `${label} must not declare ${field}`);
    }
    for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepublishOnly", "prepack", "postpack", "publish", "postpublish"]) {
      assert.ok(!Object.hasOwn(manifest.scripts ?? {}, hook), `${label} must not declare the ${hook} lifecycle hook`);
    }
  }
  assert.deepEqual(pkg.dependencies, PRODUCTION_PINS, "Production dependencies must match the reviewed exact pins");
  assert.deepEqual(root.dependencies, pkg.dependencies, "Package lock root dependency mismatch");
  assert.deepEqual(root.devDependencies, pkg.devDependencies, "Package lock root development dependency mismatch");
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `Locked production dependency mismatch: ${name}`);
  }
  for (const [name, record] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(name, /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/, "Invalid locked package path");
    assert.match(record.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, `Exact locked version required: ${name}`);
    assert.ok(!Object.hasOwn(record, "link"), `Linked dependency is forbidden: ${name}`);
    assert.equal(typeof record.resolved, "string", `Registry resolution required: ${name}`);
    assert.ok(/^https:\/\/registry\.npmjs\.org\//.test(record.resolved) && !/[?#]/.test(record.resolved), `Unambiguous npm registry URL required: ${name}`);
    const url = new URL(record.resolved);
    assert.ok(url.protocol === "https:" && url.hostname === "registry.npmjs.org" && !url.port && !url.username && !url.password && !url.search && !url.hash,
      `Public HTTPS npm registry resolution required: ${name}`);
    assert.match(record.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, `SHA512 integrity required: ${name}`);
    assert.equal(`sha512-${Buffer.from(record.integrity.slice(7), "base64").toString("base64")}`, record.integrity, `Canonical SHA512 integrity required: ${name}`);
  }
}

export function validateSourceMetadata(pkg, lock, server, runtimeVersion) {
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Release version must be stable SemVer");
  assert.equal(pkg.version.trim(), pkg.version, "Release version must not contain surrounding whitespace");
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
  validateDependencies(pkg, lock);
  if (runtimeVersion !== undefined) assert.equal(runtimeVersion, pkg.version, "Runtime version mismatch");
  return { name: pkg.name, version: pkg.version, mcpName: pkg.mcpName };
}

export function validateMetadata(pkg, lock, server, ref, runtimeVersion) {
  const release = validateSourceMetadata(pkg, lock, server, runtimeVersion);
  assert.equal(ref, `refs/tags/v${pkg.version}`, "Release must run from its exact version tag");
  return release;
}

export function checkoutCommit(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  }).trim();
}

export function validateCheckout(root, release, ref, files = [], eventCommit = process.env.GITHUB_SHA) {
  assert.equal(ref, `refs/tags/v${release.version}`, "Release must run from its exact version tag");
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  }).trim();
  assert.equal(realpathSync.native(root), realpathSync.native(git(["rev-parse", "--show-toplevel"])), "Source root must be the checkout root");
  const commit = checkoutCommit(root);
  assert.match(eventCommit ?? "", /^[a-f0-9]{40}$/, "Original event commit (GITHUB_SHA) is required");
  assert.equal(commit, eventCommit, "Checked-out commit must match the original event commit");
  assert.equal(git(["rev-parse", "--verify", `${ref}^{commit}`]), commit, "Version tag must point to the checked-out commit");
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "", "Publication requires an unchanged checkout");
  if (files.length) {
    const tracked = git(["ls-files", "-z", "--", ...files]).split("\0").filter(Boolean);
    assert.deepEqual(tracked.sort(), [...files].sort(), "Every shipped file must be tracked at the release checkout");
  }
  return commit;
}

// docs/RELEASE.md requires the effective publication date at release approval, so a tag must
// never be cut while a changelog still reads "Release candidate" / "Version candidate".
export function validateChangelog(text, version, label) {
  const heading = text.split(/\r?\n/).find((line) => line.startsWith("## ["));
  assert.ok(heading, `${label}: no release section found`);
  const match = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/.exec(heading.trim());
  assert.ok(match, `${label}: newest section must read "## [x.y.z] - YYYY-MM-DD", found ${JSON.stringify(heading)}`);
  assert.equal(match[1], version, `${label}: newest section documents ${match[1]}, expected ${version}`);
  const [year, month, day] = match[2].split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  assert.ok(year > 0 && month > 0 && day > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day,
    `${label}: release date must be a valid calendar date`);
  return match[2];
}

export function readRelease(root = process.cwd(), ref = process.env.GITHUB_REF, { sourceOnly = false } = {}) {
  assert.ok(path.isAbsolute(root), "Explicit absolute source root is required");
  assert.ok(!existsSync(path.join(root, "npm-shrinkwrap.json")), "package-lock.json must be the sole lockfile");
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const server = read("server.json");
  const release = sourceOnly ? validateSourceMetadata(pkg, lock, server) : validateMetadata(pkg, lock, server, ref);
  const changelog = (file) => validateChangelog(readFileSync(path.join(root, file), "utf8"), release.version, file);
  assert.equal(changelog("CHANGELOG.fr.md"), changelog("CHANGELOG.md"), "CHANGELOG.md and CHANGELOG.fr.md must document the same release date");
  if (!sourceOnly) validateCheckout(root, release, ref);
  return { pkg, lock, server, release };
}

export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(new Set(args).size === args.length && args.every((arg) => ["--runtime", "--source-only"].includes(arg)), "Usage: node scripts/release-gate.mjs [--source-only] [--runtime]");
  const { pkg, lock, server, release } = readRelease(process.cwd(), process.env.GITHUB_REF, { sourceOnly: args.includes("--source-only") });
  if (args.includes("--runtime")) {
    const version = execFileSync(process.execPath, ["src/index.js", "--version"], { encoding: "utf8", timeout: 15000 }).trim();
    validateSourceMetadata(pkg, lock, server, version);
  }
  console.log(`${args.includes("--source-only") ? "Source-only" : "Release"} gate passed: ${release.name}@${release.version}`);
}
