import assert from "node:assert/strict";
import fs from "node:fs";
import * as nodeModule from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createI18n } from "../src/i18n.js";
import { registerTools } from "../src/tools.js";
import { utf8Size, truncateUtf8, MAX_RESULT_BYTES } from "../src/tool-registry.js";
import { budgetFixtures, loadBudgetFunctions } from "../scripts/benchmark-agent-performance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
const STRUCTURED_SAMPLE_BUDGET = 22000, DEPLOY_SAMPLE_LIMIT = 100;
const boundedString = (value, maxBytes = 2048, i18n = createI18n()) => truncateUtf8(value == null ? "" : value, maxBytes, i18n.t("error.truncated"));
const projectedListEntry = (entry, i18n) => ({
  name: boundedString(entry.name, 2048, i18n),
  type: entry.type === "dir" || entry.type === "link" ? entry.type : "file",
  size_bytes: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0,
  modified_at: entry.modifiedAt ? boundedString(entry.modifiedAt, 512, i18n) : null,
});

// Frozen reference algorithms from the pre-optimization implementation.
const legacy = {
  fitListServerSamples: function fitListServerSamples(servers, errors, serverTotal = servers.length, errorTotal = errors.length) {
    const serverSample = servers.slice(0, 20), errorSample = errors.slice(0, 20);
    while ((serverSample.length > 0 || errorSample.length > 0) && utf8Size({ servers: serverSample, errors: errorSample }) > STRUCTURED_SAMPLE_BUDGET) {
      if (errorSample.length > 0) errorSample.pop(); else serverSample.pop();
    }
    return { servers: serverSample, serversOmitted: serverTotal - serverSample.length,
      errors: errorSample, errorsOmitted: errorTotal - errorSample.length };
  },
  fitListPage: function fitListPage(meta, entries, i18n) {
    const page = [];
    for (const entry of entries) {
      page.push(projectedListEntry(entry, i18n));
      if (page.length > 1 && utf8Size({ ...meta, entries: page }) > STRUCTURED_SAMPLE_BUDGET) { page.pop(); break; }
    }
    return page;
  },
  boundedDeploySamples: function boundedDeploySamples(items, project = (item) => item, i18n = createI18n()) {
    const sample = items.slice(0, DEPLOY_SAMPLE_LIMIT).map((item) => {
      const projected = project(item);
      return { path: boundedString(projected.path, 2048, i18n),
        size_bytes: typeof projected.size_bytes === "number" && projected.size_bytes >= 0 ? projected.size_bytes : 0 };
    });
    while (sample.length > 1 && utf8Size(sample) > STRUCTURED_SAMPLE_BUDGET) sample.pop();
    return { sample, omitted: items.length - sample.length };
  },
};
const current = loadBudgetFunctions();

for (const locale of ["en", "fr"]) {
  test(`exact budget results match legacy for escapes, Unicode, empty and oversized samples (${locale})`, () => {
    const i18n = createI18n(locale);
    for (const fixture of budgetFixtures(locale)) {
      assert.deepEqual(current[fixture.method](...fixture.args), legacy[fixture.method](...fixture.args));
    }
    const texts = ["", "x", 'é🙂\\"\n\t\u0000\ud800', "[REDACTED]", "x".repeat(30000)];
    for (const text of texts) {
      for (const count of [0, 1, 2, 9, 20, 21, 99, 100, 101, 200]) {
        const entries = Array.from({ length: count }, (_, i) => ({ name: `${i}-${text}`, type: i % 2 ? "dir" : "unknown", size: i % 2 ? -1 : i, modifiedAt: text }));
        for (const meta of [{}, { path: text, total: 200, offset: 91, limit: 200, security_warning: text }]) {
          assert.deepEqual(current.fitListPage(meta, entries, i18n), legacy.fitListPage(meta, entries, i18n));
        }
        const samples = entries.map((entry) => ({ path: entry.name, size_bytes: entry.size }));
        assert.deepEqual(current.boundedDeploySamples(samples, undefined, i18n), legacy.boundedDeploySamples(samples, undefined, i18n));
        assert.deepEqual(current.fitListServerSamples(samples, entries, count + 13, count + 29), legacy.fitListServerSamples(samples, entries, count + 13, count + 29));
      }
    }
  });
}

