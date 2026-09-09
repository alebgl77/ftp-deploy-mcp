import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { manifest, scenarios } from "./scenarios.mjs";
import { inside, TEST_SECRET } from "./fixture.mjs";
import { directoryPath, prepareWorkPaths } from "./work-paths.mjs";
import { validateCIReport } from "./validate-report.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const checkout = fs.realpathSync(path.resolve(root, "../.."));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const options = { repo: checkout, locale: "both", caseBudgetMs: 8000, suiteBudgetMs: 180000, verifyRuntimeLocale: "true", ci: "false" };
let argumentFailure = null;
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index]; const value = process.argv[++index];
  const names = { "--repo": "repo", "--locale": "locale", "--output": "output", "--work-dir": "workDir", "--case": "case", "--probe": "probe", "--case-budget-ms": "caseBudgetMs", "--suite-budget-ms": "suiteBudgetMs", "--verify-runtime-locale": "verifyRuntimeLocale", "--ci": "ci" };
  if (!names[key] || value === undefined) { argumentFailure = "INVALID_ARGUMENTS"; break; }
  options[names[key]] = names[key].endsWith("Ms") ? Number(value) : value;
}
const start = performance.now();
const report = {
  schema_version: 1, status: "FAIL", executor: "scripted", agentDecision: "NOT_EVALUATED", provider: null, providerUsage: null, tokens: null,
  labels: { title: { en: "Scripted MCP conformance report", fr: "Rapport de conformité MCP scriptée" }, limitation: { en: "Real MCP handlers and SDK; simulated remote filesystem. No LLM evaluation or production qualification.", fr: "Vrais handlers MCP et SDK ; système de fichiers distant simulé. Aucune évaluation LLM ni qualification de production." } },
  scope: options.case ? "DIAGNOSTIC_SUBSET" : "SCRIPTED_CURRENT_RUNTIME_SUBSET", fixture: "in-memory remote adapter plus isolated real local files",
  results: [], preconditionFailure: null, cleanupComplete: true,
  requested_locale: options.locale, runtime_locale_verified: false,
};
let fixturesRoot;
function safeOutput() {
  const paths = prepareWorkPaths(checkout, options.workDir, options.output);
  options.workDir = paths.workDir; options.output = paths.output; fixturesRoot = paths.fixturesRoot;
}
function sourceState(repo) {
  for (const file of ["package.json", "package-lock.json", "src/tools.js", "src/config.js", "src/transfers.js", "src/i18n.js"]) if (!fs.existsSync(path.join(repo, file))) throw new Error("SOURCE_MISSING");
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("SOURCE_SYMLINK_UNSUPPORTED");
      if (entry.isDirectory()) walk(absolute);
      else files.push({ file: path.relative(repo, absolute).replaceAll(path.sep, "/"), sha256: hash(fs.readFileSync(absolute)) });
    }
  }
  walk(path.join(repo, "src"));
  for (const file of ["package.json", "package-lock.json"]) files.push({ file, sha256: hash(fs.readFileSync(path.join(repo, file))) });
  return files;
}
function failRecord(entry, locale, code, durationMs = null) {
  return { schema_version: 1, scenarioID: entry.id, title: entry.title, relatedSpecIDs: entry.relatedSpecIDs, locale, scenario_locale: locale, requested_locale: locale, runtime_locale_verified: false, pre_connection_refusal: entry.pre_connection_refusal ?? null, connections_opened: null, status: "FAIL", executor: "scripted", agentDecision: "NOT_EVALUATED", failureCode: code, assertions: [], mutationAttempts: null, effectsCount: null, metrics: { durationMs, tokens: null, providerUsage: null }, fixtureObservationsAvailable: false };
}
async function execute(entry, locale, budget) {
  const caseRoot = inside(fixturesRoot, path.join(fixturesRoot, `${entry.id}-${locale}-${randomUUID()}`));
  fs.mkdirSync(caseRoot, { recursive: true });
  const childStart = performance.now();
  let output = ""; let excessive = false; let expired = false;
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "worker.mjs"), options.repo, caseRoot, entry.id, locale, options.probe ?? "", options.verifyRuntimeLocale], {
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: caseRoot,
        env: { SystemRoot: process.env.SystemRoot ?? "", WINDIR: process.env.WINDIR ?? "", PATH: process.env.PATH ?? "", HOME: caseRoot, USERPROFILE: caseRoot, TEMP: caseRoot, TMP: caseRoot, FTP_MCP_LANG: locale },
      });
      const timer = setTimeout(() => { expired = true; child.kill(); }, budget);
      child.stdout.on("data", (chunk) => { output += chunk.toString(); if (Buffer.byteLength(output) > 128 * 1024) { excessive = true; child.kill(); } });
      child.stderr.on("data", () => {}); // Never persist unsanitized child diagnostics.
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (expired || excessive) return failRecord(entry, locale, expired ? "CASE_BUDGET_EXCEEDED" : "REPORT_SIZE_EXCEEDED", performance.now() - childStart);
    let result;
    try { result = JSON.parse(output); } catch { return failRecord(entry, locale, "WORKER_REPORT_INVALID", performance.now() - childStart); }
    if (result.scenarioID !== entry.id || result.locale !== locale || !["PASS", "FAIL", "NOT_RUN"].includes(result.status) || (code !== 0 && result.status !== "FAIL")) return failRecord(entry, locale, "WORKER_EXIT_MISMATCH", performance.now() - childStart);
    if (result.status === "PASS" && (!result.assertions?.length || result.assertions.some((item) => item.passed !== true))) return failRecord(entry, locale, "FALSE_PASS_REJECTED", performance.now() - childStart);
    result.metrics.processElapsedMs = performance.now() - childStart;
    return result;
  } finally {
    try {
      // Revalidation failures and removal failures have the same truthful flag.
      directoryPath(checkout, fixturesRoot);
      directoryPath(checkout, caseRoot);
      inside(fixturesRoot, caseRoot);
      const remove = options.probe === "cleanup-failure"
        ? () => { throw Object.assign(new Error("TEST_ONLY_CLEANUP_SECRET " + caseRoot), { code: "EBUSY" }); }
        : fs.rmSync;
      remove(caseRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      if (fs.existsSync(caseRoot)) throw new Error("FIXTURE_CLEANUP_FAILED");
    } catch {
      report.cleanupComplete = false;
      throw new Error("FIXTURE_CLEANUP_FAILED");
    }
  }
}
try {
  safeOutput();
  if (argumentFailure) throw new Error(argumentFailure);
  if (!['en', 'fr', 'both'].includes(options.locale)) throw new Error("INVALID_LOCALE");
  if (!["true", "false"].includes(options.verifyRuntimeLocale)) throw new Error("INVALID_LOCALIZATION_MODE");
  if (!["true", "false"].includes(options.ci)) throw new Error("INVALID_CI_MODE");
  if (options.ci === "true" && (options.locale !== "both" || options.verifyRuntimeLocale !== "true")) throw new Error("CI_OPTIONS_REQUIRED");
  for (const [value, min, max] of [[options.caseBudgetMs, 100, 10000], [options.suiteBudgetMs, 100, 240000]]) if (!Number.isInteger(value) || value < min || value > max) throw new Error("INVALID_BUDGET");
  if (options.probe && !["assertion-failure", "invalid-fixture-config", "deadline", "missing-localization-catalog", "unavailable-fixture", "cleanup-failure"].includes(options.probe)) throw new Error("INVALID_PROBE");
  if (options.probe && !options.case) throw new Error("PROBE_REQUIRES_SINGLE_CASE");
  options.repo = path.resolve(options.repo);
  const before = sourceState(options.repo);
  let snapshot = null;
  const snapshotFile = path.join(options.repo, "evaluation-snapshot.json");
  if (fs.existsSync(snapshotFile)) {
    snapshot = JSON.parse(fs.readFileSync(snapshotFile));
    for (const item of snapshot.files) if (!before.some((file) => file.file === item.file && file.sha256 === item.sha256)) throw new Error("SNAPSHOT_HASH_MISMATCH");
  }
  let commit = snapshot?.commit ?? null;
  if (!commit) { try { commit = execFileSync("git", ["-C", options.repo, "rev-parse", "HEAD"], { windowsHide: true, encoding: "utf8" }).trim(); } catch {} }
  const require = createRequire(path.join(options.repo, "package.json"));
  const sdkPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  let sdkRoot = path.dirname(sdkPath);
  while (!fs.existsSync(path.join(sdkRoot, "package.json")) || JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"))).name !== "@modelcontextprotocol/sdk") {
    const parent = path.dirname(sdkRoot); if (parent === sdkRoot) throw new Error("SDK_PACKAGE_MISSING"); sdkRoot = parent;
  }
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json")));
  const specPath = path.join(checkout, "test/fixtures/evaluation/corpus.spec.json");
  const specBytes = fs.readFileSync(specPath);
  const spec = JSON.parse(specBytes);
  if (spec.scenarios.length !== 48 || spec.scenarios.some((scenario) => scenario.execution_status !== "NOT_RUN")) throw new Error("SPEC_STATE_CHANGED");
  report.provenance = { sourceCommit: commit, sourceFiles: before, sourceStableDuringRun: null, immutableSnapshot: Boolean(snapshot), node: process.version, platform: process.platform, sdk: sdkPackage.version, lockfileSha256: hash(fs.readFileSync(path.join(options.repo, "package-lock.json"))) };
  let trackedRuntimeModified = false;
  let runtimeStatus = [];
  if (!snapshot) {
    const status = execFileSync("git", ["-C", options.repo, "status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json"], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    runtimeStatus = status.trim() ? status.trimEnd().split(/\r?\n/) : [];
    trackedRuntimeModified = runtimeStatus.length > 0;
  }
  report.provenance.baseCommit = commit;
  report.provenance.sourceState = snapshot ? "IMMUTABLE_SNAPSHOT" : trackedRuntimeModified ? "WORKTREE_MODIFIED" : "CLEAN_CHECKOUT";
  report.provenance.referenceLabel = `BASE${commit?.slice(0, 7) ?? "UNKNOWN"}+${report.provenance.sourceState}`;
  report.provenance.runtimeGitStatus = runtimeStatus;
  if (snapshot?.origin) {
    report.provenance.snapshotOrigin = snapshot.origin;
    report.provenance.referenceLabel = `BASE${commit.slice(0, 7)}+${snapshot.origin.sourceState}+IMMUTABLE_SNAPSHOT`;
  }
  report.provenance.harnessFiles = fs.readdirSync(root).filter((file) => file.endsWith(".mjs")).sort().map((file) => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
  report.expectationCorrections = { file: "scripts/evaluation/expectation-corrections.json", sha256: hash(fs.readFileSync(path.join(root, "expectation-corrections.json"))), initialPass: 74, initialFail: 6 };
  report.localeInterpretation = options.verifyRuntimeLocale === "true"
    ? { en: "Checks actual advertised metadata and sampled business success/error text against both catalogs. The run flag requires complete metadata plus at least two success and two error samples per requested locale; per-scenario flags require a business-text sample. Unsampled messages are not qualified.", fr: "Vérifie les métadonnées annoncées et des textes métier de réussite/erreur contre les deux catalogues. L’indicateur global exige toutes les métadonnées et au moins deux réussites et deux erreurs par langue ; un indicateur par scénario exige un échantillon métier. Les messages non échantillonnés ne sont pas qualifiés." }
    : { en: "Locale is requested, not verified. This run does not qualify business localization.", fr: "La langue est demandée, sans être vérifiée. Cette exécution ne qualifie pas la traduction métier." };
  report.specification = { sha256: hash(specBytes), scenarioCount: 48, status: "NOT_RUN", realModelScenarioCount: spec.scenarios.filter((scenario) => scenario.modes.includes("real_model")).length, realModelStatus: "NOT_RUN", scenarios: spec.scenarios.map((scenario) => ({ scenarioID: scenario.id, title: scenario.title, status: "NOT_RUN", reason: "FULL_SPEC_VARIANTS_AND_MODEL_MODES_NOT_EXECUTED", relatedScriptedSubsetIDs: scenarios.filter((entry) => entry.relatedSpecIDs.includes(scenario.id)).map((entry) => entry.id) })) };
  const selected = options.case ? scenarios.filter((entry) => entry.id === options.case) : scenarios;
  if (!selected.length || selected.length > 50 || (!options.case && selected.length < 30)) throw new Error("SCENARIO_COUNT_INVALID");
  const locales = options.locale === "both" ? ["en", "fr"] : [options.locale];
  report.budgets = { scenarioMs: options.caseBudgetMs, suiteMs: options.suiteBudgetMs, maxScenarios: 50, maxCallsPerScenario: 8, maxLocalFixtureBytes: 4194304, maxWorkerReportBytes: 131072 };
  report.manifest = manifest().filter((entry) => selected.some((scenario) => scenario.id === entry.id));
  directoryPath(checkout, fixturesRoot, true);
  for (const entry of selected) for (const locale of locales) {
    const remaining = options.suiteBudgetMs - (performance.now() - start);
    if (remaining < 100) { report.results.push(failRecord(entry, locale, "SUITE_BUDGET_EXCEEDED")); continue; }
    report.results.push(await execute(entry, locale, Math.min(remaining, options.caseBudgetMs)));
  }
  report.provenance.sourceFilesAfter = sourceState(options.repo);
  report.provenance.sourceStableDuringRun = JSON.stringify(report.provenance.sourceFilesAfter) === JSON.stringify(before);
  if (!report.provenance.sourceStableDuringRun) throw new Error("SOURCE_CHANGED_DURING_RUN");
  if (hash(fs.readFileSync(specPath)) !== report.specification.sha256) throw new Error("SPEC_CHANGED_DURING_RUN");
  const pass = report.results.filter((item) => item.status === "PASS").length;
  const fail = report.results.filter((item) => item.status === "FAIL").length;
  const notRun = report.results.filter((item) => item.status === "NOT_RUN").length;
  report.summary = { distinctScenarioCount: selected.length, localeExecutionCount: report.results.length, pass, fail, notRun, distinctPassedInEveryRequestedLocale: selected.filter((entry) => locales.every((locale) => report.results.some((result) => result.scenarioID === entry.id && result.locale === locale && result.status === "PASS"))).length };
  report.localizationSummary = locales.map((locale) => {
    const records = report.results.filter((entry) => entry.locale === locale);
    return { locale, requested: options.verifyRuntimeLocale === "true", metadataScenariosVerified: records.filter((entry) => entry.localizationEvidence?.metadataVerified).length,
      successSamples: records.reduce((sum, entry) => sum + (entry.localizationEvidence?.successSamples.length ?? 0), 0),
      errorSamples: records.reduce((sum, entry) => sum + (entry.localizationEvidence?.errorSamples.length ?? 0), 0) };
  });
  report.runtime_locale_verified = options.verifyRuntimeLocale === "true" && fail === 0 && report.localizationSummary.every((entry) => entry.metadataScenariosVerified === selected.length && entry.successSamples >= 2 && entry.errorSamples >= 2);
  report.status = fail ? "FAIL" : notRun ? "NOT_RUN" : pass ? "PASS" : "FAIL";
} catch (error) {
  report.status = "FAIL";
  const allowed = /^[A-Z][A-Z0-9_]+$/;
  report.preconditionFailure = typeof error.message === "string" && allowed.test(error.message) ? error.message : "RUNNER_PRECONDITION_FAILED";
} finally {
  report.durationMs = performance.now() - start;
  report.provider = null; report.providerUsage = null; report.tokens = null;
  if (options.ci === "true") {
    try { validateCIReport(report, { locale: options.locale }); }
    catch {
      report.status = "FAIL";
      report.runtime_locale_verified = false;
      report.preconditionFailure ??= "CI_REPORT_REJECTED";
    }
  }
  let serialized = JSON.stringify(report, null, 2) + "\n";
  if (serialized.includes(TEST_SECRET)) { report.status = "FAIL"; report.results = []; report.preconditionFailure = "REPORT_SECRET_REJECTED"; serialized = JSON.stringify(report, null, 2) + "\n"; }
  try { safeOutput(); fs.writeFileSync(options.output, serialized); }
  catch { process.stderr.write("Report destination rejected.\n"); process.exitCode = 2; }
  process.stdout.write(`${report.status}: ${report.summary?.distinctScenarioCount ?? 0} distinct scenarios; ${report.summary?.localeExecutionCount ?? 0} locale runs; scripted only.\n`);
  process.exitCode = report.status === "FAIL" || (options.ci === "true" && report.status !== "PASS") ? 1 : process.exitCode ?? 0;
}
