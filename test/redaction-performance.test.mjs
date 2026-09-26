import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createRedactor } from "../src/redact.js";

// Frozen pre-cache implementation, used only to verify behavior and benchmark.
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
  for (const secret of [...secrets]
    .filter((value) => value.length >= minimumLength)
    .sort((a, b) => b.length - a.length)) {
    text = redactLiteral(text, secret, minimumLength);
  }
  return text;
}

function createLegacyRedactor(...sources) {
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

function compareText(sources, inputs) {
  const legacy = createLegacyRedactor(...sources);
  const cached = createRedactor(...sources);
  // Repeated calls also detect leaked lastIndex state in reused global regexes.
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const input of inputs) {
      for (const method of ["text", "strictText"]) {
        assert.equal(cached[method](input), legacy[method](input), `${method}: ${String(input)}`);
      }
    }
  }
}

test("cached matchers preserve legacy ordering, boundaries and generic patterns", () => {
  const inputs = [
    undefined, null, false, 0, 42, Symbol("ab"), "", "ab ab ab", "abc ab a",
    "zabc abc_z _ab ab9 ab-ab (a) a/a", "ababab bababa aaaaab",
    "[] . ? * + ^ $ \\ ( ) { } |", "a.b ([]) éé é 😀 😀😀 中文 パスワード كلمة مرور",
    "Erreur : mot de passe ab ; failed to connect using abc; Zugriff verweigert",
    "password=visible passphrase:'visible'; password=\"visible value\"",
    '{"password":"visible", "PaSsPhRaSe":"quoted\\\"value", "privateKeyData":123}',
    "ftp://user:visible@host/path sftp://name:other@host/path https://user:visible@host",
    "-----BEGIN RSA PRIVATE KEY-----\nkey-content\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-content\n-----END OPENSSH PRIVATE KEY-----",
    '${ENV:abc} password=${ENV:abc} {"password":"${ENV:abc}"}',
    "[REDACTED] [REDACTED PRIVATE KEY] ACTED] REDACTED",
    "line\nsecret\r\nvalue\t\0", "😀a😀 éabé 中文abc中文",
  ];
  const secretGroups = [
    [], [""], ["a", "ab", "abc", "abcd"], ["ababa", "babab", "aaaa", "aaaaab"],
    ["babab", "ababa"], [".", "?", "*", "+", "^", "$", "\\", "[]", "a.b", "|"],
    ["(", ")", "{", "}", "é", "éé", "😀", "\n", "\0"],
    ["[REDACTED]", "ACTED]", "REDACTED", "PRIVATE"],
    ["${ENV:abc}", "ENV:", "password", "visible", "key-content"],
  ];
  for (const secrets of secretGroups) {
    compareText(secrets.map((password) => ({ password })), inputs);
  }
});

test("cached matchers preserve nested sources, sensitive keys, environment snapshots and cycles", (t) => {
  const envName = `FTP_REDACTION_CACHE_TEST_${process.pid}`;
  const previous = process.env[envName];
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });
  process.env[envName] = "generated-env-secret";
  const source = {
    PASSWORD: "nested-password",
    nested: [{ PaSsPhRaSe: "nested-passphrase" }, { privateKey: "nested-key" }],
    privateKEYDATA: "nested-data",
    ignored: "ordinary-value",
    empty: { password: "", passphrase: 123 },
    token: `\${ENV: ${envName} }`,
  };
  source.cycle = source;
  compareText([source], [
    "nested-password nested-passphrase nested-key nested-data generated-env-secret ordinary-value",
    JSON.stringify({ password: `\${ENV:${envName}}` }),
  ]);
  for (const factory of [createLegacyRedactor, createRedactor]) {
    const redactor = factory(source);
    assert.equal(redactor.text("generated-env-secret"), "[REDACTED]");
    process.env[envName] = "changed-env-secret";
    assert.equal(redactor.text("generated-env-secret changed-env-secret"), "[REDACTED] changed-env-secret");
    redactor.add(source);
    assert.equal(redactor.text("generated-env-secret changed-env-secret"), "[REDACTED] [REDACTED]");
    process.env[envName] = "generated-env-secret";
  }
  assert.equal(source.PASSWORD, "nested-password");
  assert.equal(source.cycle, source);
});

