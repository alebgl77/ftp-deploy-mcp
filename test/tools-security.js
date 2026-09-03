import fs from "node:fs";
import path from "node:path";

import { registerTools } from "../src/tools.js";

const TEST_PIN = `SHA256:${Buffer.alloc(32, 9).toString("base64").replace(/=+$/, "")}`;
const TEST_SECRET = "local-tools-secret-must-not-leak";

function loadedFor(localRoot, extra = {}) {
  const entry = {
    protocol: "sftp",
    host: "test.invalid",
    user: "tester",
    password: TEST_SECRET,
    root: "/",
    hostKeySha256: TEST_PIN,
    ...extra,
  };
  if (localRoot !== undefined) entry.localRoot = localRoot;
  return {
    found: true,
    error: null,
    config: { servers: { test: entry } },
    serverNames: ["test"],
    invalidServerNames: [],
    serverErrors: {},
    defaultServer: "test",
  };
}

function capturedTools(loaded, openAdapter) {
  const handlers = new Map();
  registerTools(
    {
      registerTool(name, _definition, handler) {
        handlers.set(name, handler);
      },
    },
    loaded,
    { openAdapter }
  );
  return async (name, args = {}) => {
    const result = await handlers.get(name)(args, {});
    return {
      raw: result,
      isError: result.isError === true,
      text: (result.content || []).map((item) => item.text || "").join("\n"),
    };
  };
}

function basicAdapter(overrides = {}) {
  return {
    async list() {
      return [];
    },
    async uploadFile() {},
    async mkdirp() {},
    async downloadFile(_remote, local) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, "downloaded");
    },
    async close() {},
    ...overrides,
  };
}

function makeFiles(dir, names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
}

