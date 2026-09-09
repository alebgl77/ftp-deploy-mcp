import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateCIReport, validateReport } from "../scripts/evaluation/validate-report.mjs";
import { manifest } from "../scripts/evaluation/scenarios.mjs";
import { directoryPath } from "../scripts/evaluation/work-paths.mjs";
import { inside } from "../scripts/evaluation/fixture.mjs";

const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const root = path.join(repo, "scripts/evaluation");
const workBase = path.join(repo, ".tmp/evaluations");
const harness = path.join(workBase, `harness-${randomUUID()}`);
directoryPath(repo, harness, true);
after(() => { directoryPath(repo, harness); inside(workBase, harness); fs.rmSync(harness, { recursive: true, force: true }); });
function invoke(name, args = []) {
  const workDir = path.join(harness, name);
  const output = path.join(workDir, "reports/result.json");
  const result = spawnSync(process.execPath, [path.join(root, "run.mjs"), "--repo", repo, "--locale", "en", "--case", "SCRIPT-001", "--work-dir", workDir, "--output", output, ...args], { windowsHide: true, timeout: 15000, encoding: "utf8" });
  assert.equal(result.error, undefined);
  return { result, workDir, output };
}
function run(name, args = []) {
  const { result, output, workDir } = invoke(name, args);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  validateReport(report);
  const fixtures = path.join(workDir, "fixtures");
  assert.deepEqual(fs.existsSync(fixtures) ? fs.readdirSync(fixtures) : [], [], "Controlled fixtures must be cleaned after the child exits");
  return { exitCode: result.status, report };
}
test("runner reports actual outcomes, failures and bounded cleanup", async (t) => {
  await t.test("definitions keep unique bilingual IDs and initial status separate from execution", () => {
    const definitions = manifest();
    assert.equal(definitions.length, 43);
    assert.equal(new Set(definitions.map((entry) => entry.id)).size, 43);
    for (const entry of definitions) {
      assert.ok(entry.title.en && entry.title.fr);
      assert.equal(entry.initialStatus, "NOT_RUN"); assert.equal(Object.hasOwn(entry, "status"), false);
    }
  });
  await t.test("positive real SDK case passes and measures listTools separately", () => {
    const result = run("positive");
    assert.equal(result.exitCode, 0); assert.equal(result.report.status, "PASS");
    assert.ok(result.report.results[0].metrics.listToolsResultJsonBytes > 0);
    assert.equal(result.report.results[0].metrics.toolCalls, 0);
  });
  await t.test("an injected false assertion remains FAIL with nonzero exit", () => {
    const result = run("assertion-failure", ["--probe", "assertion-failure"]);
    assert.notEqual(result.exitCode, 0); assert.equal(result.report.status, "FAIL");
    assert.equal(result.report.results[0].failureCode, "ASSERTION_FAILED");
    assert.ok(result.report.results[0].assertions.some((assertion) => assertion.passed === false));
  });
  await t.test("missing source never produces a passing scenario", () => {
    const result = run("missing-source", ["--repo", path.join(root, "absent-source")]);
    assert.notEqual(result.exitCode, 0); assert.equal(result.report.preconditionFailure, "SOURCE_MISSING");
    assert.equal(result.report.results.filter((entry) => entry.status === "PASS").length, 0);
  });
  await t.test("invalid harness config is a failed precondition", () => {
    const result = run("invalid-fixture-config", ["--probe", "invalid-fixture-config"]);
    assert.notEqual(result.exitCode, 0); assert.equal(result.report.results[0].failureCode, "FIXTURE_CONFIG_INVALID");
    assert.equal(result.report.results[0].status, "FAIL");
    assert.equal(result.report.results[0].metrics.toolCalls, 0);
  });
  await t.test("a missing business catalog cannot qualify localization", () => {
    const result = run("localization-missing", ["--verify-runtime-locale", "true", "--probe", "missing-localization-catalog"]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.report.results[0].failureCode, "LOCALIZATION_CATALOG_MISSING");
    assert.equal(result.report.runtime_locale_verified, false);
    assert.equal(result.report.results[0].metrics.toolCalls, 0);
  });
  await t.test("a nonsettling worker is terminated within the case budget", () => {
    const result = run("deadline", ["--probe", "deadline", "--case-budget-ms", "900"]);
    assert.notEqual(result.exitCode, 0); assert.equal(result.report.results[0].failureCode, "CASE_BUDGET_EXCEEDED");
    assert.equal(result.report.results[0].mutationAttempts, null);
  });
  await t.test("invalid scenario selection and invalid budget cannot pass", () => {
    for (const [name, args, code] of [["missing-scenario", ["--case", "SCRIPT-999"], "SCENARIO_COUNT_INVALID"], ["invalid-budget", ["--case-budget-ms", "0"], "INVALID_BUDGET"]]) {
      const result = run(name, args); assert.notEqual(result.exitCode, 0); assert.equal(result.report.preconditionFailure, code);
    }
  });
  await t.test("report validator rejects false PASS and invented model/token claims", () => {
    const { report } = run("validation-source");
    for (const mutate of [
      (copy) => { copy.results[0].assertions[0].passed = false; },
      (copy) => { copy.tokens = 123; },
      (copy) => { copy.agentDecision = "PASS"; },
      (copy) => { copy.specification.scenarios[20].status = "PASS"; },
      (copy) => { copy.results[0].runtime_locale_verified = true; },
      (copy) => { copy.runtime_locale_verified = true; },
      (copy) => { copy.manifest[0].status = "PASS"; },
      (copy) => { copy.provenance.sourceFilesAfter[0].sha256 = "invented"; },
    ]) { const copy = structuredClone(report); mutate(copy); assert.throws(() => validateReport(copy)); }
  });
});