test("list prefix honors the exact 22000-byte boundary and retains the first oversized entry", () => {
  const i18n = createI18n(), entries = [{ name: "a" }, { name: 'é🙂\\"\n' }];
  const meta = { path: "" }, projected = entries.map((entry) => projectedListEntry(entry, i18n));
  const padding = STRUCTURED_SAMPLE_BUDGET - utf8Size({ ...meta, entries: projected });
  for (const delta of [-1, 0, 1]) {
    meta.path = "x".repeat(padding + delta);
    const result = current.fitListPage(meta, entries, i18n);
    assert.deepEqual(result, legacy.fitListPage(meta, entries, i18n));
    assert.equal(result.length, delta <= 0 ? 2 : 1);
  }
  assert.equal(current.fitListPage({ path: "x".repeat(30000) }, entries, i18n).length, 1);
});

test("budgeting leaves inputs unchanged and projects only the accepted prefix plus one", () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ name: `${i}-${"x".repeat(2048)}`, type: "file" }));
  const snapshot = structuredClone(entries);
  let reads = 0;
  const counted = entries.map((entry) => ({ ...entry, get name() { reads++; return entry.name; } }));
  const result = current.fitListPage({}, counted, createI18n());
  assert.equal(reads, result.length + 1);
  assert.deepEqual(entries, snapshot);
  const samples = entries.map((entry) => ({ path: entry.name, size_bytes: 1 }));
  const sampleSnapshot = structuredClone(samples);
  current.boundedDeploySamples(samples);
  current.fitListServerSamples(samples, samples);
  assert.deepEqual(samples, sampleSnapshot);
});

test("sizing serializes each list candidate once instead of every growing prefix", () => {
  let bytes = 0, calls = 0;
  const measured = loadBudgetFunctions(root, (value) => { calls++; const size = utf8Size(value); bytes += size; return size; });
  const fixture = budgetFixtures()[0];
  const result = measured.fitListPage(...fixture.args);
  assert.equal(calls, result.length + 2, "empty envelope, accepted entries, first excluded entry");
  assert.ok(bytes < 25000, `unexpected repeated serialization: ${bytes} bytes`);
});

// Reuse production registration/rendering with only the three legacy budget
// algorithms substituted. This verifies complete localized wire results after
// redaction, final sizing, rendering, pagination and schema validation.
async function legacyRegistration() {
  let legacySource = source;
  for (const [name, fn] of Object.entries(legacy)) {
    legacySource = legacySource.replace(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"), fn.toString());
  }
  const absolute = (specifier) => specifier.startsWith(".") ? new URL(specifier, new URL("../src/tools.js", import.meta.url)).href : import.meta.resolve(specifier);
  legacySource = legacySource.replace(/from "([^"]+)"/g, (_match, specifier) => `from ${JSON.stringify(absolute(specifier))}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(legacySource).toString("base64")}`)).registerTools;
}

for (const locale of ["en", "fr"]) {
  test(`complete wire results match legacy after short-secret expansion and notices (${locale})`, async () => {
    const previous = await legacyRegistration();
    const servers = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`server-${i}-${"xé".repeat(90)}`, {
      protocol: "ftp", host: `fixture-${i}.invalid`, user: "fixture", password: "x", root: "/", allowInsecure: true,
    }]));
    const names = Object.keys(servers);
    const invalidServerNames = Array.from({ length: 24 }, (_, i) => `bad-${i}`);
    const loaded = { found: true, error: null, config: { servers }, serverNames: names, defaultServer: names[0], invalidServerNames,
      serverErrors: Object.fromEntries(invalidServerNames.map((name) => [name, 'xé🙂\\"\n'.repeat(350)])) };
    let opens = 0, closes = 0;
    const options = { i18n: createI18n(locale), openAdapter: async () => {
      opens++;
      return { async list() { return Array.from({ length: 200 }, (_, i) => ({
        name: `${String(i).padStart(3, "0")}-${'xé🙂\\"\n'.repeat(i % 3 ? 14 : 300)}`,
        type: i % 3 ? "file" : "dir", size: i, modifiedAt: "2026-09-26",
      })); }, async close() { closes++; } };
    } };
    const before = previous(null, loaded, options), after = registerTools(null, loaded, options);
    assert.deepEqual(after.list(), before.list());
    for (const [tool, args] of [["ftp_list_servers", {}], ["ftp_list", { limit: 200, offset: 0 }], ["ftp_list", { limit: 200, offset: 195 }], ["ftp_list", { offset: 999 }]]) {
      const expected = await before.call(tool, args), actual = await after.call(tool, args);
      assert.equal(actual.isError, undefined);
      assert.deepEqual(actual, expected);
      assert.ok(after.validate(tool, actual));
      assert.ok(utf8Size(actual) <= MAX_RESULT_BYTES);
      if (tool === "ftp_list" && actual.structuredContent.count) {
        assert.ok(actual.structuredContent.entries.every((entry) => entry.name.includes("[REDACTED]")));
        assert.equal(actual.structuredContent.next_offset, actual.structuredContent.has_more ? args.offset + actual.structuredContent.count : null);
      }
    }
    assert.equal(opens, 6); assert.equal(closes, opens);
  });
}

