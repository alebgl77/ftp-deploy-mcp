import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { appError, nativeError, withSecondary } from "./errors.js";

export const TRANSFER_LIMITS = {
  maxTransferBytes: { default: 268435456, maximum: 1099511627776 },
  maxDeployFiles: { default: 10000, maximum: 100000 },
  maxDeployBytes: { default: 1073741824, maximum: 1099511627776 },
};

export function checkTransferSize(bytes, maxBytes) {
  // Zero is an internal expected-size cap for an empty file. Configuration
  // separately requires strictly positive policy limits.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw appError("TRANSFER_LIMIT", "runtime.transfer.byteLimit");
  }
}

export function checkDeploySelection(files, server) {
  if (files.length > server.maxDeployFiles) {
    throw appError("TRANSFER_LIMIT", "runtime.transfer.deployFilesLimit");
  }
  let total = 0;
  for (const file of files) {
    checkTransferSize(file.size, server.maxTransferBytes);
    if (file.size > server.maxDeployBytes - total) {
      throw appError("TRANSFER_LIMIT", "runtime.transfer.deployBytesLimit");
    }
    total += file.size;
  }
  return total;
}

function counter(maxBytes, operation) {
  let bytes = 0;
  let failure;
  checkTransferSize(0, maxBytes);
  return {
    add(chunk) {
      operation?.check();
      try { checkTransferSize(bytes + chunk.length, maxBytes); }
      catch (error) { failure = error; throw error; }
      bytes += chunk.length;
    },
    get bytes() { return bytes; },
    get failure() { return failure; },
  };
}

function limitedStream(maxBytes, operation) {
  const count = counter(maxBytes, operation);
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    try { count.add(chunk); callback(null, chunk); } catch (error) { callback(error); }
  } });
  return { stream, count };
}

export async function hashLocalFile(localPath, maxBytes, operation) {
  operation?.check();
  const count = counter(maxBytes, operation);
  const hash = createHash("sha256");
  const input = fs.createReadStream(localPath);
  const onAbort = () => input.destroy(operation.signal.reason);
  operation?.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of input) { count.add(chunk); hash.update(chunk); }
    operation?.check();
    return { sha256: hash.digest("hex"), bytes: count.bytes };
  } catch (error) {
    throw nativeError(error, "local", { path: localPath });
  } finally {
    operation?.signal.removeEventListener("abort", onAbort);
    input.destroy();
    await finished(input).catch(() => {});
  }
}

export async function hashRemoteStream(read, maxBytes, operation) {
  const count = counter(maxBytes, operation);
  const hash = createHash("sha256");
  const sink = new Writable({ write(chunk, _encoding, callback) {
    try { count.add(chunk); hash.update(chunk); callback(); } catch (error) { callback(error); }
  } });
  sink.on("error", () => {});
  try {
    await read(sink);
    if (!sink.writableEnded) sink.end();
    await finished(sink);
    operation?.check();
    return { sha256: hash.digest("hex"), bytes: count.bytes };
  } catch (error) {
    throw count.failure || error;
  } finally {
    sink.destroy();
    await finished(sink).catch(() => {});
  }
}

