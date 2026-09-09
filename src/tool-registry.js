import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createI18n } from "./i18n.js";
import { createOperation } from "./operations.js";
import { acquireAdmission } from "./admission.js";
import { ERROR_CODES, NEXT_ACTIONS, appError, messageSpec, normalizeError, renderError } from "./errors.js";

export const MAX_RESULT_BYTES = 25000;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ERROR_SCHEMA = z.object({ error: z.object({
  schema_version: z.literal(1), code: z.enum(ERROR_CODES), message: z.string(), retryable: z.boolean(),
  request_id: z.string().uuid(), next_action: z.enum(NEXT_ACTIONS),
  effects: z.enum(["none", "possible", "confirmed"]),
  partial: z.object({ completed_files: counter, completed_bytes: counter, failed_files: counter,
    total_files: counter.optional(), final: z.boolean() }).strict().optional(),
}).strict() }).strict();

const renderMetadata = new WeakMap();
export function withRenderMetadata(result, metadata) {
  renderMetadata.set(result, Object.freeze({ ...renderMetadata.get(result), ...metadata }));
  return result;
}
export function addNotices(result, notices) {
  return withRenderMetadata(result, { notices: [...new Set([...(renderMetadata.get(result)?.notices || []), ...notices])] });
}

export function utf8Size(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
export function truncateUtf8(value, maxBytes, marker = "\n… [output truncated]") {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(marker, "utf8") > maxBytes) marker = "";
  let low = 0, high = text.length;
  const budget = maxBytes - Buffer.byteLength(marker, "utf8");
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return text.slice(0, low) + marker;
}

// Exact schema-specific public constants; no generic key or UUID exemptions.
const publicEnums = {
  ftp_list_servers: { status: ["configured", "missing", "invalid"], "servers.*.protocol": ["ftp", "ftps", "sftp"], "servers.*.auth": ["key", "password"] },
  ftp_test: { protocol: ["ftp", "ftps", "sftp"] },
  ftp_list: { "entries.*.type": ["dir", "file", "link"] },
  ftp_deploy: { mode: ["dry_run", "deploy"] },
  ftp_delete: { entry_type: ["file", "directory"] },
};

function redactStructured(value, redactor, tool, i18n, location = "") {
  if (typeof value === "string") {
    if (publicEnums[tool]?.[location]?.includes(value)) return value;
    return truncateUtf8(redactor.strictText(value), 2048, i18n.t("error.truncated"));
  }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, redactor, tool, i18n, `${location}.*`));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    redactStructured(item, redactor, tool, i18n, location ? `${location}.${key}` : key)]));
}

const sampleFields = [["entries", null], ["servers", "servers_omitted"], ["errors", "errors_omitted"],
  ["uploaded", "uploaded_omitted"], ["planned", "planned_omitted"], ["failures", "failures_omitted"]];
function shrinkSample(structured) {
  if (!structured) return false;
  let selected, bytes = -1;
  for (const [field, omitted] of sampleFields) {
    const values = structured[field];
    if (!Array.isArray(values) || !values.length) continue;
    const size = utf8Size(values.at(-1));
    if (size > bytes) { bytes = size; selected = [field, omitted]; }
  }
  if (!selected) return false;
  const [field, omitted] = selected;
  structured[field].pop();
  if (omitted) structured[omitted] += 1;
  if (field === "entries") {
    structured.count = structured.entries.length;
    structured.has_more = structured.offset + structured.count < structured.total;
    structured.next_offset = structured.has_more ? structured.offset + structured.count : null;
  }
  return true;
}

function nextAction(code, effects) {
  if (effects !== "none") return "inspect_target";
  if (["CONFIG_REQUIRED", "CONFIG_INVALID", "TRANSPORT_POLICY", "HOST_KEY_REJECTED", "REMOTE_ROOT_REJECTED", "READ_ONLY"].includes(code)) return "fix_config";
  if (["SERVER_REQUIRED", "SERVER_UNKNOWN"].includes(code)) return "select_server";
  if (["INVALID_ARGUMENT", "PATH_REJECTED", "NOT_FOUND", "ALREADY_EXISTS", "TRANSFER_LIMIT", "SCAN_LIMIT"].includes(code)) return "fix_input";
  if (code === "CAPACITY_LIMIT") return "retry";
  if (code === "CANCELLED") return "none";
  return "contact_operator";
}

function schemaJSON(schema) {
  const { $schema: _schema, ...body } = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" });
  return body;
}

