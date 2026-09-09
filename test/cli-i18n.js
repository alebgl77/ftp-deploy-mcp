import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CATALOGS, createI18n, extractLanguage, affirmative, negative } from "../src/i18n.js";
import { buildEntry } from "../src/clients.js";
import { parseSiteManager, buildConfig } from "../src/filezilla.js";
import { manualEntry, reviewInsecureServers, connectionHint } from "../src/setup.js";

const index = fileURLToPath(new URL("../src/index.js", import.meta.url));
const en = createI18n();
const fr = createI18n("fr");
const secret = "cli_i18n_secret_9271";
const xml = `<FileZilla3><Servers>
  <Server><Name>Site Principal</Name><Host>example.invalid</Host><Protocol>0</Protocol><User>alice</User><Pass>${secret}</Pass></Server>
  <Server><Name>${secret}</Name><Host>example.invalid</Host><Protocol>99</Protocol></Server>
  <Server><Name>Sans secret</Name><Host>example.invalid</Host><Protocol>1</Protocol><User>alice</User></Server>
</Servers></FileZilla3>`;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-cli-i18n-"));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ftp-cli-i18n-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}

function isolatedEnv(dir, overrides = {}) {
  const env = { ...process.env };
  for (const key of ["FTP_MCP_CONFIG", "FTP_MCP_LANG", "NODE_OPTIONS", "CLI_I18N_UNSET_9271"]) delete env[key];
  return { ...env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"), ...overrides };
}

function cli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [index, ...args], {
    cwd: dir, env: isolatedEnv(dir, env), encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

function writeConfig(dir, servers) {
  const file = path.join(dir, ".ftp-mcp", "servers.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ servers }));
  return file;
}

function fakeQuestions(answers, prompts = []) {
  const pending = [...answers];
  return { async question(query) {
    prompts.push(query);
    assert.ok(pending.length > 0, "unexpected extra prompt: " + query);
    return pending.shift();
  }, assertComplete() { assert.equal(pending.length, 0); } };
}

test("catalogs have identical keys and placeholder contracts", () => {
  assert.deepEqual(Object.keys(CATALOGS.fr).sort(), Object.keys(CATALOGS.en).sort());
  const names = (text) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
  for (const [key, value] of Object.entries(CATALOGS.en)) {
    assert.deepEqual(names(CATALOGS.fr[key]), names(value), key);
    const params = Object.fromEntries(names(value).map((name) => [name, "VALUE_" + name]));
    assert.equal(typeof en.t(key, params), "string");
    assert.equal(typeof fr.t(key, params), "string");
  }
});

test("translator snapshots are immutable, fallback is English, parameters are literal", () => {
  assert.ok(Object.isFrozen(fr));
  assert.ok(Object.isFrozen(CATALOGS.fr));
  const messages = { "cli.unknown": "Initial: {command}" };
  const custom = createI18n("fr", messages);
  messages["cli.unknown"] = "Changed";
  const literal = "{command} ${ENV:SECRET} $&";
  assert.equal(custom.t("cli.unknown", { command: literal }), "Initial: " + literal);
  assert.equal(custom.t("setup.banner"), en.t("setup.banner"));
  assert.throws(() => fr.t("unknown.namespace"), /Unknown translation key/);
  assert.throws(() => fr.t("cli.unknown"), /Missing translation parameter/);
  assert.throws(() => createI18n("de"), /en or fr/);
});

test("language precedence is explicit, exact, and independent of OS locale", () => {
  assert.equal(extractLanguage([], { LANG: "fr_FR.UTF-8", LC_ALL: "fr" }).locale, "en");
  assert.equal(extractLanguage([], { FTP_MCP_LANG: "fr" }).locale, "fr");
  assert.deepEqual(extractLanguage(["setup", "--lang", "en", "--yes"], { FTP_MCP_LANG: "fr" }), { argv: ["setup", "--yes"], locale: "en" });
  assert.equal(extractLanguage(["--lang=fr", "doctor"], { FTP_MCP_LANG: "invalid" }).locale, "fr");
  for (const value of ["", "FR", "fr-FR", "de"]) assert.throws(() => extractLanguage([], { FTP_MCP_LANG: value }));
  for (const args of [["--lang"], ["--lang", "--help"], ["--lang="], ["--lang", "de", "--lang", "fr"]]) {
    assert.throws(() => extractLanguage(args, {}));
  }
});

test("main and command-specific help are French via env and CLI", (t) => {
  const dir = scratch(t);
  for (const [command, phrase] of [[null, "Utilisation"], ["setup", "Assistant|Crée ou importe"], ["doctor", "Diagnostic sans modification"], ["import-filezilla", "Importe les sites"]]) {
    const result = cli(dir, [...(command ? [command] : []), "--help"], { FTP_MCP_LANG: "fr" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(phrase));
    assert.match(result.stdout, /--lang en\|fr/);
  }
  const english = cli(dir, ["--lang", "en", "--help"], { FTP_MCP_LANG: "fr" });
  assert.match(english.stdout, /Usage:/);
  assert.equal(cli(dir, ["doctor", "--help", "--lang=fr"], { FTP_MCP_LANG: "invalid" }).status, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("invalid language fails before setup/import writes and before help", (t) => {
  const dir = scratch(t);
  const fixture = path.join(dir, "sites.xml");
  fs.writeFileSync(fixture, xml);
  const destination = path.join(dir, "output.json");
  const commands = [
    ["setup", "--yes", "--from-filezilla", fixture, "--home", dir, "--skip-test", "--lang", "de"],
    ["import-filezilla", "--file", fixture, "--out", destination, "--lang"],
    ["setup", "--yes", "--home", dir, "--lang", "--help"],
    ["--help", "--lang="],
  ];
  for (const args of commands) {
    const result = cli(dir, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
  assert.notEqual(cli(dir, ["setup", "--yes", "--home", dir], { FTP_MCP_LANG: "invalid" }).status, 0);
  assert.deepEqual(fs.readdirSync(dir), ["sites.xml"]);
});

test("FileZilla translation preserves protocol/config values and redacts diagnostics", (t) => {
  const dir = scratch(t);
  const parsedEn = parseSiteManager(xml, en);
  const parsedFr = parseSiteManager(xml, fr);
  assert.deepEqual(buildConfig(parsedFr), buildConfig(parsedEn));
  assert.ok(parsedFr.warnings.some((warning) => warning.includes("non pris en charge")));
  assert.equal(parsedFr.servers["site-principal"].password, secret);
  assert.equal(parsedFr.servers["site-principal"].protocol, "ftp");
  const fixture = path.join(dir, "sites.xml");
  const destination = path.join(dir, "output.json");
  fs.writeFileSync(fixture, xml);
  const result = cli(dir, ["import-filezilla", "--file", fixture, "--out", destination, "--lang", "fr"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /serveur\(s\) importé\(s\)/);
  assert.match(result.stderr, /Avertissement/);
  assert.ok(!result.stderr.includes(secret));
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), buildConfig(parsedEn));
  const jsonOnly = cli(dir, ["import-filezilla", "--file", fixture, "--lang", "fr"]);
  assert.deepEqual(JSON.parse(jsonOnly.stdout), buildConfig(parsedEn));
  const before = fs.readFileSync(destination);
  const second = cli(dir, ["import-filezilla", "--file", fixture, "--out", destination, "--lang", "fr"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /existe déjà/);
  assert.deepEqual(fs.readFileSync(destination), before);
});

test("setup persists French in client config and never prints imported secrets", (t) => {
  const dir = scratch(t);
  const fixture = path.join(dir, "sites.xml");
  fs.writeFileSync(fixture, xml);
  const result = cli(dir, ["setup", "--lang", "fr", "--yes", "--from-filezilla", fixture, "--home", dir, "--clients", "cursor", "--skip-test"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Récapitulatif/);
  assert.match(result.stdout, /fichier créé/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  const client = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.equal(client.mcpServers.ftp.env.FTP_MCP_LANG, "fr");
  const config = JSON.parse(fs.readFileSync(path.join(dir, ".ftp-mcp", "servers.json"), "utf8"));
  assert.equal(config.servers["site-principal"].password, secret);
  assert.notEqual(config.servers["site-principal"].allowInsecure, true);
});

test("setup connection diagnostics retain French without opening insecure transport", (t) => {
  const dir = scratch(t);
  writeConfig(dir, {
    refus: { protocol: "ftp", host: "example.invalid", user: "alice", password: secret, root: "/" },
    absent: { protocol: "sftp", host: "example.invalid", user: "alice", password: "${ENV:CLI_I18N_UNSET_9271}" },
  });
  const result = cli(dir, ["setup", "--yes", "--home", dir, "--clients", "none", "--lang", "fr"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test des connexions/);
  assert.match(result.stdout, /CONNEXION NON SÉCURISÉE REFUSÉE/); // First-party business diagnostic follows the selected locale.
  assert.match(result.stdout, /passez ce serveur en sftp/);
  assert.match(result.stdout, /ignoré \(définissez d’abord ENV CLI_I18N_UNSET_9271\)/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test("doctor is useful in French, redacted, and read-only", (t) => {
  const dir = scratch(t);
  const file = writeConfig(dir, { prod: { protocol: "ftp", host: "example.invalid", user: "alice", password: secret, root: "/site", readOnly: true } });
  const before = fs.readFileSync(file);
  const result = cli(dir, ["doctor", "--home", dir], { FTP_MCP_LANG: "fr" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diagnostic/);
  assert.match(result.stdout, /lecture seule/);
  assert.match(result.stdout, /connexions REFUSÉES/);
  assert.match(result.stdout, /aucun fichier de configuration/);
  assert.ok(!result.stdout.includes(secret));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(dir), [".ftp-mcp"]);
});

test("French yes/no answers and key choice work in the interactive setup path", async () => {
  for (const answer of ["yes", "Y", "oui", "O", " Oui "]) assert.equal(affirmative(answer), true);
  for (const answer of ["no", "N", "non", " Non "]) assert.equal(negative(answer), true);
  assert.equal(affirmative("non"), false);
  assert.equal(negative("oui"), false);
  const prompts = [];
  const questions = fakeQuestions(["site", "sftp", "example.invalid", "", "alice", "clé", "/fake/key", "", "/site", "oui", "non"], prompts);
  const output = [];
  const result = await manualEntry(questions, (line) => output.push(line), fr);
  questions.assertComplete();
  assert.equal(result.config.servers.site.privateKeyPath, "/fake/key");
  assert.equal(result.config.servers.site.readOnly, true);
  assert.equal(result.config.servers.site.password, undefined);
  assert.ok(prompts.some((prompt) => prompt.includes("Authentification (mot de passe/clé)")));
  assert.ok(prompts.some((prompt) => prompt.includes("Lecture seule")));
});

test("French sensitive confirmations still require the announced insecure token", async () => {
  for (const [answer, expected] of [["oui", 0], ["non", 0], ["insecure", 1]]) {
    const config = { servers: { prod: { protocol: "ftp", host: "example.invalid", user: "alice", password: secret } } };
    const prompts = [];
    const questions = fakeQuestions([answer], prompts);
    const output = [];
    assert.equal(await reviewInsecureServers(config, questions, (line) => output.push(line), fr), expected);
    assert.equal(config.servers.prod.allowInsecure === true, expected === 1);
    assert.ok(prompts[0].includes('Tapez exactement "insecure"'));
    assert.ok(output.join("\n").includes("REFUSÉES par défaut"));
  }
});

test("connection hints accept native codes and translated timeout messages", () => {
  for (const error of [new Error("connection timed out"), new Error(fr.t("connection.timeout")), Object.assign(new Error("opaque"), { code: "ETIMEDOUT" })]) {
    assert.equal(connectionHint(error, fr), fr.t("connection.timeoutHint"));
  }
  assert.equal(connectionHint(Object.assign(new Error("opaque"), { code: "ENOTFOUND" }), fr), fr.t("connection.hostHint"));
  assert.equal(connectionHint(Object.assign(new Error("opaque"), { code: "ECONNREFUSED" }), fr), fr.t("connection.refusedHint"));
  assert.equal(connectionHint(new Error("Authentication failed"), fr), fr.t("connection.authHint"));
});

test("client language propagation is explicit without altering legacy callers", () => {
  assert.deepEqual(buildEntry({ absIndexJs: "/app/index.js", configPath: null }), { command: "node", args: ["/app/index.js"] });
  for (const locale of ["en", "fr"]) {
    assert.deepEqual(buildEntry({ absIndexJs: "/app/index.js", configPath: "/config.json", locale }).env, { FTP_MCP_CONFIG: "/config.json", FTP_MCP_LANG: locale });
  }
  assert.throws(() => buildEntry({ absIndexJs: "/app/index.js", locale: "de" }));
});

test("French MCP startup diagnostics stay on stderr with real SDK stdio", { timeout: 15000 }, async (t) => {
  const dir = scratch(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [index, "--lang", "fr", "--config", path.join(dir, "missing.json")],
    cwd: dir, env: isolatedEnv(dir), stderr: "pipe" });
  let diagnostics = "";
  transport.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  const client = new Client({ name: "cli-i18n-test", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 10);
    assert.ok(listed.tools.some((tool) => tool.name === "ftp_upload"));
    assert.match(diagnostics, /configuration :/);
    assert.match(diagnostics, /problème de configuration/);
  } finally {
    await client.close();
  }
});