function makeJunction(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function firstLine(result) {
  return result.text.split(/\r?\n/, 1)[0];
}

export async function runToolsSecurityTests({ root, ok, contains, notContains }) {
  const localRoot = path.join(root, "root");
  const siblingRoot = path.join(root, "root2");
  const outsideRoot = path.join(root, "outside");
  makeFiles(localRoot, ["inside.txt"]);
  makeFiles(siblingRoot, ["sibling.txt"]);
  makeFiles(outsideRoot, ["outside.txt"]);

  let connects = 0;
  let uploadedPath = null;
  const openBasic = async () => {
    connects += 1;
    return basicAdapter({
      async uploadFile(local) {
        uploadedPath = local;
      },
    });
  };

  let call = capturedTools(loadedFor(undefined), openBasic);
  let result = await call("ftp_upload", { local_path: "inside.txt" });
  ok(result.isError && result.text.includes("localRoot"), "local jail: missing localRoot has migration guidance", result.text);
  ok(connects === 0, "local jail: missing localRoot is rejected before network I/O", String(connects));

  call = capturedTools(loadedFor("relative/root"), openBasic);
  result = await call("ftp_deploy", { local_dir: ".", dry_run: true });
  ok(result.isError && result.text.includes("relative") && result.text.includes("absolute"), "local jail: relative localRoot is refused", result.text);
  ok(connects === 0, "local jail: invalid dry-run performs no network I/O", String(connects));

  call = capturedTools(loadedFor(localRoot), openBasic);
  result = await call("ftp_upload", { local_path: "inside.txt" });
  ok(!result.isError && uploadedPath === fs.realpathSync(path.join(localRoot, "inside.txt")), "local jail: relative source resolves under localRoot", result.text);

  uploadedPath = null;
  result = await call("ftp_upload", { local_path: path.join(localRoot, "inside.txt") });
  ok(!result.isError && uploadedPath === fs.realpathSync(path.join(localRoot, "inside.txt")), "local jail: absolute source inside localRoot is accepted", result.text);

  const beforeEscape = connects;
  result = await call("ftp_upload", { local_path: path.join("..", "outside.txt") });
  ok(result.isError && result.text.includes("escapes"), "local jail: parent traversal is refused", result.text);
  ok(connects === beforeEscape, "local jail: parent traversal is refused before network I/O", String(connects));

  result = await call("ftp_upload", { local_path: path.join(siblingRoot, "sibling.txt") });
  ok(result.isError && result.text.includes("localRoot"), "local jail: sibling prefix root2 is not mistaken for root", result.text);

  const outsideLink = path.join(localRoot, "outside-link");
  makeJunction(outsideRoot, outsideLink);
  const beforeLinks = connects;
  result = await call("ftp_upload", { local_path: path.join("outside-link", "outside.txt") });
  ok(result.isError && /symbolic link|junction/.test(result.text), "local jail: upload through an escaping junction is refused", result.text);
  result = await call("ftp_deploy", { local_dir: "outside-link" });
  ok(result.isError && /symbolic link|junction/.test(result.text), "local jail: deploy through an escaping junction is refused", result.text);
  result = await call("ftp_download", { remote_path: "remote.txt", local_path: path.join("outside-link", "new.txt") });
  ok(result.isError && /symbolic link|junction/.test(result.text), "local jail: download through a junction is refused", result.text);
  ok(connects === beforeLinks, "local jail: escaping junctions are rejected before network I/O", String(connects));

  result = await call("ftp_download", { remote_path: "remote.txt", local_path: path.join("new", "nested", "file.txt") });
  ok(!result.isError && fs.readFileSync(path.join(localRoot, "new", "nested", "file.txt"), "utf8") === "downloaded", "local jail: absent internal download destination is accepted", result.text);

  const absoluteDestination = path.join(localRoot, "absolute", "file.txt");
  result = await call("ftp_download", { remote_path: "remote.txt", local_path: absoluteDestination });
  ok(!result.isError && fs.readFileSync(absoluteDestination, "utf8") === "downloaded", "local jail: absolute destination inside localRoot is accepted", result.text);

  const overwriteTarget = path.join(outsideRoot, "overwrite-target.txt");
  fs.writeFileSync(overwriteTarget, "outside");
  const overwriteLink = path.join(localRoot, "overwrite-link.txt");
  try {
    fs.symlinkSync(overwriteTarget, overwriteLink, "file");
  } catch (err) {
    if (!err || err.code !== "EPERM") throw err;
    const overwriteDir = path.join(outsideRoot, "overwrite-dir");
    fs.mkdirSync(overwriteDir, { recursive: true });
    makeJunction(overwriteDir, overwriteLink);
  }
  const beforeOverwrite = connects;
  result = await call("ftp_download", {
    remote_path: "remote.txt",
    local_path: "overwrite-link.txt",
    overwrite: true,
  });
  ok(result.isError && /symbolic link|junction/.test(result.text), "local jail: overwrite through an existing link is refused", result.text);
  ok(connects === beforeOverwrite, "local jail: linked overwrite is rejected before network I/O", String(connects));
  ok(fs.readFileSync(overwriteTarget, "utf8") === "outside", "local jail: refused overwrite leaves the outside target untouched");

  const beforeDry = connects;
  result = await call("ftp_deploy", { local_dir: ".", dry_run: true });
  ok(!result.isError && result.text.includes("No connection was made"), "local jail: valid dry-run succeeds inside localRoot", result.text);
  ok(connects === beforeDry, "local jail: valid dry-run performs zero network I/O", String(connects));

  call = capturedTools(loadedFor(undefined), openBasic);
  result = await call("ftp_list", { path: "" });
  ok(!result.isError, "local jail: remote-only tools remain usable without localRoot", result.text);

  const runDeploy = async (caseName, fileNames, adapterOverrides) => {
    const dir = path.join(localRoot, caseName);
    makeFiles(dir, fileNames);
    const deployCall = capturedTools(
      loadedFor(localRoot),
      async () => basicAdapter(adapterOverrides)
    );
    return deployCall("ftp_deploy", { local_dir: caseName, remote_dir: caseName });
  };

  result = await runDeploy("partial-one", ["a.txt", "b.txt"], {
    async uploadFile(_local, remote) {
      if (remote.endsWith("b.txt")) throw new Error("selected failure detail");
    },
  });
  ok(result.isError && firstLine(result) === "PARTIAL DEPLOY — ERROR", "partial deploy: one success plus one failure is an MCP error", result.text);
  contains(result.text, "a.txt", "partial deploy: successful upload detail is preserved");
  contains(result.text, "selected failure detail", "partial deploy: failure detail is preserved");

  result = await runDeploy("partial-all", ["a.txt", "b.txt"], {
    async uploadFile() {
      throw new Error("all uploads failed");
    },
  });
  ok(result.isError && firstLine(result) === "PARTIAL DEPLOY — ERROR" && result.text.includes("0/2"), "partial deploy: all failures are an MCP error", result.text);

  result = await runDeploy(
    "partial-abort",
    ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt", "6.txt", "7.txt"],
    {
      async uploadFile() {
        throw new Error("consecutive failure");
      },
    }
  );
  ok(result.isError && firstLine(result) === "PARTIAL DEPLOY — ERROR" && result.text.includes("ABORTED"), "partial deploy: early stop is an MCP error", result.text);

  result = await runDeploy("partial-success", ["a.txt", "b.txt"], {});
  ok(!result.isError && firstLine(result).startsWith("Deployed 2/2"), "partial deploy: complete upload and clean close is success", result.text);

  result = await runDeploy("partial-close", ["a.txt"], {
    async close() {
      throw new Error("close failure detail");
    },
  });
  ok(result.isError && firstLine(result) === "PARTIAL DEPLOY — ERROR", "partial deploy: close failure is an MCP error", result.text);
  contains(result.text, "close failure detail", "partial deploy: close failure detail is preserved");

  const connectFailureCall = capturedTools(loadedFor(localRoot), async () => {
    throw new Error("connect failure detail");
  });
  result = await connectFailureCall("ftp_deploy", { local_dir: "partial-success" });
  ok(result.isError && firstLine(result) === "PARTIAL DEPLOY — ERROR", "partial deploy: connection failure is an MCP error with the partial header", result.text);
  contains(result.text, "connect failure detail", "partial deploy: connection failure detail is preserved");

  const transportCall = capturedTools(
    loadedFor(localRoot, {
      protocol: "ftp",
      root: "/subroot",
      allowInsecure: true,
      allowUnsafeRemoteRoot: true,
      hostKeySha256: undefined,
    }),
    async () => basicAdapter({
      async uploadFile() {
        throw new Error("transport partial");
      },
    })
  );
  result = await transportCall("ftp_deploy", { local_dir: "partial-close" });
  contains(result.text, "allowInsecure", "transport notices: partial error includes insecure-transport warning");
  contains(result.text, "allowUnsafeRemoteRoot", "transport notices: partial error includes unsafe-root warning");
  notContains(result.text, TEST_SECRET, "local tools: errors and notices never expose the configured password");
}
