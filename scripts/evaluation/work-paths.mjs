import fs from "node:fs";
import path from "node:path";
import { inside } from "./fixture.mjs";

// The only writable evaluation root is the tooling checkout's .tmp/evaluations.
// Reject links component by component before creating or writing any child.
export function directoryPath(checkout, directory, create = false) {
  inside(checkout, directory);
  let current = checkout;
  for (const segment of path.relative(checkout, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      fs.mkdirSync(current); stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("WORK_PATH_REJECTED");
  }
  return directory;
}

export function prepareWorkPaths(checkout, requestedWorkDir, requestedOutput) {
  const base = path.join(checkout, ".tmp/evaluations");
  const workDir = inside(base, requestedWorkDir ? path.resolve(requestedWorkDir) : base);
  const output = inside(workDir, requestedOutput ? path.resolve(requestedOutput) : path.join(workDir, "reports/latest.json"));
  if (path.extname(output) !== ".json") throw new Error("OUTPUT_MUST_BE_JSON");
  directoryPath(checkout, path.dirname(output), true);
  try {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("OUTPUT_PATH_REJECTED");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { workDir, output, fixturesRoot: path.join(workDir, "fixtures") };
}