test("evaluation outputs and fixtures stay within the controlled work directory", async (t) => {
  await t.test("lexical output escape cannot overwrite an existing file", () => {
    const outside = path.join(harness, "outside.json");
    fs.writeFileSync(outside, "preserve");
    const { result } = invoke("output-escape", ["--output", outside]);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
  });
  await t.test("work directory outside .tmp/evaluations is rejected", () => {
    const outside = path.join(repo, ".tmp", `rejected-${randomUUID()}`);
    const { result } = invoke("work-escape", ["--work-dir", outside, "--output", path.join(outside, "result.json")]);
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(outside), false);
  });
  await t.test("non-JSON output is rejected", () => {
    const output = path.join(harness, "extension/result.txt");
    const { result } = invoke("extension", ["--output", output]);
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(output), false);
  });
  for (const component of ["work", "reports", "fixtures"]) {
    await t.test(`linked ${component} directory is rejected without outside writes`, () => {
      const name = `linked-${component}`;
      const workDir = path.join(harness, name);
      const outside = path.join(harness, `${name}-target`);
      directoryPath(repo, outside, true);
      fs.writeFileSync(path.join(outside, "sentinel.txt"), "preserve");
      if (component !== "work") directoryPath(repo, workDir, true);
      const link = component === "work" ? workDir : path.join(workDir, component);
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const { result, output } = invoke(name);
      assert.notEqual(result.status, 0);
      assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
      assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "preserve");
      if (component === "fixtures") {
        const report = JSON.parse(fs.readFileSync(output, "utf8"));
        assert.equal(report.preconditionFailure, "WORK_PATH_REJECTED");
        assert.equal(report.results.length, 0);
      }
    });
  }
  await t.test("hard-linked output cannot overwrite another file", () => {
    const name = "hardlink";
    const reports = path.join(harness, name, "reports");
    directoryPath(repo, reports, true);
    const outside = path.join(harness, "hardlink-target.json");
    fs.writeFileSync(outside, "preserve");
    fs.linkSync(outside, path.join(reports, "result.json"));
    const { result } = invoke(name);
    assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
  });
});

