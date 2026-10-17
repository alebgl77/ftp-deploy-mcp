import {
  ApplyInputSchema,
  ApplyOutputSchema,
  DurableErrorResultSchema,
  DurableToolAnnotations,
  PlanInputSchema,
  PlanOutputSchema,
  RollbackInputSchema,
  RollbackOutputSchema,
  StatusInputSchema,
  StatusOutputSchema,
} from "./durable/schemas.js";
import { applyDurableDeployment, planDurableDeployment, rollbackDurableDeployment } from "./durable/engine.js";
import { readDeploymentStatus } from "./durable/status.js";
import { asDurableFailure, projectDurableError } from "./durable/state.js";

export const DURABLE_TOOL_NAMES = Object.freeze([
  "ftp_plan_deploy",
  "ftp_apply_deploy",
  "ftp_deploy_status",
  "ftp_rollback_deploy",
]);

function success(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(error, operation, context = {}) {
  const structuredContent = projectDurableError(asDurableFailure(error), {
    requestId: operation.id,
    planId: context.planId ?? null,
    operationId: context.operationId ?? null,
    operationSnapshot: operation.snapshot(),
  });
  return { isError: true, content: [{ type: "text", text: `${structuredContent.error.code}: ${structuredContent.error.message}` }], structuredContent };
}

export function registerDurableTools(registry, loaded, { openAdapter, fault } = {}) {
  registry.registerTool("ftp_plan_deploy", {
    inputSchema: PlanInputSchema,
    outputSchema: PlanOutputSchema,
    errorSchema: DurableErrorResultSchema,
    annotations: DurableToolAnnotations.plan,
  }, async (input, operation) => {
    try {
      const built = await planDurableDeployment({ loaded, input, operation, openAdapter, fault });
      return success(`Durable deployment plan ${built.output.plan_id} is ready for confirmation.`, built.output);
    } catch (error) { return failure(error, operation); }
  });

  registry.registerTool("ftp_apply_deploy", {
    inputSchema: ApplyInputSchema,
    outputSchema: ApplyOutputSchema,
    errorSchema: DurableErrorResultSchema,
    annotations: DurableToolAnnotations.apply,
    inputRequired: true,
  }, async (input, operation) => {
    try {
      const output = await applyDurableDeployment({ loaded, input, operation, openAdapter, fault });
      if (output?.resultType === "input_required") return output;
      return success(`Durable deployment ${output.operation_id}: ${output.outcome}.`, output);
    } catch (error) { return failure(error, operation, { planId: input.plan_id }); }
  });

  registry.registerTool("ftp_deploy_status", {
    inputSchema: StatusInputSchema,
    outputSchema: StatusOutputSchema,
    errorSchema: DurableErrorResultSchema,
    annotations: DurableToolAnnotations.status,
  }, async (input, operation) => {
    try {
      const output = await readDeploymentStatus({ loaded, input, operation });
      return success(`Durable deployment status: ${output.phase}.`, output);
    } catch (error) {
      return failure(error, operation, { planId: input.plan_id, operationId: input.operation_id });
    }
  });

  registry.registerTool("ftp_rollback_deploy", {
    inputSchema: RollbackInputSchema,
    outputSchema: RollbackOutputSchema,
    errorSchema: DurableErrorResultSchema,
    annotations: DurableToolAnnotations.rollback,
    inputRequired: true,
  }, async (input, operation) => {
    try {
      const output = await rollbackDurableDeployment({ loaded, input, operation, openAdapter, fault });
      if (output?.resultType === "input_required") return output;
      return success(`Durable rollback ${output.operation_id}: ${output.outcome}.`, output);
    } catch (error) { return failure(error, operation, { operationId: input.operation_id }); }
  });

  return registry;
}