test("late additions refresh both policies while duplicate additions retain behavior", () => {
  const legacy = createLegacyRedactor();
  const cached = createRedactor();
  const input = "abcd abc ab a babab ababa";
  const additions = [null, {}, { password: "abc" }, { password: "abcd" }, { password: "abc" },
    { passphrase: "ab" }, { nested: { privateKey: "a", privateKeyData: "ababa" } }, { password: "babab" }];
  for (const source of additions) {
    assert.equal(cached.text(input), legacy.text(input));
    assert.equal(cached.strictText(input), legacy.strictText(input));
    assert.equal(cached.add(source), cached);
    assert.equal(legacy.add(source), legacy);
    assert.equal(cached.strictText(input), legacy.strictText(input));
    assert.equal(cached.text(input), legacy.text(input));
  }
  assert.equal(createRedactor().strictText(input), input, "secrets remain local to each instance");
});

test("partially failed collection still invalidates already cached matchers", () => {
  for (const factory of [createLegacyRedactor, createRedactor]) {
    const redactor = factory({ password: "initial-secret" });
    assert.equal(redactor.text("initial-secret"), "[REDACTED]");
    const failure = new Error("collection failed");
    const child = Object.defineProperty({}, "password", { enumerable: true, get() { throw failure; } });
    assert.throws(() => redactor.add({ password: "added-before-failure", passphrase: "xy", child }),
      (err) => err === failure);
    assert.equal(redactor.text("added-before-failure xy"), "[REDACTED] xy");
    assert.equal(redactor.strictText("added-before-failure xy"), "[REDACTED] [REDACTED]");
  }
});

test("input coercion can add secrets before the current call matches", () => {
  for (const factory of [createLegacyRedactor, createRedactor]) {
    for (const method of ["text", "strictText", "error"]) {
      const redactor = factory();
      redactor[method]("prime the cache");
      const output = redactor[method]({ toString() {
        redactor.add({ password: "coercion-secret", passphrase: "xy" });
        return "coercion-secret xy";
      } });
      const expected = method === "text" ? "[REDACTED] xy" : "[REDACTED] [REDACTED]";
      assert.equal(method === "error" ? output.message : output, expected);
    }
  }
});

test("result and error wrappers preserve enums, metadata, references and input objects", () => {
  const sources = [{ password: "file", passphrase: "ok", privateKey: "secret-value" }];
  const legacy = createLegacyRedactor(...sources);
  const cached = createRedactor(...sources);
  const structuredContent = { status: "ok", kind: "file", value: "secret-value" };
  const image = Object.freeze({ type: "image", data: "secret-value" });
  const content = Object.freeze([
    Object.freeze({ type: "text", text: '{"status":"ok","kind":"file","value":"secret-value"}', extra: 1 }),
    image, null, Object.freeze({ type: "text", text: 123 }),
  ]);
  for (const isError of [undefined, false, true, 1, "true"]) {
    const input = Object.freeze({ content, structuredContent, isError, extra: { untouched: true } });
    const result = cached.result(input);
    assert.deepEqual(result, legacy.result(input));
    assert.notEqual(result, input);
    assert.notEqual(result.content, content);
    assert.equal(result.structuredContent, structuredContent);
    assert.equal(result.content[1], image);
    assert.equal(result.content[3], content[3]);
    assert.equal(result.content[0].text.includes('"ok"'), isError !== true);
    assert.equal(content[0].text.includes("secret-value"), true);
  }
  for (const input of [null, undefined, false, {}, { content: {} }]) {
    assert.equal(cached.result(input), input);
    assert.equal(cached.result(input), legacy.result(input));
  }
  for (const input of [undefined, null, "file ok secret-value", { message: "file ok", code: "KEEP_CODE" },
    { message: "", code: 0 }, new Error("secret-value ok")]) {
    const actual = cached.error(input);
    const expected = legacy.error(input);
    assert.equal(actual.message, expected.message);
    assert.equal(actual.code, expected.code);
    assert.equal(actual.name, expected.name);
  }
});

