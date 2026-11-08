import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSourceMetadata } from "./release-gate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (base, file) => readFileSync(path.join(base, file), "utf8");
const json = (base, file) => JSON.parse(read(base, file));

// Facts shared by the runtime, the release metadata and the interactive guide.
// Historical evidence counts deliberately remain scoped to their own revision.
export function validateCoherence(base = root, data = json(base, "site/project-data.json")) {
  const pkg = json(base, "package.json");
  validateSourceMetadata(pkg, json(base, "package-lock.json"), json(base, "server.json"));
  const toolNames = (file) => [...read(base, file).matchAll(/\.registerTool\(\s*"(ftp_[a-z_]+)"/g)].map((match) => match[1]);
  const baseTools = toolNames("src/tools.js"), durableTools = toolNames("src/durable-tools.js");
  const allTools = [...baseTools, ...durableTools];
  assert.equal(new Set(allTools).size, allTools.length, "Duplicate MCP tool registration");
  const sourceExists = (file) => {
    assert.equal(typeof file, "string", "Source path must be text");
    const relative = path.relative(base, path.resolve(base, file));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `Source outside repository: ${file}`);
    assert.ok(existsSync(path.join(base, file)), `Missing guide source: ${file}`);
  };
  for (const [locale, content] of Object.entries(data.locales)) {
    assert.equal(content.version, pkg.version, `${locale}: guide version differs from runtime`);
    assert.equal(content.baseToolCount, baseTools.length, `${locale}: base tool count drift`);
    assert.equal(content.durableToolCount, durableTools.length, `${locale}: durable tool count drift`);
    assert.equal(content.toolCount, allTools.length, `${locale}: total tool count drift`);
    const ids = new Set(content.nodes.map((node) => node.id));
    assert.equal(ids.size, content.nodes.length, `${locale}: duplicate architecture node`);
    const state = content.nodes.find((node) => node.id === "state");
    assert.ok(state?.current && state.optional, `${locale}: durable state must be delivered and optional`);
    for (const node of content.nodes) {
      assert.equal(typeof node.optional, "boolean", `${locale}: explicit node availability required`);
      [node.source, ...(node.extraSources ?? [])].forEach(sourceExists);
    }
    content.documents.forEach((document) => sourceExists(document.path));
    const lots = new Map(content.roadmap.map((lot) => [lot.id, lot]));
    assert.equal(lots.size, content.roadmap.length, `${locale}: duplicate roadmap item`);
    const visiting = new Set(), visited = new Set();
    const visit = (id) => {
      assert.ok(lots.has(id), `${locale}: unknown roadmap dependency ${id}`);
      assert.ok(!visiting.has(id), `${locale}: roadmap cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      lots.get(id).dependencies.forEach(visit);
      visiting.delete(id); visited.add(id);
    };
    lots.forEach((_, id) => visit(id));
    for (const node of content.nodes) if (node.roadmap) assert.ok(lots.has(node.roadmap), `${locale}: missing node roadmap reference`);
    for (const scenario of content.scenarios) for (const step of scenario.steps) {
      // Some educational steps combine work packages (for example C + D).
      for (const id of step.lot.split(/\s*\+\s*/)) assert.ok(lots.has(id), `${locale}: unknown scenario work package ${id}`);
    }
  }
  let imports = 0;
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.m?js$/.test(file)) {
        for (const match of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g)) {
          assert.ok(existsSync(path.resolve(directory, match[2])), `Broken local import: ${path.relative(base, file)} -> ${match[2]}`);
          imports += 1;
        }
      }
    }
  }
  scan(path.join(base, "src"));
  return { baseTools: baseTools.length, durableTools: durableTools.length, productionDependencies: Object.keys(pkg.dependencies).length, localImports: imports };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Coherence checks passed: ${JSON.stringify(validateCoherence())}`);
}