test("required CI checks reject incomplete evidence and cleanup failures", async (t) => {
  // Synthetic in-memory validator inputs only, never saved as execution reports.
  // The actual 43-case suite is executed independently by the required CI step.
  const { report: diagnostic } = run("ci-validator-source");
  const definitions = manifest();
  const complete = structuredClone(diagnostic);
  complete.scope = "SCRIPTED_CURRENT_RUNTIME_SUBSET";
  complete.requested_locale = "both";
  complete.runtime_locale_verified = true;
  complete.manifest = definitions;
  complete.results = definitions.flatMap((definition) => ["en", "fr"].map((locale) => ({
    ...structuredClone(diagnostic.results[0]), scenarioID: definition.id, title: definition.title,
    locale, scenario_locale: locale, requested_locale: locale,
    pre_connection_refusal: definition.pre_connection_refusal ?? null, runtime_locale_verified: true,
    localizationEvidence: { ...diagnostic.results[0].localizationEvidence,
      successSamples: [{ matched: true, dataPreserved: true }], errorSamples: [{ matched: true, codePreserved: true }] },
  })));
  complete.summary = { distinctScenarioCount: 43, localeExecutionCount: 86, pass: 86, fail: 0, notRun: 0, distinctPassedInEveryRequestedLocale: 43 };
  complete.localizationSummary = ["en", "fr"].map((locale) => ({ locale, requested: true, metadataScenariosVerified: 43, successSamples: 43, errorSamples: 43 }));
  await t.test("strict validator accepts the complete format only with explicit CI options", () => {
    assert.equal(validateCIReport(complete, { locale: "both" }), true);
    assert.throws(() => validateCIReport(complete));
    assert.throws(() => validateCIReport(complete, { locale: "en" }));
  });
  const mutations = [
    ["NOT_RUN", (copy) => { copy.status = "NOT_RUN"; copy.runtime_locale_verified = false; copy.results[0].status = "NOT_RUN"; copy.results[0].runtime_locale_verified = false; }],
    ["all French rows removed with localization verification disabled", (copy) => { copy.results = copy.results.filter((entry) => entry.locale === "en"); copy.runtime_locale_verified = false; copy.summary.localeExecutionCount = 43; copy.summary.pass = 43; }],
    ["a scenario omitted from both results and supplied manifest", (copy) => { copy.results = copy.results.filter((entry) => entry.scenarioID !== "SCRIPT-043"); copy.manifest = copy.manifest.filter((entry) => entry.id !== "SCRIPT-043"); copy.runtime_locale_verified = false; copy.summary.distinctScenarioCount = 42; }],
    ["a duplicated row", (copy) => { copy.results[0] = structuredClone(copy.results[2]); }],
    ["an invented scenario mirrored in the supplied manifest", (copy) => { for (const entry of copy.results) if (entry.scenarioID === "SCRIPT-043") entry.scenarioID = "SCRIPT-999"; copy.manifest.at(-1).id = "SCRIPT-999"; }],
    ["forged summary counts", (copy) => { copy.summary.localeExecutionCount = 1; copy.summary.pass = 1; copy.summary.distinctPassedInEveryRequestedLocale = 0; }],
    ["runtime locale verification false", (copy) => { copy.runtime_locale_verified = false; }],
    ["runtime locale verification not requested", (copy) => { copy.localizationSummary[0].requested = false; }],
    ["diagnostic scope", (copy) => { copy.scope = "DIAGNOSTIC_SUBSET"; }],
    ["unstable sources", (copy) => { copy.provenance.sourceStableDuringRun = false; }],
    ["cleanup failure", (copy) => { copy.cleanupComplete = false; copy.status = "FAIL"; copy.runtime_locale_verified = false; }],
  ];
  for (const [name, mutate] of mutations) await t.test(`strict validator rejects ${name}`, () => {
    const copy = structuredClone(complete); mutate(copy);
    assert.throws(() => validateCIReport(copy, { locale: "both" }));
  });
  await t.test("NOT_RUN is preserved diagnostically but exits nonzero in required mode", () => {
    const diagnosticResult = run("not-run-diagnostic", ["--probe", "unavailable-fixture"]);
    assert.equal(diagnosticResult.report.status, "NOT_RUN"); assert.equal(diagnosticResult.exitCode, 0);
    const required = run("not-run-ci", ["--locale", "both", "--ci", "true", "--probe", "unavailable-fixture"]);
    assert.notEqual(required.exitCode, 0);
    assert.equal(required.report.status, "FAIL"); assert.equal(required.report.preconditionFailure, "CI_REPORT_REJECTED");
    assert.equal(required.report.results.length, 2);
    assert.ok(required.report.results.every((entry) => entry.status === "NOT_RUN"));
  });
  await t.test("CLI format validation cannot substitute for required CI validation", () => {
    const { output } = invoke("ci-cli-source");
    const cli = (args) => spawnSync(process.execPath, [path.join(root, "validate-report.mjs"), output, ...args], { encoding: "utf8", windowsHide: true });
    const format = cli([]); assert.equal(format.status, 0); assert.match(format.stdout, /not a CI pass verdict/);
    const required = cli(["--ci", "true", "--locale", "both"]); assert.notEqual(required.status, 0);
  });
  await t.test("injected EBUSY leaves cleanupComplete false and no sensitive diagnostic", () => {
    const { result, output, workDir } = invoke("cleanup-failure", ["--probe", "cleanup-failure"]);
    assert.notEqual(result.status, 0);
    const serialized = fs.readFileSync(output, "utf8");
    const report = JSON.parse(serialized); validateReport(report);
    assert.equal(report.status, "FAIL"); assert.equal(report.cleanupComplete, false);
    assert.equal(report.preconditionFailure, "FIXTURE_CLEANUP_FAILED");
    assert.equal(fs.readdirSync(path.join(workDir, "fixtures")).length, 1);
    assert.ok(!serialized.includes("TEST_ONLY_CLEANUP_SECRET") && !result.stderr.includes("TEST_ONLY_CLEANUP_SECRET"));
    assert.ok(!serialized.includes(workDir));
    // The test's own after-hook cleans the deliberately retained fixture.
  });
});