export async function sendLocalStream(localPath, maxBytes, operation, send) {
  operation?.check();
  const input = fs.createReadStream(localPath);
  const { stream, count } = limitedStream(maxBytes, operation);
  const piping = pipeline(input, stream).then(() => null, (error) => error);
  let failure;
  try { await send(stream); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
  if (failure) { input.destroy(failure); stream.destroy(failure); }
  const pipeError = await piping;
  if (failure || pipeError) throw count.failure || failure || pipeError;
  operation?.check();
  return count.bytes;
}

export async function receiveLocalStream(localPath, maxBytes, operation, receive) {
  operation?.check();
  const { stream, count } = limitedStream(maxBytes, operation);
  const output = fs.createWriteStream(localPath, { mode: 0o600 });
  const piping = pipeline(stream, output).then(() => null, (error) => error);
  let failure;
  try { await receive(stream); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
  if (failure) stream.destroy(failure);
  else if (!stream.writableEnded) stream.end();
  const pipeError = await piping;
  if (failure || pipeError) throw count.failure || failure || pipeError;
  operation?.check();
  return count.bytes;
}

function sameDigest(expected, actual, maxBytes) {
  checkTransferSize(actual?.bytes, maxBytes);
  if (!/^[a-f0-9]{64}$/.test(expected?.sha256) || !/^[a-f0-9]{64}$/.test(actual?.sha256) ||
      expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
    throw appError("TRANSFER_VERIFY", "runtime.transfer.digestMismatch");
  }
}

function tempName() { return `.ftp-mcp-${randomBytes(16).toString("hex")}.tmp`; }
function failureWithCleanup(error, warning) {
  if (!warning) return error;
  return withSecondary(error, "runtime.transfer.cleanup");
}

export async function uploadVerified({ adapter, source, target, maxBytes, operation, expected }) {
  operation.check();
  expected ??= await hashLocalFile(source, maxBytes, operation);
  checkTransferSize(expected.bytes, maxBytes);
  const temporary = path.posix.join(path.posix.dirname(target), tempName());
  let owned = false;
  let uncertainCreation = false;
  let identity;
  try {
    operation.check();
    const staging = await adapter.uploadFile(source, temporary, expected.bytes, {
      staged: true,
      onCreating() { uncertainCreation = true; },
      onOwned(created) { owned = true; uncertainCreation = false; identity = created; },
    });
    operation.check();
    const actual = await adapter.hashFile(temporary, expected.bytes, { identity });
    operation.check();
    sameDigest(expected, actual, maxBytes);
    await operation.promote(expected.bytes, () => adapter.rename(temporary, target, { staged: true, mode: staging?.mode, identity }));
    owned = false;
    operation.check();
    return { bytes: expected.bytes };
  } catch (error) {
    let warning = uncertainCreation;
    if (owned) {
      try { await adapter.deleteFile(temporary, { identity }); } catch { warning = true; }
    }
    throw failureWithCleanup(error, warning);
  }
}

export async function downloadVerified({ adapter, remote, destination, maxBytes, overwrite, operation, revalidate }) {
  operation.check();
  const expected = await adapter.hashFile(remote, maxBytes);
  operation.check();
  checkTransferSize(expected?.bytes, maxBytes);
  if (!/^[a-f0-9]{64}$/.test(expected?.sha256)) throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  destination = revalidate();
  operation.dispatch();
  if (fs.mkdirSync(path.dirname(destination.path), { recursive: true }) !== undefined) operation.confirm();
  destination = revalidate();
  // Keep ownership anchored to the validated canonical parent if a configured
  // ancestor alias changes while the transfer is running.
  const temporary = path.join(path.dirname(destination.canonicalPath ?? destination.path), tempName());
  let fd = null;
  let owned = false;
  let failure;
  let result;
  let warning = false;
  try {
    operation.check();
    operation.dispatch();
    fd = fs.openSync(temporary, "wx", 0o600);
    operation.confirm();
    owned = true;
    await adapter.downloadFile(remote, temporary, maxBytes);
    operation.check();
    const actual = await hashLocalFile(temporary, maxBytes, operation);
    sameDigest(expected, actual, maxBytes);
    operation.check();
    let final = revalidate();
    if (final.exists) fs.fchmodSync(fd, final.stat.mode & 0o777);
    fs.fsyncSync(fd);
    const closing = fd;
    fd = null;
    fs.closeSync(closing);
    final = revalidate();
    operation.check();
    if (overwrite) {
      fs.renameSync(temporary, final.path);
      owned = false;
    } else {
      // link is an atomic create-if-absent operation. Never fall back to a
      // check+rename sequence if hard links are unavailable on this filesystem.
      fs.linkSync(temporary, final.path);
    }
    operation.confirmFile(actual.bytes);
    result = { bytes: actual.bytes, cleanupWarning: null };
  } catch (error) { failure = nativeError(error, "local", { path: destination.path }); }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { warning = true; }
    }
    if (owned) {
      try { fs.unlinkSync(temporary); } catch { warning = true; }
    }
  }
  if (failure) throw failureWithCleanup(failure, warning);
  if (warning) result.cleanupWarning = operation.i18n.t("runtime.transfer.cleanup");
  return result;
}