for (const protocol of ["ftp", "sftp"]) {
  for (const outcome of ["success", "cancel", "timeout"]) {
    test(`discovery and injection load no adapter; lazy ${protocol} ${outcome} keeps the connection boundary`, {
      skip: typeof nodeModule.registerHooks !== "function" ? "Module-load instrumentation requires node:module.registerHooks on a newer Node runtime" : false,
    }, () => {
      const script = `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        const protocol = ${JSON.stringify(protocol)}, outcome = ${JSON.stringify(outcome)};
        const controller = new AbortController();
        globalThis.loadedProtocols = []; globalThis.connects = 0; globalThis.closes = 0;
        globalThis.onAdapterLoad = () => { if (outcome === 'cancel') controller.abort(); };
        registerHooks({ resolve(specifier, context, next) {
          const match = specifier.match(/\\/adapters\\/(ftp|sftp)\\.js$/);
          if (!match) return next(specifier, context);
          const adapter = "globalThis.loadedProtocols.push(" + JSON.stringify(match[1]) + "); globalThis.onAdapterLoad(); " +
            (outcome === 'timeout' ? "await new Promise(resolve => setTimeout(resolve, 50)); " : "") +
            "export async function connect() { globalThis.connects++; return { list: async () => [], close: async () => { globalThis.closes++; } }; }";
          return { url: 'data:text/javascript;base64,' + Buffer.from(adapter).toString('base64'), shortCircuit: true };
        } });
        const { registerTools } = await import(${JSON.stringify(new URL("../src/tools.js", import.meta.url).href)});
        const loaded = { found: true, serverNames: ['fixture'], defaultServer: 'fixture', config: { servers: {
          fixture: { protocol, host: 'fixture.invalid', user: 'fixture', password: 'fixture-secret', root: '/',
            allowInsecure: true, allowUnknownHostKey: true, operationTimeoutMs: outcome === 'timeout' ? 5 : 2000 }
        } } };
        const registry = registerTools(null, loaded);
        assert.equal(registry.list().tools.length, 10);
        assert.equal((await registry.call('ftp_list_servers', {})).isError, undefined);
        let injectedClose = 0;
        const injected = registerTools(null, loaded, { openAdapter: async () => ({ list: async () => [], close: async () => { injectedClose++; } }) });
        assert.equal((await injected.call('ftp_list', {})).isError, undefined);
        assert.equal(injectedClose, 1); assert.deepEqual(globalThis.loadedProtocols, []);
        const result = await registry.call('ftp_list', {}, { signal: controller.signal });
        if (outcome === 'success') { assert.equal(result.isError, undefined); assert.equal(globalThis.connects, 1); assert.equal(globalThis.closes, 1); }
        else {
          assert.equal(result.structuredContent.error.code, outcome === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
          assert.equal(result.structuredContent.error.effects, 'none');
          await new Promise(resolve => setTimeout(resolve, 80));
          assert.equal(globalThis.connects, 0); assert.equal(globalThis.closes, 0);
        }
        assert.deepEqual(globalThis.loadedProtocols, [protocol]);
      `;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000, windowsHide: true, cwd: root });
      assert.equal(run.status, 0, run.stderr || run.error?.message);
    });
  }
}
