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

function limitedStream(maxBytes, operation, onChunk) {
  const count = counter(maxBytes, operation);
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    try { count.add(chunk); onChunk?.(chunk); callback(null, chunk); } catch (error) { callback(error); }
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

export async function sendReadableStream(input, maxBytes, operation, send) {
  operation?.check();
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

export async function sendLocalStream(localPath, maxBytes, operation, send) {
  return sendReadableStream(fs.createReadStream(localPath), maxBytes, operation, send);
}

export async function receiveRemoteStream(output, maxBytes, operation, receive, { sha256 = false } = {}) {
  operation?.check();
  const hash = sha256 ? createHash("sha256") : null;
  const { stream, count } = limitedStream(maxBytes, operation, (chunk) => hash?.update(chunk));
  const piping = pipeline(stream, output).then(() => null, (error) => error);
  let failure;
  try { await receive(stream); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
  if (failure) stream.destroy(failure);
  else if (!stream.writableEnded) stream.end();
  const pipeError = await piping;
  if (failure || pipeError) throw count.failure || failure || pipeError;
  operation?.check();
  return { bytes: count.bytes, ...(hash ? { sha256: hash.digest("hex") } : {}) };
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
const durableTemporaryName = /^\.ftp-mcp-[0-9a-f]{32}\.tmp$/;

export function validateDurableTemporary(temporary, target) {
  if (typeof temporary !== "string" || !durableTemporaryName.test(path.posix.basename(temporary)) ||
      (target !== undefined && (typeof target !== "string" || path.posix.dirname(temporary) !== path.posix.dirname(target)))) {
    throw appError("INVALID_ARGUMENT", "error.INVALID_ARGUMENT");
  }
  return temporary;
}

function failureWithCleanup(error, warning) {
  if (!warning) return error;
  return withSecondary(error, "runtime.transfer.cleanup");
}

function observationIdentity(observation) {
  return observation?.identity ?? observation;
}

function assertObservation(expected, observation, identity) {
  if (observation?.type !== "file") throw appError("TRANSFER_VERIFY", "runtime.transfer.digestMismatch");
  sameDigest(expected, observation, expected.bytes);
  const claimed = observationIdentity(identity);
  if (!claimed) return;
  const claimedRoot = claimed.canonicalRoot ?? claimed.root;
  const observedRoot = observation.canonicalRoot ?? observation.root;
  if ((claimedRoot !== undefined && claimedRoot !== observedRoot) ||
      (claimed.path !== undefined && claimed.path !== observation.path) ||
      (claimed.parent !== undefined && claimed.parent !== observation.parent) ||
      (claimed.bytes !== undefined && claimed.bytes !== observation.bytes) ||
      (claimed.sha256 !== undefined && claimed.sha256 !== observation.sha256) ||
      (claimed.mode !== undefined && observation.mode !== claimed.mode)) {
    throw appError("TARGET_CHANGED", "runtime.sftp.temporaryIdentityChanged");
  }
}

async function inspectUploaded(adapter, temporary, expected, identity, durable = true) {
  if (durable) {
    if (typeof adapter.inspectFile !== "function") {
      throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
    }
    const observation = await adapter.inspectFile(temporary, { maxBytes: expected.bytes });
    assertObservation(expected, observation, identity);
    return observation;
  }
  const actual = await adapter.hashFile(temporary, expected.bytes, { identity });
  sameDigest(expected, actual, expected.bytes);
  return { type: "file", path: temporary, bytes: actual.bytes, sha256: actual.sha256, identity };
}

async function stageSource({ adapter, source, temporary, expected, operation }, { createParents, durable }) {
  validateDurableTemporary(temporary);
  operation?.check();
  checkTransferSize(expected?.bytes, expected?.bytes);
  if (!/^[a-f0-9]{64}$/.test(expected?.sha256)) {
    throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  }
  if (durable && typeof adapter.inspectFile !== "function") {
    throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  }
  let owned = false;
  let uncertainCreation = false;
  let createdIdentity;
  try {
    const options = {
      staged: true,
      createParents,
      onCreating() { uncertainCreation = true; },
      onOwned(created) { owned = true; uncertainCreation = false; createdIdentity = created; },
    };
    let staging;
    if (durable && typeof adapter.uploadStream === "function") {
      const readable = fs.createReadStream(source);
      // Attach settlement observation immediately: a preflight rejection can
      // otherwise leave a newly opened ReadStream without an error listener.
      const settled = finished(readable).catch(() => {});
      try {
        staging = await adapter.uploadStream(readable, temporary, expected, options);
      } finally {
        readable.destroy();
        await settled;
      }
    } else {
      staging = await adapter.uploadFile(source, temporary, expected.bytes, options);
    }
    operation?.check();
    const observation = await inspectUploaded(adapter, temporary, expected, createdIdentity, durable);
    operation?.check();
    return { ...observation, mode: staging?.mode, identity: observation.identity ?? createdIdentity };
  } catch (error) {
    let warning = uncertainCreation;
    const fullyIdentified = createdIdentity?.bytes === expected.bytes && createdIdentity?.sha256 === expected.sha256;
    if (owned && (!durable || fullyIdentified)) {
      try { await adapter.deleteFile(temporary, { identity: createdIdentity }); } catch { warning = true; }
    } else if (owned) {
      // A durable temporary whose creation identity has no verified digest can
      // no longer be safely attributed after a failed stage. Leave it in place.
      warning = true;
    }
    throw failureWithCleanup(error, warning);
  }
}

export async function stageVerifiedSource(options) {
  return stageSource(options, { createParents: false, durable: true });
}

async function observedPromotion(adapter, temporary, target, expected, identity, mode) {
  if (typeof adapter.inspectFile !== "function") return false;
  const [staged, promoted] = await Promise.all([
    adapter.inspectFile(temporary, { maxBytes: expected.bytes }),
    adapter.inspectFile(target, { maxBytes: expected.bytes }),
  ]);
  if (staged?.type !== "absent") return false;
  const claimed = observationIdentity(identity);
  const destinationIdentity = claimed ? {
    canonicalRoot: claimed.canonicalRoot ?? claimed.root,
    path: claimed.parent === undefined ? target : path.posix.join(claimed.parent, path.posix.basename(target)),
    parent: claimed.parent,
    bytes: claimed.bytes,
    sha256: claimed.sha256,
    ...(mode === undefined || mode === null ? {} : { mode }),
  } : undefined;
  try { assertObservation(expected, promoted, destinationIdentity); }
  catch { return false; }
  return true;
}

async function promoteLegacyStage({ adapter, temporary, target, staged, operation }) {
  validateDurableTemporary(temporary, target);
  const expected = { bytes: staged?.bytes, sha256: staged?.sha256 };
  checkTransferSize(expected.bytes, expected.bytes);
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  operation.check();
  await operation.promote(expected.bytes, () => adapter.rename(temporary, target, {
    staged: true, mode: staged.mode, identity: staged.identity,
  }));
  operation.check();
  return { bytes: expected.bytes };
}

async function promoteDurableStage({ adapter, temporary, target, mode, identity, operation }) {
  validateDurableTemporary(temporary, target);
  const expected = { bytes: identity?.bytes, sha256: identity?.sha256 };
  checkTransferSize(expected.bytes, expected.bytes);
  if (!/^[a-f0-9]{64}$/.test(expected.sha256)) throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  const staged = await inspectUploaded(adapter, temporary, expected, identity, true);
  operation?.check();
  try {
    const promote = () => adapter.rename(temporary, target, {
      staged: true, createParents: false, mode, identity: staged.identity ?? identity,
    });
    if (operation) await operation.promote(expected.bytes, promote);
    else await promote();
  } catch (error) {
    if (!await observedPromotion(adapter, temporary, target, expected, staged, mode).catch(() => false)) throw error;
    operation?.confirmFile(expected.bytes);
    operation?.check();
    return { bytes: expected.bytes, proof: "observed" };
  }
  operation?.check();
  return { bytes: expected.bytes, proof: "ack" };
}

export async function promoteVerifiedStage(options) {
  return promoteDurableStage(options);
}

export async function cleanupVerifiedStage({ adapter, temporary, expected, identity, operation }) {
  validateDurableTemporary(temporary);
  checkTransferSize(expected?.bytes, expected?.bytes);
  if (!/^[a-f0-9]{64}$/.test(expected?.sha256)) throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  if (typeof adapter.inspectFile !== "function") {
    throw appError("TRANSFER_VERIFY", "runtime.transfer.remoteDigestMissing");
  }
  const observation = await adapter.inspectFile(temporary, { maxBytes: expected.bytes });
  if (observation?.type === "absent") return { removed: false };
  assertObservation(expected, observation, identity);
  try {
    await adapter.deleteFile(temporary, { identity: observation.identity ?? identity });
  } catch (error) {
    const after = await adapter.inspectFile(temporary, { maxBytes: expected.bytes }).catch(() => null);
    if (after?.type !== "absent") throw error;
  }
  operation?.check();
  return { removed: true };
}

export async function uploadVerified({ adapter, source, target, maxBytes, operation, expected }) {
  operation.check();
  expected ??= await hashLocalFile(source, maxBytes, operation);
  checkTransferSize(expected.bytes, maxBytes);
  const temporary = path.posix.join(path.posix.dirname(target), tempName());
  let staged;
  try {
    staged = await stageSource({ adapter, source, temporary, expected, operation },
      { createParents: true, durable: false });
    return await promoteLegacyStage({ adapter, temporary, target, staged, operation });
  } catch (error) {
    if (!staged) throw error;
    let warning = false;
    try { await adapter.deleteFile(temporary, { identity: staged.identity }); }
    catch { warning = true; }
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
