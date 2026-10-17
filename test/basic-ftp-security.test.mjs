import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("basic-ftp handles a malicious Unix listing without quadratic parser work", () => {
  const code = `
    import assert from "node:assert/strict";
    import { parseList } from "basic-ftp";
    const malicious = "-rw-r--r-- 1 " + "a ".repeat(64 * 1024) + "!\\r\\n";
    const valid = "-rw-r--r-- 1 owner group 42 Jan 1 2020 file.txt\\r\\n";
    assert.deepEqual(parseList(malicious + valid).map((file) => file.name), ["file.txt"]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `listing parser exceeded the CPU bound: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
});
