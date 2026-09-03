import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

function isUnsupported(err) {
  return Boolean(err && UNSUPPORTED_CODES.has(err.code));
}

function existingRestrictiveMode(fsImpl, filePath, platform) {
  if (platform === "win32") return FILE_MODE;
  try {
    const permissions = fsImpl.statSync(filePath).mode & 0o777;
    return (permissions & ~FILE_MODE) === 0 ? permissions : FILE_MODE;
  } catch (err) {
    if (err && err.code === "ENOENT") return FILE_MODE;
    throw err;
  }
}

function chmodPortable(fsImpl, filePath, mode, platform, bestEffort = false) {
  if (platform === "win32") return;
  try {
    fsImpl.chmodSync(filePath, mode);
  } catch (err) {
    if (bestEffort || isUnsupported(err)) return;
    throw err;
  }
}

function fsyncDirectory(fsImpl, dirPath, platform) {
  if (platform === "win32") return;
  let fd = null;
  let failure = null;
  try {
    fd = fsImpl.openSync(dirPath, "r");
    fsImpl.fsyncSync(fd);
  } catch (err) {
    if (!isUnsupported(err)) failure = err;
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (err) {
        if (!failure && !isUnsupported(err)) failure = err;
      }
    }
  }
  if (failure) throw failure;
}

function openUniqueTemp(fsImpl, dirPath, baseName, randomBytes) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const suffix = randomBytes(12).toString("hex");
    const tempPath = path.join(dirPath, `.${baseName}.${suffix}.tmp`);
    try {
      const fd = fsImpl.openSync(tempPath, "wx", FILE_MODE);
      return { fd, tempPath };
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
  }
  const err = new Error(`cannot allocate a unique temporary file beside ${baseName}`);
  err.code = "EEXIST";
  throw err;
}

function writeAll(fsImpl, fd, data, encoding) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(written) || written <= 0) {
      const err = new Error("atomic write made no progress");
      err.code = "EIO";
      throw err;
    }
    offset += written;
  }
}

// Atomically publish a complete file in its destination directory. Options
// prefixed with `_` are dependency-injection seams used by failure tests.
export function atomicWriteFileSync(filePath, data, options = {}) {
  const fsImpl = options._fs || fs;
  const platform = options._platform || process.platform;
  const randomBytes = options._randomBytes || crypto.randomBytes;
  const encoding = options.encoding || "utf8";
  const targetPath = path.resolve(filePath);
  const dirPath = path.dirname(targetPath);
  const finalMode = existingRestrictiveMode(fsImpl, targetPath, platform);

  const created = fsImpl.mkdirSync(dirPath, { recursive: true, mode: DIRECTORY_MODE });
  if (created !== undefined) chmodPortable(fsImpl, dirPath, DIRECTORY_MODE, platform);

  let fd = null;
  let tempPath = null;
  let renamed = false;
  try {
    ({ fd, tempPath } = openUniqueTemp(fsImpl, dirPath, path.basename(targetPath), randomBytes));
    writeAll(fsImpl, fd, data, encoding);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;

    chmodPortable(fsImpl, tempPath, FILE_MODE, platform);
    fsImpl.renameSync(tempPath, targetPath);
    renamed = true;

    // The inode was already 0600 before publication. Restoring an older,
    // stricter POSIX mode is best-effort after the atomic commit point.
    chmodPortable(fsImpl, targetPath, finalMode, platform, true);
    fsyncDirectory(fsImpl, dirPath, platform);
  } catch (err) {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch {
        /* retain the primary failure */
      }
    }
    if (tempPath && !renamed) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch (cleanupErr) {
        if (!cleanupErr || cleanupErr.code !== "ENOENT") err.cleanupError = cleanupErr;
      }
    }
    throw err;
  }
}
