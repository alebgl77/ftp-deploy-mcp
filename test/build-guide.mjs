import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { validateCoherence } from "../scripts/check-coherence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("guide facts stay connected to runtime tools, sources and roadmap dependencies", () => {
  const data = JSON.parse(readFileSync(path.join(root, "site/project-data.json"), "utf8"));
  assert.equal(validateCoherence(root, data).baseTools, 10);
  for (const mutate of [
    (content) => { content.toolCount += 1; },
    (content) => { content.nodes.find((node) => node.id === "state").optional = false; },
    (content) => { content.nodes[0].source = "src/missing.js"; },
    (content) => { content.roadmap[0].dependencies = [content.roadmap[0].id]; },
  ]) {
    const broken = structuredClone(data);
    mutate(broken.locales.en);
    assert.throws(() => validateCoherence(root, broken));
  }
});

test("base and durable diagrams show the right nodes, connections and text alternative", () => {
  const template = readFileSync(path.join(root, "site/guide.template.html"), "utf8");
  const declaration = template.slice(template.indexOf("  const drawArchitecture = "), template.indexOf('  for (const mode of ["current", "target"])'));
  const data = JSON.parse(readFileSync(path.join(root, "site/project-data.json"), "utf8")).locales.en;
  const element = (tag, attrs = {}, text) => ({ tag, attrs, text, children: [],
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attrs[key] = value; },
  });
  for (const architectureView of ["current", "target"]) {
    const elements = { "architecture-svg": element("svg"), "architecture-text": element("ul") };
    let selected;
    runInNewContext(`${declaration}\ndrawArchitecture();`, {
      data, language: "en", architectureView, selectedNode: "state", t: (key) => key,
      $: (id) => elements[id], s: element, el: (tag, text) => element(tag, {}, text),
      set() {}, showNode(id) { selected = id; }, document: { createTextNode: (text) => text },
    });
    const children = elements["architecture-svg"].children;
    const hasState = children.some((child) => child.attrs?.["data-node"] === "state");
    const hasEdge = children.some((child) => child.attrs?.["data-edge"] === "core-state");
    assert.equal(hasState, architectureView === "target");
    assert.equal(hasEdge, hasState, "Every displayed durable state node must connect to the core");
    assert.equal(elements["architecture-text"].children.length, hasState ? 7 : 6);
    assert.equal(selected, hasState ? "state" : "core", "Switching modes must not leave a hidden node selected");
  }
});

test("illustration URLs preserve PNG bytes and reject active content in the gallery and modal", async () => {
  const template = readFileSync(path.join(root, "site/guide.template.html"), "utf8");
  const declaration = template.split("\n").find((line) => line.trimStart().startsWith("const pngSource = "));
  assert.ok(declaration, "The shared image URL boundary must exist");
  const pngSource = runInNewContext(`${declaration}\npngSource;`);
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yWZkAAAAASUVORK5CYII=";
  assert.ok(["+", "/", "="].every((character) => base64.includes(character)), "The PNG must exercise reserved base64 characters");
  const png = `data:image/png;base64,${base64}`;
  const encoded = pngSource(png);
  assert.equal(encoded, `data:image/png;base64,${encodeURIComponent(base64)}`);
  const response = await fetch(encoded);
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(base64, "base64"), "Encoding must preserve the downloaded image bytes");
  assert.equal(bytes.length, 68);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  for (const value of [undefined, null, "", "javascript:alert(1)", "https://example.com/image.png", "data:image/svg+xml,<svg onload=alert(1)>", "data:text/html;base64,PHNjcmlwdD4=", `${png}\"><img src=x onerror=alert(1)>`, `${png}%0a`, "data:image/png;base64,"]) {
    assert.equal(pngSource(value), null, `Reject unsafe illustration URL: ${String(value)}`);
  }
  assert.equal(pngSource(`${png}\n`), null, "Line breaks must not survive the image URL boundary");
  assert.doesNotMatch(template, /\.(?:src|href)\s*=\s*illustration\.dataUrl/, "Every image and download sink must use the validated URL");
});

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
    for (const file of ["check-docs.mjs", "release-artifact.mjs", "release-gate.mjs", "release-toolchain.mjs"]) {
      copyFileSync(path.join(root, "scripts", file), path.join(f.directory, "scripts", file));
    }
    for (const file of files) writeFileSync(path.join(f.directory, "docs", file), "# New document\n");
    const result = spawnSync(process.execPath, [path.join(f.directory, "scripts/check-docs.mjs")], { encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, files.length === 1 ? /Missing documentation language pair: docs\/TRANSFERS/ : /docs\/TRANSFERS.md: missing language link/);
  });
}
