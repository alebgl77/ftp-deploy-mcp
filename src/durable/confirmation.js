import { inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";

import { LOWER_SHA256_RE, OPERATION_ID_RE, PLAN_ID_RE } from "./schemas.js";
import { DurableFailure } from "./state.js";

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ConfirmationResponseSchema = z.object({
  confirm: z.boolean(),
  plan_id: z.string().regex(PLAN_ID_RE),
  plan_digest: z.string().regex(LOWER_SHA256_RE),
}).strict();
const ConfirmationRequestedSchema = Object.freeze({
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm" },
    plan_id: { type: "string", title: "Plan ID" },
    plan_digest: { type: "string", title: "Plan digest" },
  },
  required: ["confirm", "plan_id", "plan_digest"],
});

export const ConfirmationStateSchema = z.object({
  v: z.literal(1),
  action: z.enum(["apply", "rollback"]),
  planId: z.string().regex(PLAN_ID_RE),
  operationId: z.string().regex(OPERATION_ID_RE),
  planDigest: z.string().regex(LOWER_SHA256_RE),
  keyHash: z.string().regex(LOWER_SHA256_RE),
  resume: z.boolean(),
  journalSeq: safeInteger,
  expiresAt: safeInteger,
}).strict();

function invalid() {
  return new DurableFailure("CONFIRMATION_INVALID", "The deployment confirmation is invalid or no longer matches this request.", {
    nextAction: "retry",
  });
}

function sameState(actual, expected) {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

export async function requestConfirmation({ operation, state, message }) {
  if (typeof operation?.mintRequestState !== "function") {
    throw new DurableFailure("CLIENT_INTERACTION_UNSUPPORTED", "The client cannot complete the required deployment confirmation.", {
      nextAction: "upgrade_client",
    });
  }
  const checked = ConfirmationStateSchema.parse(state);
  const requestState = await operation.mintRequestState(checked);
  return inputRequired({
    inputRequests: {
      confirmation: inputRequired.elicit({ message, requestedSchema: ConfirmationRequestedSchema }),
    },
    requestState,
  });
}

// Returns null only after a verified, current, affirmative response. A stale
// journal sequence produces a fresh signed challenge instead of authorizing a
// mutation against state the user did not inspect.
export async function requireConfirmation({ operation, expected, currentJournalSeq, now = Date.now(), message }) {
  const checked = ConfirmationStateSchema.parse(expected);
  if (operation?.requestState === undefined) {
    return requestConfirmation({ operation, state: checked, message });
  }
  const parsed = ConfirmationStateSchema.safeParse(operation.requestState);
  if (!parsed.success || !sameState(parsed.data, checked)) throw invalid();
  if (now >= checked.expiresAt) throw invalid();
  if (currentJournalSeq !== checked.journalSeq) {
    return requestConfirmation({ operation, state: { ...checked, journalSeq: currentJournalSeq }, message });
  }
  let response;
  try { response = operation.acceptedInputResponse?.("confirmation", ConfirmationResponseSchema); }
  catch { throw invalid(); }
  if (!response) {
    throw new DurableFailure("CLIENT_INTERACTION_UNSUPPORTED", "The client did not return the required deployment confirmation.", {
      nextAction: "upgrade_client",
    });
  }
  if (response.plan_id !== checked.planId || response.plan_digest !== checked.planDigest) throw invalid();
  if (response.confirm !== true) {
    throw new DurableFailure("CONFIRMATION_DECLINED", "The deployment confirmation was declined.", { nextAction: "none" });
  }
  return null;
}
