import { CancelledNotificationSchema, isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse } from "@modelcontextprotocol/sdk/types.js";
import { observeOperationWorker } from "./operations.js";

// SDK 1.29 ignores cancellation for numeric 0 and the empty string.
// Two distinct, bounded slots preserve their exact public correlation IDs.
export function withZeroCancellation(transport) {
  const slots = new Map();
  const affected = (id) => id === 0 || id === "";
  let closing;
  let closed = false;
  let closeForwarded = false;
  const release = (current) => {
    if (current.wireDone && !current.workerPending) {
      for (const [id, slot] of slots) if (slot === current) slots.delete(id);
    }
  };
  const stop = () => {
    closed = true;
    for (const slot of slots.values()) {
      slot.controller.abort();
      slot.wireDone = true;
      release(slot);
    }
  };
  const forwardClose = () => {
    stop();
    if (!closeForwarded) { closeForwarded = true; decorated.onclose?.(); }
  };
  const decorated = {
    get sessionId() { return transport.sessionId; },
    ...(transport.setProtocolVersion ? { setProtocolVersion(version) { return transport.setProtocolVersion(version); } } : {}),
    start() {
      transport.onclose = forwardClose;
      transport.onerror = (error) => decorated.onerror?.(error);
      transport.onmessage = (message, extra) => {
        if (closed) return;
        if (isJSONRPCRequest(message) && affected(message.id)) {
          if (slots.has(message.id)) {
            // A duplicate correlation identity cannot safely receive a second
            // response. Close without launching another handler or evicting I/O.
            void decorated.close().catch((error) => decorated.onerror?.(error));
            return;
          }
          if (message.method === "tools/call") slots.set(message.id, {
            controller: new AbortController(), peerCancelled: false, wireDone: false, workerPending: false,
          });
        }
        if (message.method === "notifications/cancelled") {
          const parsed = CancelledNotificationSchema.safeParse(message);
          const slot = parsed.success && slots.get(parsed.data.params.requestId);
          if (slot && !slot.wireDone) {
            slot.peerCancelled = true;
            slot.controller.abort();
          }
        }
        decorated.onmessage?.(message, extra);
      };
      return transport.start();
    },
    async send(message, options) {
      const current = slots.get(message.id);
      const response = affected(message.id) && (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message));
      if (!current || !response) return transport.send(message, options);
      try {
        if (!current.peerCancelled) await transport.send(message, options);
      } finally {
        current.wireDone = true;
        release(current);
      }
    },
    close() {
      stop();
      closing ??= Promise.resolve().then(() => transport.close()).finally(forwardClose);
      return closing;
    },
    scope(extra) {
      const current = slots.get(extra.requestId);
      if (!affected(extra.requestId) || !current) return extra;
      const signal = AbortSignal.any([extra.signal, current.controller.signal]);
      const scoped = { ...extra, signal,
        sendNotification(...args) {
          signal.throwIfAborted();
          return extra.sendNotification(...args);
        },
        sendRequest(request, schema, options) {
          signal.throwIfAborted();
          return extra.sendRequest(request, schema, { ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
        },
      };
      observeOperationWorker(scoped, (worker) => {
        current.workerPending = true;
        const settled = () => { current.workerPending = false; release(current); };
        void worker.then(settled, settled);
      });
      return scoped;
    },
  };
  return decorated;
}
