import { createI18n } from "./i18n.js";

export const ERROR_CODES = Object.freeze([
  "CONFIG_REQUIRED", "CONFIG_INVALID", "SERVER_REQUIRED", "SERVER_UNKNOWN", "INVALID_ARGUMENT",
  "READ_ONLY", "TRANSPORT_POLICY", "HOST_KEY_REJECTED", "REMOTE_ROOT_REJECTED", "PATH_REJECTED",
  "NOT_FOUND", "ALREADY_EXISTS", "TRANSFER_LIMIT", "TRANSFER_VERIFY", "TARGET_CHANGED", "CANCELLED",
  "TIMEOUT", "DEPLOY_PARTIAL", "TRANSPORT_ERROR", "OUTPUT_LIMIT", "INTERNAL_ERROR", "SCAN_LIMIT", "CAPACITY_LIMIT",
]);
export const NEXT_ACTIONS = Object.freeze(["fix_input", "fix_config", "select_server", "inspect_target", "retry", "contact_operator", "none"]);
const details = new WeakMap();
const messages = new WeakMap();

// Only descriptors minted here are rendered recursively. Remote objects with
// similarly named properties remain data and cannot choose a translation key.
export function messageSpec(key, params = {}) {
  const value = Object.freeze({});
  messages.set(value, { key, params: Object.freeze({ ...params }) });
  return value;
}

export function messageList(values, separator = "; ") {
  const value = Object.freeze({});
  messages.set(value, { items: Object.freeze([...values]), separator });
  return value;
}

export function renderMessage(value, i18n = createI18n()) {
  if (isAppError(value)) return renderError(value, i18n);
  const spec = value && typeof value === "object" ? messages.get(value) : undefined;
  if (!spec) return String(value ?? "");
  if (spec.items) return spec.items.map((item) => renderMessage(item, i18n)).join(spec.separator);
  return i18n.t(spec.key, Object.fromEntries(Object.entries(spec.params).map(([key, item]) => [key, renderMessage(item, i18n)])));
}

export class AppError extends Error {
  constructor(code, key, params = {}, { origin = "application", secondary = [] } = {}) {
    if (!ERROR_CODES.includes(code)) throw new TypeError("Unregistered application error code");
    const spec = messageSpec(key, params);
    super(renderMessage(spec));
    this.name = "AppError";
    details.set(this, Object.freeze({ code, spec, origin, secondary: Object.freeze([...secondary]) }));
  }
  get code() { return details.get(this).code; }
}

export function appError(code, key, params, options) { return new AppError(code, key, params, options); }
export function isAppError(value) { return Boolean(value && typeof value === "object" && details.has(value)); }
export function errorDetails(error) { return details.get(error); }
export function renderError(error, i18n = createI18n()) {
  const value = details.get(error);
  if (!value) return i18n.t("error.INTERNAL_ERROR");
  const text = [renderMessage(value.spec, i18n), ...value.secondary.map((item) => renderMessage(item, i18n))].join("\n\n");
  return value.redactor ? value.redactor.strictText(text) : text;
}

// Attach configuration confidentiality before an error becomes a public
// diagnostic. The descriptor and redactor stay private, including on copies.
export function protectError(error, redactor) {
  const value = details.get(error);
  if (!value) return error;
  details.set(error, Object.freeze({ ...value, redactor }));
  error.message = renderError(error);
  return error;
}

export function normalizeError(error) {
  return isAppError(error) ? error : appError("INTERNAL_ERROR", "error.INTERNAL_ERROR");
}

export function withSecondary(error, key, params = {}) {
  const primary = normalizeError(error);
  const original = details.get(primary);
  const copy = new AppError(original.code, "error.INTERNAL_ERROR");
  details.set(copy, Object.freeze({ ...original, secondary: Object.freeze([...original.secondary, messageSpec(key, params)]) }));
  copy.message = renderError(copy);
  return copy;
}

// This helper is called only at a known native transport/filesystem boundary.
// An arbitrary code/message on an injected Error never selects a public code.
export function nativeError(error, origin, { path = "" } = {}) {
  if (isAppError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  if (origin === "local" && error?.code === "ENOENT") return appError("NOT_FOUND", "error.notFound", { path }, { origin });
  if (origin === "local" && error?.code === "EEXIST") return appError("ALREADY_EXISTS", "error.exists", { path }, { origin });
  return appError(origin === "local" ? "INTERNAL_ERROR" : "TRANSPORT_ERROR",
    origin === "local" ? "error.localIO" : "error.TRANSPORT_ERROR", { detail }, { origin });
}
