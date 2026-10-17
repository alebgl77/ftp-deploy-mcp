import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, resolveDurableConfig } from "../../src/config.js";
import { createDeploymentPlan } from "../../src/durable/plan.js";
import { openDurableState, projectDurableError } from "../../src/durable/state.js";
import { fakeAdapter, fixture, operation } from "./helpers.mjs";

function save(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); return loadConfig(file); }
function server(localRoot) { return { protocol: "sftp", host: "example.test", user: "deploy", password: "secret", localRoot }; }

test("durable config is strict, defaults requirePlan and normalizes the effective state policy", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "config.json");
  const loaded = save(file, { servers: { prod: server(f.localRoot) }, stateDir: f.stateDir });
  assert.equal(loaded.error, null);
  assert.deepEqual(resolveDurableConfig(loaded), { enabled: true, stateDir: f.stateDir, requirePlan: true, stateLimits: loaded.config.stateLimits });
  assert.equal(Object.keys(loaded.config.stateLimits).length, 9);

  const disabled = save(file, { servers: { prod: server(f.localRoot) } });
  assert.equal(disabled.error, null);
  assert.deepEqual(resolveDurableConfig(disabled), { enabled: false, stateDir: undefined, requirePlan: undefined, stateLimits: undefined });

  for (const extra of [{ unexpected: "credential-secret" }, { requirePlan: true }, { stateLimits: {} }]) {
    const invalid = save(file, { servers: { prod: server(f.localRoot) }, ...extra });
    assert.equal(invalid.config, null);
    assert.ok(invalid.error);
    assert.doesNotMatch(invalid.error, /credential-secret/);
  }
  for (const stateLimits of [{ unknown: 1 }, { maxPlanFiles: 0 }, null]) {
    const invalid = save(file, { servers: { prod: server(f.localRoot) }, stateDir: f.stateDir, stateLimits });
    assert.equal(invalid.config, null);
  }
});

test("stateDir accepts only normalized absolute canonical paths disjoint from every localRoot", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "config.json");
  const cases = [
    "relative-state",
    `${f.root}${path.sep}missing${path.sep}..${path.sep}state-two`,
    f.localRoot,
    path.join(f.localRoot, "state"),
  ];
  for (const stateDir of cases) {
    const loaded = save(file, { servers: { prod: server(f.localRoot) }, stateDir });
    assert.equal(loaded.config, null, stateDir);
  }

  const containingState = path.join(f.root, "containing-state");
  const nestedLocal = path.join(containingState, "local");
  await fsp.mkdir(nestedLocal, { recursive: true });
  assert.equal(save(file, { servers: { prod: server(nestedLocal) }, stateDir: containingState }).config, null);

  const valid = save(file, { servers: { prod: server(f.localRoot) }, stateDir: f.stateDir, requirePlan: false });
  assert.equal(valid.error, null);
  assert.equal(valid.config.requirePlan, false);

  const homeRelative = path.join("~", ".ftp-mcp-stage1-never-created");
  const expanded = save(file, { servers: { prod: server(f.localRoot) }, stateDir: homeRelative });
  assert.equal(expanded.error, null);
  assert.equal(expanded.config.stateDir, path.join(os.homedir(), ".ftp-mcp-stage1-never-created"));

  const invalidOverlap = save(file, { servers: {
    prod: server(path.join(f.localRoot, "missing-child")),
    usable: server(f.localRoot),
  }, defaultServer: "usable", stateDir: path.join(f.localRoot, "state") });
  assert.equal(invalidOverlap.config, null);
});

test("a localRoot retargeted to state after config load is rejected before planning or publication", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "config.json");
  const secret = "config-load-secret-canary";
  const loaded = save(file, { servers: { prod: { ...server(f.localRoot), password: secret } }, stateDir: f.stateDir });
  assert.equal(loaded.error, null);
  const initialized = await openDurableState({ loaded, create: true });
  const domainId = initialized.store.metadata.domainId;
  await initialized.close();

  await fsp.rm(f.localRoot, { recursive: true });
  await fsp.symlink(f.stateDir, f.localRoot, process.platform === "win32" ? "junction" : "dir");
  const adapter = fakeAdapter(loaded.config.servers.prod);
  let caught;
  try {
    await createDeploymentPlan({ loaded, input: { local_dir: "." }, adapter, operation: operation() });
  } catch (error) { caught = error; }
  assert.equal(caught?.code, "CONFIG_INVALID");
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await fsp.readdir(path.join(f.stateDir, "plans")), []);
  const projected = JSON.stringify(projectDurableError(caught));
  for (const forbidden of [secret, f.stateDir, domainId]) assert.equal(projected.includes(forbidden), false, forbidden);
});

test("state helper owns one store per operation signal and reports permission capability", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const first = await openDurableState({ loaded: f.loaded, signal: controller.signal, create: true });
  await assert.rejects(openDurableState({ loaded: f.loaded, signal: controller.signal, create: false }), { code: "DURABLE_STATE_BUSY" });
  assert.equal(first.warning, process.platform === "win32" ? "State directory ACLs were not verified on Windows." : null);
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(f.stateDir)).mode & 0o077, 0);
    assert.equal((await fsp.stat(path.join(f.stateDir, "domain.json"))).mode & 0o077, 0);
  }
  await first.close();
  const reopened = await openDurableState({ loaded: f.loaded, signal: controller.signal, create: false });
  await reopened.close();
});
