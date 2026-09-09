import { randomUUID } from "node:crypto";
import path from "node:path";
import { createI18n } from "./i18n.js";
import { appError, messageSpec, nativeError } from "./errors.js";

export const DEFAULT_OPERATION_TIMEOUT_MS = 120000;
const locks = new Map();
const workerObservers = new WeakMap();

// Private connection integration: only an in-process transport decorator can
// attach this hook. It receives the actual worker, never the outward race.
export function observeOperationWorker(extra, observer) { workerObservers.set(extra, observer); }

export function createOperation(extra = {}, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, { requestId, i18n = createI18n() } = {}) {
  const controller = new AbortController();
  const id = requestId ?? randomUUID();
  const deadline = Date.now() + timeoutMs;
  let timer;
  let waiting = 0;
  let progress = 0;
  let finished = false;
  let notifications = Promise.resolve();
  let dispatched = false;
  let confirmed = false;
  let partial;
  let pendingPromotion;
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  const abort = (code) => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    const detail = messageSpec(waiting ? "error.busy" : "error.uncertain");
    controller.abort(appError(code, `error.${code}`, { id, detail }));
  };
  const onParentAbort = () => abort("CANCELLED");
  if (extra.signal?.aborted) onParentAbort();
  else extra.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (!controller.signal.aborted) timer = setTimeout(() => abort("TIMEOUT"), timeoutMs);
  const operation = {
    id,
    i18n,
    settlement,
    signal: controller.signal,
    dispatch() { dispatched = true; },
    confirm() { dispatched = true; confirmed = true; },
    trackFiles(totalFiles) {
      partial = { completed_files: 0, completed_bytes: 0, failed_files: 0,
        ...(totalFiles === undefined ? {} : { total_files: totalFiles }) };
    },
    failFile() { if (partial) partial.failed_files += 1; },
    async fileAttempt(run) {
      const completed = partial?.completed_files;
      try { return await run(); }
      catch (error) {
        // A file acknowledged as promoted remains completed even if a later
        // cancellation check fails. Preflight and close are outside this scope.
        if (partial && partial.completed_files === completed) operation.failFile();
        throw error;
      }
    },
    confirmFile(bytes) {
      operation.confirm();
      if (partial) { partial.completed_files += 1; partial.completed_bytes += bytes; }
    },
    async promote(bytes, run) {
      pendingPromotion = bytes;
      try { return await run(); } finally { pendingPromotion = undefined; }
    },
    observeMutation(method) {
      if (!["mkdirp", "ensureDir", "mkdir", "chmod"].includes(method)) operation.confirm();
      if (method === "rename" && pendingPromotion !== undefined) {
        const bytes = pendingPromotion;
        pendingPromotion = undefined;
        operation.confirmFile(bytes);
      }
    },
    snapshot() {
      return { effects: confirmed ? "confirmed" : dispatched ? "possible" : "none",
        ...(partial ? { partial: { ...partial, final: finished } } : {}) };
    },
    check() {
      if (!controller.signal.aborted && Date.now() >= deadline) abort("TIMEOUT");
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    async step(run) {
      operation.check();
      try {
        const value = await run();
        operation.check();
        return value;
      } catch (err) {
        operation.check();
        throw err;
      }
    },
    progress() {
      const token = extra._meta?.progressToken;
      if (token === undefined || typeof extra.sendNotification !== "function" || controller.signal.aborted || finished) return;
      const current = ++progress;
      notifications = notifications.then(() => {
        if (!controller.signal.aborted && !finished) {
          return extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: current } });
        }
      }).catch(() => {});
    },
    async lock(keys, run) {
      const releases = [];
      try {
        for (const key of [...new Set(keys)].sort()) {
          waiting += 1;
          try {
            releases.push(await acquire(key, operation));
          } finally {
            waiting -= 1;
          }
          operation.check();
        }
        return await operation.step(run);
      } finally {
        // Only actual settlement releases ownership, never an early response.
        for (const release of releases.reverse()) release();
      }
    },
    async run(run) {
      let onAbort;
      const cancelled = new Promise((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const worker = operation.step(run).finally(() => {
        finished = true;
        clearTimeout(timer);
        extra.signal?.removeEventListener("abort", onParentAbort);
        settle();
      });
      workerObservers.get(extra)?.(worker);
      try {
        // Race observes late rejections; the worker keeps locks and cleanup
        // until the underlying adapter promises have actually settled.
        return await Promise.race([worker, cancelled]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return operation;
}

function acquire(key, operation) {
  operation.check();
  let state = locks.get(key);
  if (!state) {
    state = { queue: [] };
    locks.set(key, state);
    return Promise.resolve(releaseLock(key, state));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, stop: null };
    const onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index !== -1) state.queue.splice(index, 1);
      reject(operation.signal.reason);
    };
    waiter.stop = () => operation.signal.removeEventListener("abort", onAbort);
    state.queue.push(waiter);
    operation.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseLock(key, state) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.queue.shift();
    if (next) {
      next.stop();
      next.resolve(releaseLock(key, state));
    } else {
      locks.delete(key);
    }
  };
}

export function remoteLockKey(server) {
  return JSON.stringify(["remote", server.protocol.trim().toLowerCase(),
    server.host.trim().toLowerCase().replace(/\.$/, ""), server.port, server.user]);
}

export function localLockKey(destination) {
  const normalized = path.resolve(destination);
  return `local:${process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized}`;
}

// Check protocol primitives and injected adapters without racing their I/O.
export function checkedMethods(target, operation, methods, origin) {
  if (!operation) return target;
  const checked = new Set(methods);
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (typeof value !== "function") return value;
      if (!checked.has(key)) return value.bind(object);
      return (...args) => operation.step(async () => {
        const mutation = MUTATION_METHODS.has(key);
        if (mutation) operation.dispatch();
        let result;
        try { result = await value.apply(object, args); }
        catch (error) { throw origin ? nativeError(error, origin) : error; }
        if (mutation) operation.observeMutation(key);
        return result;
      });
    },
  });
}

const MUTATION_METHODS = new Set(["uploadFile", "uploadFrom", "put", "downloadFile", "mkdirp", "ensureDir", "mkdir",
  "deleteFile", "deleteDir", "remove", "removeDir", "delete", "rmdir", "rename", "chmod"]);

export async function connectOperation(connectAdapter, server, operation) {
  operation.check();
  let adapter;
  try { adapter = await connectAdapter(server, operation); }
  catch (error) { throw nativeError(error, "transport"); }
  let closing;
  const close = () => {
    operation.signal.removeEventListener("abort", onAbort);
    closing ??= Promise.resolve().then(() => adapter.close());
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  operation.signal.addEventListener("abort", onAbort, { once: true });
  if (operation.signal.aborted) {
    await close().catch(() => {});
    operation.check();
  }
  const checked = checkedMethods(adapter, operation, [
    "list", "stat", "uploadFile", "downloadFile", "readFile", "hashFile", "mkdirp", "deleteFile", "deleteDir", "rename",
  ], "transport");
  return new Proxy(checked, { get(target, key) { return key === "close" ? close : Reflect.get(target, key); } });
}
