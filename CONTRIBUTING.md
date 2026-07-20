# Contributing to ftp-deploy-mcp

Thanks for considering a contribution. This project intentionally stays small and
dependency-light — please read the principles below before opening a PR.

## Dev setup

```bash
git clone https://github.com/alebgl77/ftp-deploy-mcp.git
cd ftp-deploy-mcp
npm install
npm test
```

`npm test` is the **only** gate. It spins up real local FTP and SFTP servers on
loopback ports and runs the full e2e assertion suite against them — no external
network access is required or used.

## Principles

- **Plain ESM JavaScript.** No TypeScript, no bundler, no build step. What's in
  `src/` is what runs.
- **No new runtime dependencies without discussion.** Open an issue first if you
  think one is needed — `dependencies` in `package.json` are kept deliberately
  minimal.
- **Every feature lands with smoke-test assertions.** New tools, options, or
  behaviors are not considered done until they're covered in
  `test/smoke.test.js`.
- **`stdout` in server mode is JSON-RPC only.** Never `console.log` from the MCP
  server path — anything written to stdout is a wire-protocol message.
  Diagnostics and human-facing output belong on `stderr` or in `doctor`/`setup`
  (non-server) commands.

## Running part of the suite

The whole suite lives in a single file:

```bash
node test/smoke.test.js
```

There is currently no sub-suite filtering — the file is small enough to run in
full. If you're iterating on one area, comment out unrelated assertions locally
while you work, but make sure the full file is restored and green before
opening a PR.

## PR checklist

- [ ] `npm test` passes (189/189 or the current total).
- [ ] No new runtime dependency, or it was discussed in an issue first.
- [ ] New/changed behavior has matching smoke-test assertions.
- [ ] Docs updated in both `README.md` (English) and `README.fr.md` (French) if
      user-facing behavior changed.

## Releasing (maintainers)

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit and tag the release (e.g. `git tag v0.2.0`).
3. Push the tag, then run the **Release (npm)** GitHub Actions workflow manually
   (`workflow_dispatch`) to publish to npm.
