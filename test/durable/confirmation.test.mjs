import assert from "node:assert/strict";
import test from "node:test";

import { requireConfirmation } from "../../src/durable/confirmation.js";

const PLAN_ID = "pln_11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "op_22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const KEY_HASH = "b".repeat(64);

function expected(overrides = {}) {
  return {
    v: 1,
    action: "apply",
    planId: PLAN_ID,
    operationId: OPERATION_ID,
    planDigest: DIGEST,
    keyHash: KEY_HASH,
    resume: true,
    journalSeq: 7,
    expiresAt: 2_000,
    ...overrides,
  };
}

function accepted(state, response = { confirm: true, plan_id: PLAN_ID, plan_digest: DIGEST }) {
  return { requestState: state, acceptedInputResponse: () => response };
}

test("confirmation binds every signed field and the accepted plan projection", async () => {
  const baseline = expected();
  assert.equal(await requireConfirmation({ operation: accepted(baseline), expected: baseline,
    currentJournalSeq: 7, now: 1_999, message: "confirm" }), null);

  for (const [field, value] of [
    ["action", "rollback"], ["planId", "pln_33333333-3333-4333-8333-333333333333"],
    ["operationId", "op_44444444-4444-4444-8444-444444444444"], ["planDigest", "c".repeat(64)],
    ["keyHash", "d".repeat(64)], ["resume", false], ["expiresAt", 2_001],
  ]) {
    await assert.rejects(requireConfirmation({ operation: accepted({ ...baseline, [field]: value }), expected: baseline,
      currentJournalSeq: 7, now: 1_999, message: "confirm" }), { code: "CONFIRMATION_INVALID" }, field);
  }
  await assert.rejects(requireConfirmation({ operation: accepted(baseline,
    { confirm: true, plan_id: PLAN_ID, plan_digest: "e".repeat(64) }), expected: baseline,
  currentJournalSeq: 7, now: 1_999, message: "confirm" }), { code: "CONFIRMATION_INVALID" });
});

test("expiry is inclusive and an obsolete journal sequence issues a fresh signed challenge", async () => {
  const baseline = expected();
  await assert.rejects(requireConfirmation({ operation: accepted(baseline), expected: baseline,
    currentJournalSeq: 7, now: 2_000, message: "confirm" }), { code: "CONFIRMATION_INVALID" });

  let reminted;
  const result = await requireConfirmation({ operation: {
    ...accepted(baseline),
    mintRequestState: async (value) => { reminted = value; return "signed"; },
  }, expected: baseline, currentJournalSeq: 8, now: 1_999, message: "confirm" });
  assert.equal(result.resultType, "input_required");
  assert.equal(result.requestState, "signed");
  assert.deepEqual(reminted, { ...baseline, journalSeq: 8 });
});

test("missing interaction seams fail closed and decline remains a distinct zero-effect decision", async () => {
  const baseline = expected();
  await assert.rejects(requireConfirmation({ operation: {}, expected: baseline,
    currentJournalSeq: 7, now: 1_999, message: "confirm" }), { code: "CLIENT_INTERACTION_UNSUPPORTED" });
  await assert.rejects(requireConfirmation({ operation: { requestState: baseline }, expected: baseline,
    currentJournalSeq: 7, now: 1_999, message: "confirm" }), { code: "CLIENT_INTERACTION_UNSUPPORTED" });
  await assert.rejects(requireConfirmation({ operation: accepted(baseline,
    { confirm: false, plan_id: PLAN_ID, plan_digest: DIGEST }), expected: baseline,
  currentJournalSeq: 7, now: 1_999, message: "confirm" }), { code: "CONFIRMATION_DECLINED" });
});
