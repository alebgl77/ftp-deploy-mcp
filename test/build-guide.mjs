import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ftp-guide-unit-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ftp-guide-unit-"));
    rmSync(directory, { recursive: true, force: true });
  });
  for (const folder of ["scripts", "site"]) mkdirSync(path.join(directory, folder));
  for (const file of ["scripts/build-guide.mjs", "site/guide.template.html", "site/i18n.json"]) {
    copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const data = JSON.parse(readFileSync(path.join(root, "site/project-data.json"), "utf8"));
  for (const content of Object.values(data.locales)) content.illustrations = [];
  const save = () => writeFileSync(path.join(directory, "site/project-data.json"), JSON.stringify(data));
  save();
  return {
    directory, data, save,
    index: path.join(directory, "site/index.html"),
    run: (...args) => spawnSync(process.execPath, [path.join(directory, "scripts/build-guide.mjs"), ...args], { cwd: directory, encoding: "utf8" }),
  };
}
function succeeds(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}
function rejected(f, pattern, ...args) {
  const before = existsSync(f.index) ? readFileSync(f.index) : null;
  const modified = before ? statSync(f.index).mtimeMs : null;
  const result = f.run(...args);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  if (before) {
    assert.deepEqual(readFileSync(f.index), before, "A rejected build must not rewrite the guide");
    assert.equal(statSync(f.index).mtimeMs, modified);
  } else assert.equal(existsSync(f.index), false);
}

test("normal and custom builds are deterministic; check verifies bytes without writes", (t) => {
  const f = fixture(t);
  const extra = path.join(f.directory, "export/guide.html");
  succeeds(f.run("--output", extra));
  const expected = readFileSync(f.index);
  assert.deepEqual(readFileSync(extra), expected);
  succeeds(f.run());
  assert.deepEqual(readFileSync(f.index), expected);
  const modified = statSync(f.index).mtimeMs;
  succeeds(f.run("--check"));
  assert.deepEqual(readFileSync(f.index), expected);
  assert.equal(statSync(f.index).mtimeMs, modified);
});

for (const locale of ["fr", "en"]) {
  test(`check rejects a missing ${locale} content key without rewriting output`, (t) => {
    const f = fixture(t);
    succeeds(f.run());
    delete f.data.locales[locale].summary;
    f.save();
    rejected(f, /Locale keys mismatch/, "--check");
  });
}

test("check rejects a missing UI translation", (t) => {
  const f = fixture(t);
  succeeds(f.run());
  const file = path.join(f.directory, "site/i18n.json");
  const ui = JSON.parse(readFileSync(file, "utf8"));
  delete ui.en.dynamic.play;
  writeFileSync(file, JSON.stringify(ui));
  rejected(f, /Locale keys mismatch/, "--check");
});

test("check rejects divergent numeric facts and delivery states", (t) => {
  const f = fixture(t);
  succeeds(f.run());
  f.data.locales.en.toolCount += 1;
  f.save();
  rejected(f, /Locale value mismatch/, "--check");
  f.data.locales.en.toolCount = f.data.locales.fr.toolCount;
  f.data.locales.en.roadmap[0].status = "invalid-status";
  f.save();
  rejected(f, /Immutable locale fact mismatch/, "--check");
});

test("check rejects stale HTML and source changes; normal build repairs the output", (t) => {
  const f = fixture(t);
  succeeds(f.run());
  writeFileSync(f.index, `${readFileSync(f.index, "utf8")}\n<!-- stale -->`);
  rejected(f, /site\/index.html is stale or modified/, "--check");
  succeeds(f.run());
  for (const content of Object.values(f.data.locales)) content.summary += " Updated.";
  f.save();
  rejected(f, /site\/index.html is stale or modified/, "--check");
  succeeds(f.run());
  succeeds(f.run("--check"));
});

test("check rejects missing output and invalid arguments without creating files", (t) => {
  const f = fixture(t);
  rejected(f, /ENOENT/, "--check");
  const extra = path.join(f.directory, "unexpected.html");
  rejected(f, /Usage:/, "--check", "--output", extra);
  assert.equal(existsSync(extra), false);
});

test("injection data stays inert JSON; check rejects an unescaped script-closing payload", (t) => {
  const f = fixture(t);
  const payload = '</script><script>globalThis.guideInjected=true</script><img src=x onerror="globalThis.guideInjected=true"> & \u2028 \u2029 $&';
  for (const content of Object.values(f.data.locales)) content.summary = payload;
  f.save();
  succeeds(f.run());
  const html = readFileSync(f.index, "utf8");
  const embedded = html.match(/<script id="project-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(embedded, /[<>&\u2028\u2029]/);
  for (const content of Object.values(JSON.parse(embedded).locales)) assert.equal(content.summary, payload);
  succeeds(f.run("--check"));
  const tampered = html.replace("\\u003c/script\\u003e", "</script>");
  assert.notEqual(tampered, html);
  writeFileSync(f.index, tampered);
  rejected(f, /site\/index.html is stale or modified/, "--check");
});

for (const files of [["TRANSFERS.md"], ["TRANSFERS.fr.md"], ["TRANSFERS.md", "TRANSFERS.fr.md"]]) {
  test(`documentation discovery validates new public documents: ${files.join(", ")}`, (t) => {
    const f = fixture(t);
    for (const directory of ["docs", "evaluations", "test/fixtures/transport", "assets/provenance"]) {
      mkdirSync(path.join(f.directory, directory), { recursive: true });
    }
    for (const file of ["check-docs.mjs", "release-artifact.mjs", "release-gate.mjs"]) {
      copyFileSync(path.join(root, "scripts", file), path.join(f.directory, "scripts", file));
    }
    for (const file of files) writeFileSync(path.join(f.directory, "docs", file), "# New document\n");
    const result = spawnSync(process.execPath, [path.join(f.directory, "scripts/check-docs.mjs")], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, files.length === 1 ? /Missing documentation language pair: docs\/TRANSFERS/ : /docs\/TRANSFERS.md: missing language link/);
  });
}