test("deterministic collision corpus matches the legacy implementation", () => {
  let state = 73471;
  const random = (max) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const alphabet = ["a", "b", "_", "1", ".", "[", "]", "é", "😀", " ", "\n", "$"];
  const word = () => Array.from({ length: 1 + random(7) }, () => alphabet[random(alphabet.length)]).join("");
  for (let sample = 0; sample < 80; sample++) {
    const secrets = Array.from({ length: 1 + random(12) }, word);
    const source = secrets.map((password) => ({ password }));
    const inputs = Array.from({ length: 6 }, () => `${word()} ${secrets[random(secrets.length)]} ${word()}`);
    compareText(source, inputs);
  }
});

// Opt-in: $env:REDACTION_BENCHMARK='1'; node --test test/redaction-performance.test.mjs
// Timing is diagnostic only. Every measured call contributes to an equal-output checksum.
test("redaction microbenchmark", { skip: process.env.REDACTION_BENCHMARK !== "1" }, (t) => {
  const iterations = 5000;
  const rounds = 7;
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const scenarios = [
    { name: "empty", long: 0, short: 0 },
    { name: "1 long", long: 1, short: 0 },
    { name: "3 long", long: 3, short: 0 },
    { name: "8 long", long: 8, short: 0 },
    { name: "64 long", long: 64, short: 0 },
    { name: "64 long + 32 short", long: 64, short: 32 },
  ];
  t.diagnostic(`Node ${process.version}; strictText; 4 fixed input strings; ${rounds} rounds x ${iterations} calls; median milliseconds`);
  for (const scenario of scenarios) {
    const sources = [
      ...Array.from({ length: scenario.long }, (_, index) => ({ password: `fixture-secret-${String(index).padStart(4, "0")}` })),
      ...Array.from({ length: scenario.short }, (_, index) => ({ passphrase: `s${index}` })),
    ];
    const inputs = [
      "Uploaded /public/assets/app.js (17049 bytes); status ok, kind file, protocol sftp",
      "Échec de connexion : fixture-secret-0000 ; s0 ; connexion refusée",
      '{"status":"ok","path":"/site/index.html","bytes":1024}',
      "sftp://fixture:fixture-secret-0007@localhost/home fixture-secret-0031 s31",
    ];
    const legacy = createLegacyRedactor(...sources);
    const cached = createRedactor(...sources);
    for (const input of inputs) assert.equal(cached.strictText(input), legacy.strictText(input));
    function run(redactor, count) {
      let checksum = 0;
      const start = performance.now();
      for (let i = 0; i < count; i++) checksum += redactor.strictText(inputs[i % inputs.length]).length;
      return { elapsed: performance.now() - start, checksum };
    }
    run(legacy, 1000);
    run(cached, 1000);
    const before = [];
    const after = [];
    for (let round = 0; round < rounds; round++) {
      const first = round % 2 ? cached : legacy;
      const second = round % 2 ? legacy : cached;
      const a = run(first, iterations);
      const b = run(second, iterations);
      assert.equal(a.checksum, b.checksum);
      before.push(round % 2 ? b.elapsed : a.elapsed);
      after.push(round % 2 ? a.elapsed : b.elapsed);
    }
    const legacyMs = median(before);
    const cachedMs = median(after);
    t.diagnostic(`${scenario.name}: legacy ${legacyMs.toFixed(2)} ms; cached ${cachedMs.toFixed(2)} ms; ${(legacyMs / cachedMs).toFixed(2)}x`);
  }
});
