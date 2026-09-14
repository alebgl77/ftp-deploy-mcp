import assert from "node:assert/strict";
import { existsSync, lstatSync, opendirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { approvedSource, MAX_FILE_BYTES, readBoundedFile } from "./release-artifact.mjs";
import { isMain } from "./release-gate.mjs";

const MAX_PACKAGES = 2048;
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const relative = (root, target) => path.relative(root, target).split(path.sep).join("/");
const readJSON = (file) => JSON.parse(readBoundedFile(file, MAX_FILE_BYTES));
const nameOf = (key, record) => record.name ?? key.split("node_modules/").at(-1);

function resolveLocked(packages, from, name) {
  let directory = from;
  while (true) {
    if (path.posix.basename(directory) !== "node_modules") {
      const key = path.posix.join(directory, "node_modules", name);
      if (Object.hasOwn(packages, key)) return key;
    }
    if (!directory || directory === ".") return null;
    const parent = path.posix.dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}

function resolveInstalled(installRoot, from, name) {
  assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i, "Invalid dependency name");
  let directory = from;
  while (inside(installRoot, directory)) {
    if (path.basename(directory) !== "node_modules") {
      const candidate = path.join(directory, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) {
        assert.equal(realpathSync(candidate), candidate, "Installed dependency links are not qualified");
        return candidate;
      }
    }
    if (directory === installRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function dependencyEdges(record) {
  const edges = new Map();
  for (const name of Object.keys(record.dependencies ?? {})) edges.set(name, { name, optional: false, kind: "dependency" });
  for (const name of Object.keys(record.optionalDependencies ?? {})) edges.set(name, { name, optional: true, kind: "optionalDependency" });
  for (const name of Object.keys(record.peerDependencies ?? {})) {
    if (!edges.has(name)) edges.set(name, { name, optional: record.peerDependenciesMeta?.[name]?.optional === true, kind: "peer" });
  }
  return [...edges.values()];
}

function installedPackages(root, checkpoint) {
  const found = [];
  let visited = 0;
  function walk(modules) {
    if (!existsSync(modules)) return;
    assert.equal(realpathSync(modules), modules, "Installed node_modules links are not qualified");
    function directoryEntries(directory, scoped = false) {
      const handle = opendirSync(directory);
      try {
        for (let entry; (entry = handle.readSync());) {
          checkpoint();
          assert.ok(++visited <= MAX_PACKAGES * 4, "Installed directory entry bound exceeded");
          if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
          const target = path.join(directory, entry.name);
          assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "Unexpected installed package entry");
          if (!scoped && entry.name.startsWith("@")) directoryEntries(target, true);
          else {
            assert.ok(found.length < MAX_PACKAGES, "Installed package count bound exceeded");
            assert.ok(lstatSync(path.join(target, "package.json")).isFile(), "Installed package manifest is required");
            found.push(target);
            walk(path.join(target, "node_modules"));
          }
        }
      } finally { handle.closeSync(); }
    }
    directoryEntries(modules);
  }
  walk(path.join(root, "node_modules"));
  return found;
}

// Inputs are parsed data and filesystem paths only. Package code is never imported.
export function compareInstalledGraph({ pkg, lock, productRoot, installRoot }) {
  const started = performance.now();
  const checkpoint = () => assert.ok(performance.now() - started < 90000, "Installed graph deadline exceeded");
  for (const root of [productRoot, installRoot]) {
    assert.ok(path.isAbsolute(root), "Explicit absolute installation paths are required");
    assert.equal(realpathSync(root), root, "Canonical installation paths are required");
  }
  assert.ok(inside(installRoot, productRoot), "Product root must belong to its installation root");
  const report = { schemaVersion: 1, status: "FAIL", productRoot, installRoot, productionPackages: 0,
    declaredOmissions: [], ignoredDevelopment: [], differences: [] };
  const difference = (code, data) => report.differences.push({ code, ...data });
  const installedLock = readJSON(path.join(installRoot, "package-lock.json"));
  assert.equal(installedLock.lockfileVersion, 3, "Installed package-lock version 3 is required");
  const hiddenPath = path.join(installRoot, "node_modules/.package-lock.json");
  const hiddenLock = existsSync(hiddenPath) ? readJSON(hiddenPath) : null;
  const manifests = new Map();
  const manifest = (directory) => {
    if (!manifests.has(directory)) manifests.set(directory, readJSON(path.join(directory, "package.json")));
    return manifests.get(directory);
  };
  const actualRoot = manifest(productRoot);
  for (const field of ["name", "version", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (!isDeepStrictEqual(actualRoot[field], pkg[field])) difference("PRODUCT_MANIFEST_DRIFT", { field, expected: pkg[field], actual: actualRoot[field] });
  }
  const lockRecords = lock.packages;
  assert.ok(lockRecords?.[""], "Original source lock root is required");
  const queue = [{ expectedKey: "", actualRoot: productRoot }];
  const seenPairs = new Set();
  const reached = new Set([productRoot]);
  let traversedEdges = 0;

  function compareRecord(expectedKey, actualDirectory) {
    const expected = lockRecords[expectedKey];
    const actual = manifest(actualDirectory);
    const actualKey = relative(installRoot, actualDirectory);
    const name = nameOf(expectedKey, expected);
    for (const [field, value] of [["name", name], ["version", expected.version]]) {
      if (actual[field] !== value) difference("INSTALLED_MANIFEST_DRIFT", { name, expectedKey, actualKey, field, expected: value, actual: actual[field] });
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
      if (!isDeepStrictEqual(actual[field] ?? {}, expected[field] ?? {})) difference("INSTALLED_DEPENDENCY_DECLARATION_DRIFT", { name, expectedKey, actualKey, field });
    }
    for (const [label, tree] of [["package-lock", installedLock], ["hidden-lock", hiddenLock]]) {
      if (!tree) continue;
      const record = tree.packages?.[actualKey];
      if (!record) { difference("INSTALLED_LOCK_RECORD_MISSING", { name, actualKey, lock: label }); continue; }
      for (const field of ["version", "resolved", "integrity"]) {
        if (record[field] !== expected[field]) difference("INSTALLED_LOCK_DRIFT", { name, expectedKey, actualKey, lock: label, field, expected: expected[field], actual: record[field] });
      }
      if (Object.hasOwn(record, "link")) difference("INSTALLED_LOCK_LINK", { name, actualKey, lock: label });
    }
  }

  while (queue.length) {
    checkpoint();
    assert.ok(seenPairs.size < MAX_PACKAGES, "Reachable dependency graph bound exceeded");
    const current = queue.shift();
    const pair = `${current.expectedKey}\0${current.actualRoot}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const expected = lockRecords[current.expectedKey];
    for (const edge of dependencyEdges(expected)) {
      checkpoint();
      assert.ok(++traversedEdges <= MAX_PACKAGES * 8, "Dependency edge count bound exceeded");
      const expectedKey = resolveLocked(lockRecords, current.expectedKey, edge.name);
      const actualDirectory = resolveInstalled(installRoot, current.actualRoot, edge.name);
      if (!expectedKey || !actualDirectory) {
        if (edge.optional && !actualDirectory) report.declaredOmissions.push({ from: current.expectedKey, name: edge.name, kind: edge.kind,
          reason: "DECLARED_OPTIONAL_NOT_INSTALLED", os: expectedKey ? lockRecords[expectedKey].os ?? null : null, cpu: expectedKey ? lockRecords[expectedKey].cpu ?? null : null });
        else difference(!expectedKey ? "SOURCE_LOCK_DEPENDENCY_MISSING" : "REQUIRED_DEPENDENCY_MISSING", { from: current.expectedKey, name: edge.name, kind: edge.kind });
        continue;
      }
      compareRecord(expectedKey, actualDirectory);
      reached.add(actualDirectory);
      queue.push({ expectedKey, actualRoot: actualDirectory });
    }
  }

  for (const directory of installedPackages(installRoot, checkpoint)) {
    if (reached.has(directory)) continue;
    const actual = manifest(directory);
    const actualKey = relative(installRoot, directory);
    const record = installedLock.packages?.[actualKey];
    const hiddenRecord = hiddenLock?.packages?.[actualKey];
    const development = Object.entries(lockRecords).find(([key, entry]) => key && entry.dev === true && nameOf(key, entry) === actual.name
      && entry.version === actual.version && [record, ...(hiddenLock ? [hiddenRecord] : [])].every((installed) => installed?.dev === true
        && !Object.hasOwn(installed, "link") && ["version", "resolved", "integrity"].every((field) => installed[field] === entry[field])));
    if (development) report.ignoredDevelopment.push({ name: actual.name, actualKey, expectedKey: development[0], reason: "SOURCE_LOCK_DEVELOPMENT_ONLY" });
    else difference("EXTRA_INSTALLED_PACKAGE", { name: actual.name, version: actual.version, actualKey });
  }
  report.productionPackages = reached.size - 1;
  report.status = report.differences.length ? "FAIL" : "PASS";
  return report;
}

export function verifyInstalledGraph(options) {
  const source = approvedSource(options);
  const report = compareInstalledGraph({ ...source, productRoot: options.productRoot, installRoot: options.installRoot });
  return { ...report, sourceCommit: source.snapshot.commit, inventorySha256: source.inventorySha256, scope: source.snapshot.scope };
}

if (isMain(import.meta.url)) {
  const names = { "--source-root": "sourceRoot", "--inventory": "inventoryPath", "--inventory-sha256": "expectedInventorySha256",
    "--product-root": "productRoot", "--install-root": "installRoot", "--output": "output" };
  const options = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (key === "--source-only") { assert.ok(!options.sourceOnly, "Duplicate scope option"); options.sourceOnly = true; continue; }
    assert.ok(names[key] && process.argv[i + 1] && !Object.hasOwn(options, names[key]), "Invalid graph verification option");
    options[names[key]] = process.argv[++i];
  }
  const report = verifyInstalledGraph(options);
  if (options.output) {
    assert.ok(path.isAbsolute(options.output), "Absolute graph report path required");
    writeFileSync(options.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
