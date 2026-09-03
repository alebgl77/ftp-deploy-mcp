const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 4;
const SENSITIVE_KEYS = new Set(["password", "passphrase", "privatekey", "privatekeydata"]);
const ENV_VALUE = /^\$\{ENV:([^}]+)\}$/;

function addLiteral(secrets, value) {
  if (typeof value !== "string" || value.length === 0) return;
  if (ENV_VALUE.test(value)) return;
  secrets.add(value);
}

function collect(source, secrets, seen) {
  if (!source || typeof source !== "object" || seen.has(source)) return;
  seen.add(source);
  for (const [key, value] of Object.entries(source)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) addLiteral(secrets, value);
    if (typeof value === "string") {
      const env = ENV_VALUE.exec(value);
      if (env) addLiteral(secrets, process.env[env[1].trim()]);
    } else {
      collect(value, secrets, seen);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactLiteral(text, secret, minimumLength) {
  if (secret.length < minimumLength) return text;
  if (secret.length >= MIN_SECRET_LENGTH) return text.split(secret).join(REDACTED);
  const isolated = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(secret)}(?=$|[^A-Za-z0-9_])`, "g");
  return text.replace(isolated, (_match, prefix) => `${prefix}${REDACTED}`);
}

function redactString(input, secrets, minimumLength) {
  let text = String(input);
  text = text.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    "[REDACTED PRIVATE KEY]"
  );
  text = text.replace(
    /("(?:password|passphrase|privateKey|privateKeyData)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi,
    (match, prefix, value) => (value.includes("${ENV:") ? match : `${prefix}"${REDACTED}"`)
  );
  text = text.replace(
    /(\b(?:password|passphrase)\b\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
    (match, prefix) => (match.includes("${ENV:") ? match : `${prefix}${REDACTED}`)
  );
  text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, `$1${REDACTED}$3`);
  const protectedEnv = [];
  text = text.replace(
    /\$\{ENV:[^}]+\}|\bENV\s+[A-Za-z_][A-Za-z0-9_]*|\benv var\s+[A-Za-z_][A-Za-z0-9_]*/gi,
    (segment) => {
      const marker = `\u0000FTPMCP_ENV_${protectedEnv.length}\u0000`;
      protectedEnv.push(segment);
      return marker;
    }
  );
  for (const secret of [...secrets]
    .filter((value) => value.length >= minimumLength)
    .sort((a, b) => b.length - a.length)) {
    text = redactLiteral(text, secret, minimumLength);
  }
  text = text.replace(/\u0000FTPMCP_ENV_(\d+)\u0000/g, (_match, index) => protectedEnv[Number(index)]);
  return text;
}

export function createRedactor(...sources) {
  const secrets = new Set();
  const api = {
    add(source) {
      collect(source, secrets, new WeakSet());
      return api;
    },
    text(value) {
      return redactString(value == null ? "" : value, secrets, MIN_SECRET_LENGTH);
    },
    strictText(value) {
      return redactString(value == null ? "" : value, secrets, 1);
    },
    result(result) {
      if (!result || !Array.isArray(result.content)) return result;
      return {
        ...result,
        content: result.content.map((item) =>
          item && typeof item.text === "string"
            ? { ...item, text: redactString(item.text, secrets, result.isError === true ? 1 : MIN_SECRET_LENGTH) }
            : item
        ),
      };
    },
    error(err) {
      const clean = new Error(redactString(err && err.message ? err.message : err, secrets, 1));
      if (err && err.code) clean.code = err.code;
      return clean;
    },
  };
  for (const source of sources) api.add(source);
  return api;
}
