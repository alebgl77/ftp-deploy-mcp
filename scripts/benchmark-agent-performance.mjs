import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createI18n } from "../src/i18n.js";
import { truncateUtf8, utf8Size } from "../src/tool-registry.js";

const root = fileURLToPath(new URL("../", import.meta.url));

// Exercise the actual private budgeting functions without exporting them from
// the production module or requiring a live server or transfer.
export function loadBudgetFunctions(repoRoot = root, measure = utf8Size) {
  const source = fs.readFileSync(path.join(repoRoot, "src", "tools.js"), "utf8");
  const names = ["boundedString", "popSampleBytes", "fitListServerSamples", "projectedListEntry", "fitListPage", "boundedDeploySamples"];
  const functions = names.flatMap((name) => {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"));
    if (!match && name !== "popSampleBytes") throw new Error(`Missing budget function: ${name}`);
    return match ? [match[0]] : [];
  });
  return new Function("utf8Size", "truncateUtf8", "createI18n", `
    const DEPLOY_SAMPLE_LIMIT = 100, STRUCTURED_SAMPLE_BUDGET = 22000;
    ${functions.join("\n")}
    return { fitListServerSamples, fitListPage, boundedDeploySamples };
  `)(measure, truncateUtf8, createI18n);
}

export function budgetFixtures(locale = "en") {
  const i18n = createI18n(locale);
  const text = 'é🙂\\"\n\t\u0000';
  return [
    { name: `list-page/${locale}`, method: "fitListPage", args: [
      { server: "fixture", path: "/", total: 200, offset: 0, limit: 200, security_warning: null },
      Array.from({ length: 200 }, (_, i) => ({ name: `${i}-${text.repeat(12)}`, type: "file", size: i, modifiedAt: null })), i18n,
    ] },
    { name: `server-samples/${locale}`, method: "fitListServerSamples", args: [
      Array.from({ length: 20 }, (_, i) => ({ name: `${i}-${text.repeat(100)}`, host: text.repeat(100) })),
      Array.from({ length: 20 }, (_, i) => ({ server: String(i), message: text.repeat(160) })), 120, 80,
    ] },
    { name: `deploy-samples/${locale}`, method: "boundedDeploySamples", args: [
      Array.from({ length: 500 }, (_, i) => ({ path: `${i}-${text.repeat(160)}`, size_bytes: i })), undefined, i18n,
    ] },
  ];
}

function measureBudget(repoRoot, fixture, iterations) {
  let serializations = 0, serializedBytes = 0;
  const counted = loadBudgetFunctions(repoRoot, (value) => {
    const bytes = utf8Size(value); serializations++; serializedBytes += bytes; return bytes;
  });
  const output = counted[fixture.method](...fixture.args);
  const plain = loadBudgetFunctions(repoRoot);
  for (let i = 0; i < 10; i++) plain[fixture.method](...fixture.args);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) plain[fixture.method](...fixture.args);
  return { output, serializations, serializedBytes, milliseconds: +(performance.now() - start).toFixed(2) };
}

function discovery(repoRoot) {
  const moduleURL = pathToFileURL(path.join(repoRoot, "src", "tools.js")).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import * as nodeModule from 'node:module';
    import { performance } from 'node:perf_hooks';
    const modules = typeof nodeModule.registerHooks === 'function' ? new Set() : null;
    if (modules) nodeModule.registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
    const start = performance.now();
    const { registerTools } = await import(${JSON.stringify(moduleURL)});
    const registry = registerTools(null, { found: false });
    const descriptors = registry.list();
    console.log(JSON.stringify({ descriptors, milliseconds: performance.now() - start,
      modules: modules?.size ?? null, adapterModules: modules ? [...modules].filter(url => /\\/adapters\\/(ftp|sftp)\\.js$/.test(url)) : null,
      instrumentation: modules ? 'node:module.registerHooks' : 'unavailable; module counts require node:module.registerHooks' }));
  `], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (run.status !== 0) throw new Error(run.stderr || run.error?.message || "Discovery benchmark failed");
  return JSON.parse(run.stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = process.argv[2];
  const iterations = Number(process.argv[3] ?? 200);
  if (!baseline || !Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("Usage: node scripts/benchmark-agent-performance.mjs <pristine-repo-path> [iterations]");
  }
  const rows = [];
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const locale of ["en", "fr"]) {
    for (const fixture of budgetFixtures(locale)) {
      const beforeRuns = [], afterRuns = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const order = repeat % 2 ? [[root, afterRuns], [path.resolve(baseline), beforeRuns]] : [[path.resolve(baseline), beforeRuns], [root, afterRuns]];
        for (const [repoRoot, runs] of order) runs.push(measureBudget(repoRoot, fixture, iterations));
        assert.deepEqual(afterRuns[repeat].output, beforeRuns[repeat].output, fixture.name);
      }
      const metrics = (runs) => ({ serializations: runs[0].serializations, serializedBytes: runs[0].serializedBytes,
        medianMilliseconds: median(runs.map((run) => run.milliseconds)), milliseconds: runs.map((run) => run.milliseconds) });
      rows.push({ fixture: fixture.name, equivalent: true, outputBytes: utf8Size(afterRuns[0].output), before: metrics(beforeRuns), after: metrics(afterRuns) });
    }
  }
  const beforeRuns = [], afterRuns = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const order = repeat % 2 ? [[root, afterRuns], [path.resolve(baseline), beforeRuns]] : [[path.resolve(baseline), beforeRuns], [root, afterRuns]];
    for (const [repoRoot, runs] of order) runs.push(discovery(repoRoot));
    assert.deepEqual(afterRuns[repeat].descriptors, beforeRuns[repeat].descriptors, "Discovery tool contracts changed");
  }
  const discoveryMetrics = (runs) => ({ modules: runs[0].modules, adapterModules: runs[0].adapterModules,
    instrumentation: runs[0].instrumentation, medianMilliseconds: median(runs.map((run) => run.milliseconds)),
    milliseconds: runs.map((run) => run.milliseconds) });
  console.log(JSON.stringify({ node: process.version, iterations, repeats: 5, budgets: rows,
    discovery: { measured: "tools module import, registration and registry.list(); excludes stdio handshake",
      equivalent: true, before: discoveryMetrics(beforeRuns), after: discoveryMetrics(afterRuns) },
    note: "Repeated wall times alternate before/after order and are observations, not test thresholds. Counts and byte totals are deterministic per fixture." }, null, 2));
}
