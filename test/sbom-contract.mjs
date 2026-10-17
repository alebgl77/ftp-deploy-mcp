import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;

function packageIdentity(name, version, source) {
  assert.equal(typeof name, "string", `${source} package name must be a string`);
  assert.match(name, PACKAGE_NAME, `${source} package name is invalid`);
  assert.equal(typeof version, "string", `${source} package version must be a string`);
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, `${source} package version is invalid`);
  return `${name}@${version}`;
}

function componentIdentity(component) {
  assert.equal(typeof component?.purl, "string", "Every SBOM component must have an npm purl");
  const match = /^pkg:npm\/(.+)@([^/?#]+)(?:\?[^#]*)?(?:#.*)?$/.exec(component.purl);
  assert.ok(match, `Invalid npm purl: ${component.purl}`);

  let name;
  let version;
  try {
    name = match[1].split("/").map(decodeURIComponent).join("/");
    version = decodeURIComponent(match[2]);
  } catch {
    assert.fail(`Invalid percent encoding in npm purl: ${component.purl}`);
  }

  const explicitName = component.group ? `${component.group}/${component.name}` : component.name;
  assert.equal(explicitName, name, `SBOM component name disagrees with its purl: ${component.purl}`);
  assert.equal(component.version, version, `SBOM component version disagrees with its purl: ${component.purl}`);
  return packageIdentity(name, version, "SBOM");
}

export function productionClosure(npmTree) {
  assert.ok(npmTree && typeof npmTree === "object" && !Array.isArray(npmTree), "npm ls output must be an object");
  assert.ok(!npmTree.problems?.length, `npm ls reported problems: ${(npmTree.problems ?? []).join(", ")}`);

  const identities = new Set();
  const visit = (dependencies) => {
    assert.ok(dependencies === undefined || (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)), "npm dependency map must be an object");
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      assert.ok(dependency && typeof dependency === "object" && !Array.isArray(dependency), `npm dependency ${name} must be an object`);
      assert.equal(dependency.missing, undefined, `npm dependency ${name} is missing`);
      assert.notEqual(dependency.invalid, true, `npm dependency ${name} is invalid`);
      assert.notEqual(dependency.extraneous, true, `npm dependency ${name} is extraneous`);
      identities.add(packageIdentity(name, dependency.version, "npm ls"));
      visit(dependency.dependencies);
    }
  };

  visit(npmTree.dependencies);
  return identities;
}

export function assertProductionSbom(bom, npmTree) {
  assert.equal(bom?.bomFormat, "CycloneDX", "SBOM format must be CycloneDX");
  assert.equal(bom.specVersion, "1.5", "SBOM specVersion must be exactly 1.5");
  assert.equal(bom.version, 1, "SBOM document version must be 1");
  assert.equal(bom.metadata?.component?.name, npmTree.name, "SBOM root name must match npm ls");
  assert.equal(bom.metadata?.component?.version, npmTree.version, "SBOM root version must match npm ls");
  assert.ok(Array.isArray(bom.components), "SBOM components must be an array");
  assert.ok(Array.isArray(bom.dependencies), "SBOM dependencies must be an array");

  const expected = productionClosure(npmTree);
  const actual = new Set(bom.components.map(componentIdentity));
  const root = packageIdentity(npmTree.name, npmTree.version, "npm ls root");
  actual.delete(root);

  const missing = [...expected].filter((identity) => !actual.has(identity)).sort();
  const extraneous = [...actual].filter((identity) => !expected.has(identity)).sort();
  assert.deepEqual(missing, [], `SBOM is missing production components: ${missing.join(", ")}`);
  assert.deepEqual(extraneous, [], `SBOM has extraneous components: ${extraneous.join(", ")}`);
  return { componentCount: expected.size };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${label} JSON at ${path}: ${error.message}`);
  }
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  assert.equal(process.argv.length, 4, "Usage: node test/sbom-contract.mjs <sbom.json> <npm-ls.json>");
  const result = assertProductionSbom(readJson(process.argv[2], "SBOM"), readJson(process.argv[3], "npm ls"));
  console.log(`Validated ${result.componentCount} production package identities against npm ls.`);
}