export function createToolRegistry({ redactor, i18n = createI18n(), timeoutFor = () => undefined, errorNotices = () => [], transportContext }) {
  const entries = new Map();
  const clean = (value, max = 2048) => truncateUtf8(redactor.strictText(value), max, i18n.t("error.truncated"));
  function failure(error, id, state = { effects: "none" }, notices = []) {
    const primary = normalizeError(error);
    const envelope = { error: {
      schema_version: 1, code: primary.code, message: clean(renderError(primary, i18n)),
      retryable: false, request_id: id, next_action: nextAction(primary.code, state.effects),
      effects: state.effects, ...(state.partial ? { partial: { ...state.partial } } : {}),
    } };
    const result = { isError: true, content: [{ type: "text", text: clean(i18n.t("error.result", {
      code: primary.code, message: envelope.error.message,
    }), 4096) }, ...notices.map((text) => ({ type: "text", text: clean(text) }))], structuredContent: envelope };
    // Constants and this freshly minted ID are constructed here, never copied
    // from a handler, incoming JSON-RPC request, remote object or Error data.
    ERROR_SCHEMA.parse(envelope);
    if (utf8Size(result) > MAX_RESULT_BYTES) {
      // Counters/effects/ID survive fallback unchanged. Bound the fixed notice
      // set before this function; never truncate trusted effect observations.
      return failure(appError("OUTPUT_LIMIT", "error.OUTPUT_LIMIT"), id, state, []);
    }
    return result;
  }

  function finish(raw, entry, id, operation) {
    const state = operation.snapshot();
    const metadata = raw && renderMetadata.get(raw) || {};
    if (!raw || raw.isError || !Array.isArray(raw.content)) return failure(appError("INTERNAL_ERROR", "error.INTERNAL_ERROR"), id, state);
    const structured = raw.structuredContent === undefined ? undefined : redactStructured(raw.structuredContent, redactor, entry.name, i18n);
    const notices = (metadata.notices || []).map((text) => ({ type: "text", text: clean(text) }));
    let body = raw.content.map((item) => ({ type: "text", text: redactor.strictText(item.text ?? "") }));
    const renderBody = () => {
      if (metadata.page && structured) body = [{ type: "text", text: redactor.strictText(metadata.page(structured)) }];
    };
    renderBody();
    let result = { content: [...body, ...notices], ...(structured === undefined ? {} : { structuredContent: structured }) };
    while (structured && utf8Size(structured) > 22000 && shrinkSample(structured)) renderBody();
    result.content = [...body, ...notices];
    while (utf8Size(result) > MAX_RESULT_BYTES) {
      // Render metadata, not marker-like remote text, identifies body/notices.
      let largest = -1;
      for (let index = 0; index < body.length; index++) {
        if (body[index].text && (largest < 0 || Buffer.byteLength(body[index].text) > Buffer.byteLength(body[largest].text))) largest = index;
      }
      if (largest >= 0) {
        const excess = utf8Size(result) - MAX_RESULT_BYTES;
        body[largest].text = truncateUtf8(body[largest].text, Math.max(0, Buffer.byteLength(body[largest].text) - excess - 128), i18n.t("error.truncated"));
      } else if (shrinkSample(structured)) {
        renderBody();
      } else return failure(appError("OUTPUT_LIMIT", "error.OUTPUT_LIMIT"), id, state, notices.map((item) => item.text));
      result.content = [...body, ...notices];
    }
    const valid = entry.output ? entry.output.safeParse(structured).success : structured === undefined;
    if (!valid) return failure(appError("INTERNAL_ERROR", "error.INTERNAL_ERROR"), id, state, notices.map((item) => item.text));
    return result;
  }

  const registry = {
    registerTool(name, spec, handler) {
      if (entries.has(name)) throw new Error("Duplicate tool registration");
      const input = z.object(spec.inputSchema);
      const output = spec.outputSchema;
      const inputJSON = schemaJSON(input);
      for (const [field, property] of Object.entries(inputJSON.properties || {})) {
        property.description = i18n.t(field === "server" ? "mcp.common.input.server.description" : `mcp.${name}.input.${field}.description`,
          { defaultBytes: 262144, hardMax: 1048576 });
      }
      const descriptor = { name, title: i18n.t(`mcp.${name}.title`), description: i18n.t(`mcp.${name}.description`),
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", ...inputJSON }, annotations: spec.annotations,
        ...(output ? { outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object",
          oneOf: [schemaJSON(output), schemaJSON(ERROR_SCHEMA)] } } : {}) };
      entries.set(name, { name, input, output, descriptor, handler });
    },
    list() { return { tools: [...entries.values()].map((entry) => entry.descriptor) }; },
    async call(name, args, extra = {}) {
      const entry = entries.get(name);
      // Protocol fault: deliberately outside the tool execution catch.
      if (!entry) throw new McpError(ErrorCode.InvalidParams, clean(i18n.t("error.unknownTool")));
      const id = randomUUID();
      let operation;
      let release;
      let workerStarted = false;
      try {
        const parsed = entry.input.safeParse(args === undefined ? {} : args);
        if (!parsed.success) return failure(appError("INVALID_ARGUMENT", "error.INVALID_ARGUMENT"), id);
        const checkParent = () => {
          if (extra.signal?.aborted) throw appError("CANCELLED", "error.CANCELLED", { id, detail: messageSpec("error.uncertain") });
        };
        checkParent();
        release = acquireAdmission();
        if (!release) return failure(appError("CAPACITY_LIMIT", "error.CAPACITY_LIMIT"), id);
        const timeout = await timeoutFor(parsed.data);
        checkParent();
        operation = createOperation(extra, timeout, { requestId: id, i18n });
        const worker = operation.run(() => entry.handler(parsed.data, operation));
        workerStarted = true;
        // Keep the transport's private worker observer intact. Settlement is
        // independent of both response rendering and the outward abort race.
        void operation.settlement.then(release);
        const raw = await worker;
        return finish(raw, entry, id, operation);
      } catch (error) {
        return failure(error, id, operation?.snapshot(), errorNotices(args).slice(0, 3));
      } finally {
        // Preparation (including a rejected async preparation) has settled.
        if (!workerStarted) release?.();
      }
    },
    install(server) {
      const protocol = server.server ?? server;
      protocol.registerCapabilities({ tools: { listChanged: false } });
      protocol.setRequestHandler(ListToolsRequestSchema, () => registry.list());
      protocol.setRequestHandler(CallToolRequestSchema, (request, extra) => registry.call(request.params.name, request.params.arguments,
        transportContext ? transportContext.scope(extra) : extra));
      return registry;
    },
    validate(name, result) {
      const entry = entries.get(name);
      return result.isError ? ERROR_SCHEMA.safeParse(result.structuredContent).success :
        entry.output ? entry.output.safeParse(result.structuredContent).success : result.structuredContent === undefined;
    },
  };
  return registry;
}
