import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import picomatch from "picomatch";
import { appError, isAppError, nativeError, withSecondary } from "./errors.js";

export const SCAN_LIMITS = {
  maxScanEntries: { default: 100000, maximum: 1000000 },
  maxScanDepth: { default: 64, maximum: 256 },
};

const DEFAULT_EXCLUDES = [
  "**/node_modules/**", "**/.git/**", ".env", ".env.*", "*.log",
  ".DS_Store", "Thumbs.db", "ftp-servers.json", ".ftp-mcp-*.tmp", "**/.ftp-mcp/**",
];
// Each of these built-in patterns excludes every file below that exact
// directory component. Custom patterns and includes never establish pruning.
const PRUNED_DIRECTORIES = new Set(["node_modules", ".git", ".ftp-mcp"]);

// Preserve the two matcher groups: slash-less patterns match the basename at
// every depth; slash patterns match the complete relative path.
function compileMatcher(globs) {
  const list = Array.isArray(globs) ? globs : [];
  const withSlash = list.filter((g) => g.includes("/"));
  const withoutSlash = list.filter((g) => !g.includes("/"));
  const matchSlash = withSlash.length ? picomatch(withSlash, { dot: true }) : null;
  const matchBasename = withoutSlash.length ? picomatch(withoutSlash, { dot: true, basename: true }) : null;
  return (rel) => Boolean((matchSlash && matchSlash(rel)) || (matchBasename && matchBasename(rel)));
}

export async function selectDeployFiles(localDirAbs, include, exclude, server, operation) {
  const isExcluded = compileMatcher([...DEFAULT_EXCLUDES, ...(Array.isArray(exclude) ? exclude : [])]);
  const isIncluded = Array.isArray(include) && include.length > 0 ? compileMatcher(include) : null;
  const files = [];
  let visited = 1; // The root is charged once; descent never charges twice.
  const checkEntries = () => {
    if (visited > server.maxScanEntries) throw appError("SCAN_LIMIT", "runtime.scan.entriesLimit");
  };
  checkEntries();

  async function walk(absDir, relBase, depth) {
    let directory;
    let failure;
    try {
      operation.check();
      // Assign the handle before the post-await check, so cancellation during
      // opendir cannot leak it. A maximum of depth + 1 handles remain live.
      directory = await fs.promises.opendir(absDir, { bufferSize: 32 });
      operation.check();
      while (true) {
        operation.check();
        const entry = await directory.read();
        operation.check();
        if (entry === null) break;
        visited += 1;
        checkEntries();
        if ((visited - 1) % 256 === 0) {
          await setImmediate();
          operation.check();
        }
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(absDir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (PRUNED_DIRECTORIES.has(entry.name)) continue;
          if (depth >= server.maxScanDepth) throw appError("SCAN_LIMIT", "runtime.scan.depthLimit");
          await walk(abs, rel, depth + 1);
          operation.check();
        } else if (entry.isFile()) {
          if (isExcluded(rel) || (isIncluded && !isIncluded(rel))) continue;
          if (files.length >= server.maxDeployFiles) throw appError("TRANSFER_LIMIT", "runtime.transfer.deployFilesLimit");
          let size = 0;
          try {
            operation.check();
            size = (await fs.promises.stat(abs)).size;
          } catch {
            // Preserve selection's historical missing-stat estimate. Upload
            // revalidates confinement and actual bytes before using the file.
          }
          operation.check();
          files.push({ abs, rel, size });
        }
      }
    } catch (error) {
      failure = isAppError(error) ? error : appError("PATH_REJECTED", "runtime.tools.directoryReadFailed",
        { path: absDir, error: error.message }, { origin: "local" });
      throw failure;
    } finally {
      if (directory) {
        try { await directory.close(); }
        catch (error) {
          const closeError = nativeError(error, "local", { path: absDir });
          if (failure) throw withSecondary(failure, "runtime.scan.closeFailed", { detail: closeError });
          throw closeError;
        }
      }
    }
  }
  await walk(localDirAbs, "", 0);
  operation.check();
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return files;
}
