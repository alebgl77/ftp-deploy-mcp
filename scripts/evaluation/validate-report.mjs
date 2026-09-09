import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { TEST_SECRET } from "./fixture.mjs";
import { manifest } from "./scenarios.mjs";

export function validateReport(report) {
  assert.equal(report.schema_version, 1);
  assert.ok(["PASS", "FAIL", "NOT_RUN"].includes(report.status));
  assert.equal(report.executor, "scripted"); assert.equal(report.agentDecision, "NOT_EVALUATED");
  assert.equal(report.provider, null); assert.equal(report.providerUsage, null); assert.equal(report.tokens, null);
  assert.equal(typeof report.runtime_locale_verified, "boolean");
  assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
  assert.equal(typeof report.cleanupComplete, "boolean");
  if (!report.cleanupComplete) assert.equal(report.status, "FAIL");
  assert.ok(!JSON.stringify(report).includes(TEST_SECRET));
  const seen = new Set();
  for (const result of report.results) {
    assert.equal(result.schema_version, 1);
    assert.match(result.scenarioID, /^SCRIPT-\d{3}$/);
    assert.ok(["en", "fr"].includes(result.locale));
    assert.equal(result.scenario_locale, result.locale); assert.equal(result.requested_locale, result.locale);
    assert.equal(typeof result.runtime_locale_verified, "boolean");
    const evidence = result.localizationEvidence;
    if (evidence?.metadataVerified) {
      assert.equal(evidence.requested, true);
      assert.equal(evidence.toolTitles, 10); assert.equal(evidence.toolDescriptions, 10);
      assert.ok(Number.isSafeInteger(evidence.inputDescriptions) && evidence.inputDescriptions > 0);
    }
    if (result.runtime_locale_verified) {
      assert.equal(result.status, "PASS");
      assert.equal(evidence?.metadataVerified, true);
      assert.ok(evidence.successSamples.length + evidence.errorSamples.length > 0);
      assert.ok(evidence.successSamples.every((sample) => sample.matched === true && sample.dataPreserved === true));
      assert.ok(evidence.errorSamples.every((sample) => sample.matched === true && sample.codePreserved === true));
    }
    const key = `${result.scenarioID}/${result.locale}`;
    assert.ok(!seen.has(key)); seen.add(key);
    assert.equal(result.executor, "scripted"); assert.equal(result.agentDecision, "NOT_EVALUATED");
    assert.equal(result.metrics.tokens, null); assert.equal(result.metrics.providerUsage, null);
    for (const locale of ["en", "fr"]) assert.ok(result.title[locale].length > 0);
    if (result.status === "PASS") {
      assert.ok(result.assertions.length > 0);
      assert.ok(result.assertions.every((item) => item.passed === true));
      assert.equal(result.failureCode, null);
      assert.equal(result.metrics.listToolsCalls, 1);
      assert.ok(Number.isSafeInteger(result.metrics.listToolsResultJsonBytes) && result.metrics.listToolsResultJsonBytes > 0);
      assert.equal(result.advertisedToolIDs.length, 10);
      for (const field of ["mutationAttempts", "effectsCount", "connections_opened"]) assert.ok(Number.isSafeInteger(result[field]) && result[field] >= 0);
      assert.equal(result.networkAttempts, 0);
      assert.equal(result.mutationMetricScope, "remote adapter journal only");
    }
    for (const assertion of result.assertions) {
      assert.equal(typeof assertion.passed, "boolean");
      assert.ok(["boolean", "number"].includes(typeof assertion.observed));
      assert.ok(["boolean", "number"].includes(typeof assertion.expected));
      assert.ok(assertion.label.en && assertion.label.fr);
    }
    if (["SCRIPT-017", "SCRIPT-018", "SCRIPT-019"].includes(result.scenarioID)) assert.equal(result.pre_connection_refusal, false);
  }
  if (report.specification) {
    assert.equal(report.specification.scenarioCount, 48);
    assert.equal(report.specification.realModelScenarioCount, 24);
    assert.equal(report.specification.realModelStatus, "NOT_RUN");
    assert.equal(report.specification.scenarios.length, 48);
    assert.ok(report.specification.scenarios.every((entry) => entry.status === "NOT_RUN"));
    assert.equal(new Set(report.specification.scenarios.map((entry) => entry.scenarioID)).size, 48);
  }
  for (const definition of report.manifest ?? []) {
    if (Object.hasOwn(definition, "initialStatus")) {
      assert.equal(definition.initialStatus, "NOT_RUN");
      assert.equal(Object.hasOwn(definition, "status"), false, "Definition status must not be confused with execution status");
    } else {
      // Preserve validation of immutable historical reports using the old field.
      // This is a definition marker, never an execution verdict.
      assert.equal(definition.status, "NOT_RUN");
    }
  }
  if (report.status === "PASS") {
    assert.equal(report.preconditionFailure, null);
    assert.equal(report.provenance.sourceStableDuringRun, true);
    assert.ok(report.results.length > 0 && report.results.every((entry) => entry.status === "PASS"));
    assert.equal(report.summary.fail, 0);
    const distinct = new Set(report.results.map((result) => result.scenarioID)).size;
    assert.equal(report.summary.distinctScenarioCount, distinct);
    if (report.scope !== "DIAGNOSTIC_SUBSET") assert.ok(distinct >= 30 && distinct <= 50);
  }
  if (report.preconditionFailure) assert.equal(report.status, "FAIL");
  if (report.provenance?.sourceFilesAfter && report.provenance.sourceStableDuringRun) {
    assert.deepEqual(report.provenance.sourceFilesAfter, report.provenance.sourceFiles);
  }
  if (report.provenance?.sourceState === "WORKTREE_MODIFIED") {
    assert.equal(report.provenance.immutableSnapshot, false);
    assert.equal(report.provenance.referenceLabel, `BASE${report.provenance.baseCommit.slice(0, 7)}+WORKTREE_MODIFIED`);
    assert.ok(report.provenance.runtimeGitStatus.length > 0);
  }
  if (report.provenance?.snapshotOrigin) {
    const origin = report.provenance.snapshotOrigin;
    assert.equal(report.provenance.immutableSnapshot, true);
    assert.equal(report.provenance.sourceState, "IMMUTABLE_SNAPSHOT");
    assert.equal(origin.baseCommit, report.provenance.baseCommit);
    assert.equal(origin.sourceState, "WORKTREE_MODIFIED");
    assert.ok(origin.runtimeGitStatus.length > 0);
    assert.equal(report.provenance.referenceLabel, `BASE${origin.baseCommit.slice(0, 7)}+WORKTREE_MODIFIED+IMMUTABLE_SNAPSHOT`);
    assert.deepEqual(origin.sourceFilesBeforeCapture, origin.sourceFilesAfterCapture);
    assert.deepEqual(origin.sourceFilesAfterCapture, report.provenance.sourceFiles);
  }
  if (report.runtime_locale_verified) {
    assert.equal(report.status, "PASS");
    const locales = report.requested_locale === "both" ? ["en", "fr"] : [report.requested_locale];
    assert.deepEqual(report.localizationSummary.map((entry) => entry.locale), locales);
    for (const locale of locales) {
      const records = report.results.filter((entry) => entry.locale === locale);
      const summary = report.localizationSummary.find((entry) => entry.locale === locale);
      assert.equal(summary.requested, true);
      assert.ok(records.length > 0 && records.every((entry) => entry.localizationEvidence?.metadataVerified));
      assert.equal(summary.metadataScenariosVerified, records.length);
      for (const field of ["successSamples", "errorSamples"]) {
        const samples = records.flatMap((entry) => entry.localizationEvidence[field]);
        assert.equal(summary[field], samples.length);
        assert.ok(samples.length >= 2 && samples.every((sample) => sample.matched === true));
      }
    }
  }
  return true;
}

