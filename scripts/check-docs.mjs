import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_FILES } from "./release-artifact.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pairs = [
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md",
  "docs/RELEASE.md", "docs/SECURITY-MODEL.md", "evaluations/README.md",
  "test/fixtures/transport/README.md",
  "assets/provenance/README.md",
];
const read = (file) => readFileSync(path.join(root, file), "utf8");
const docs = ["LICENSE.fr.md", ".github/pull_request_template.md"];

for (const english of pairs) {
  const french = english.replace(/\.md$/, ".fr.md");
  for (const [file, other] of [[english, french], [french, english]]) {
    assert.ok(read(file).includes(`](./${path.basename(other)})`), `${file}: missing language link`);
    docs.push(file);
  }
}
assert.ok(read("LICENSE.fr.md").includes("](./LICENSE)"), "Missing canonical license link");
assert.ok(existsSync(path.join(root, ".github/ISSUE_TEMPLATE/bug_report.fr.yml")), "Missing French bug form");
assert.ok(existsSync(path.join(root, ".github/ISSUE_TEMPLATE/bug_report.yml")), "Missing English bug form");

let links = 0;
for (const file of docs) {
  const prose = read(file).replace(/```[\s\S]*?```/g, "");
  const references = [
    ...prose.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
    ...prose.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)="([^"]+)"/g),
  ];
  for (const [, raw] of references) {
    const repositoryPrefix = [
      "https://github.com/alebgl77/ftp-deploy-mcp/blob/main/",
      "https://raw.githubusercontent.com/alebgl77/ftp-deploy-mcp/main/",
    ].find((prefix) => raw.startsWith(prefix));
    if (!repositoryPrefix && /^(?:[a-z][a-z\d+.-]*:|#)/i.test(raw)) continue;
    const target = decodeURIComponent((repositoryPrefix ? raw.slice(repositoryPrefix.length) : raw).split("#")[0]);
    const absolute = path.resolve(root, repositoryPrefix ? "" : path.dirname(file), target);
    assert.ok(existsSync(absolute), `${file}: broken local link ${raw}`);
    if (PACKAGE_FILES.includes(file) && !repositoryPrefix) {
      const packaged = path.relative(root, absolute).split(path.sep).join("/").replace(/\/$/, "");
      assert.ok(PACKAGE_FILES.some((entry) => entry === packaged || entry.startsWith(`${packaged}/`)),
        `${file}: local link is absent from npm package: ${raw}; use a repository URL`);
    }
    links += 1;
  }
}

const englishXml = read("evaluations/read-only.xml").replaceAll("\r\n", "\n");
const frenchXml = read("evaluations/read-only.fr.xml").replaceAll("\r\n", "\n");
const skeleton = (xml) => xml.replace(/<question>[\s\S]*?<\/question>/g, "<question></question>").trim();
assert.equal(skeleton(frenchXml), skeleton(englishXml), "Evaluation tags or exact answers differ");
const questions = (xml) => [...xml.matchAll(/<question>([\s\S]*?)<\/question>/g)].map((match) => match[1]);
const enQuestions = questions(englishXml);
const frQuestions = questions(frenchXml);
assert.equal(enQuestions.length, 10, "Expected ten English evaluation questions");
assert.equal(frQuestions.length, 10, "Expected ten French evaluation questions");
for (let index = 0; index < enQuestions.length; index += 1) {
  const en = enQuestions[index];
  const fr = frQuestions[index];
  assert.notEqual(fr, en, `Question ${index + 1} is untranslated`);
  for (const pattern of [
    /\bftp_[a-z_]+\b/g,
    /\bserver\s+eval-(?:ftp|sftp)\b|\b(?:max_bytes|limit|offset)\s+\d+\b/g,
    /\/(?:[A-Za-z0-9_.-]+\/?)*/g,
    /\b\d+\b/g,
  ]) {
    const tokens = (text) => [...text.matchAll(pattern)].map((match) => match[0].trim());
    assert.deepEqual(tokens(fr), tokens(en), `Question ${index + 1}: tool, parameter, path, or number differs`);
  }
}
for (const file of ["evaluations/README.md", "evaluations/README.fr.md"]) {
  for (const [, json] of read(file).matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)) JSON.parse(json);
}
console.log(`Documentation checks passed: ${pairs.length} language pairs, ${links} local links, 10 evaluation questions.`);