// Format validation supports historical/diagnostic reports. CI is a separate
// completion gate whose expected rows come from this runner, not its report.
export function validateCIReport(report, { locale } = {}) {
  assert.equal(locale, "both", "CI explicitly requires both languages");
  validateReport(report);
  const definitions = manifest();
  assert.equal(definitions.length, 43);
  const ids = definitions.map((entry) => entry.id).sort();
  assert.equal(new Set(ids).size, 43);
  const expectedRows = ids.flatMap((id) => ["en", "fr"].map((language) => `${id}/${language}`)).sort();
  assert.equal(report.status, "PASS");
  assert.equal(report.scope, "SCRIPTED_CURRENT_RUNTIME_SUBSET");
  assert.equal(report.requested_locale, locale);
  assert.equal(report.runtime_locale_verified, true);
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.provenance.sourceStableDuringRun, true);
  assert.ok(Array.isArray(report.provenance.sourceFiles) && report.provenance.sourceFiles.length > 0);
  assert.deepEqual(report.provenance.sourceFilesAfter, report.provenance.sourceFiles);
  assert.deepEqual(report.manifest.map((entry) => entry.id).sort(), ids);
  assert.deepEqual(report.results.map((entry) => `${entry.scenarioID}/${entry.locale}`).sort(), expectedRows);
  assert.ok(report.results.every((entry) => entry.status === "PASS"));
  const count = (status) => report.results.filter((entry) => entry.status === status).length;
  assert.deepEqual(report.summary, {
    distinctScenarioCount: new Set(report.results.map((entry) => entry.scenarioID)).size,
    localeExecutionCount: report.results.length, pass: count("PASS"), fail: count("FAIL"), notRun: count("NOT_RUN"),
    distinctPassedInEveryRequestedLocale: ids.filter((id) => ["en", "fr"].every((language) => report.results.some((entry) => entry.scenarioID === id && entry.locale === language && entry.status === "PASS"))).length,
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [file, ...args] = process.argv.slice(2);
    assert.ok(file, "A report path is required");
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      assert.ok(["--ci", "--locale"].includes(args[index]) && args[index + 1] !== undefined);
      assert.equal(options[args[index]], undefined, "Duplicate validator option");
      options[args[index]] = args[index + 1];
    }
    assert.ok(options["--ci"] === undefined || ["true", "false"].includes(options["--ci"]));
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    if (options["--ci"] === "true") {
      validateCIReport(report, { locale: options["--locale"] });
      console.log("CI requirements passed: 43 scenarios, 86 EN/FR PASS; scripted only.");
    } else {
      assert.equal(options["--locale"], undefined, "Locale requirements belong to CI mode");
      validateReport(report);
      console.log(`Report format valid: ${report.status}; ${report.results.length} records; not a CI pass verdict.`);
    }
  } catch {
    process.stderr.write("Report validation rejected.\n"); process.exitCode = 1;
  }
}
