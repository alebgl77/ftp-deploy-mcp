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

`npm test` is the main code gate. It spins up real local FTP and SFTP servers
on loopback ports and runs the full e2e suite against them — no external
network access is required or used. Documentation-only changes should also
parse changed JSON examples, check relative Markdown links, and run
`git diff --check`.

## Principles

- **Plain ESM JavaScript.** No TypeScript, no bundler, no build step. What's in
  `src/` is what runs.
- **No new runtime dependencies without discussion.** Open an issue first if you
  think one is needed — `dependencies` in `package.json` are kept deliberately
  minimal.
- **Every feature lands with smoke-test assertions.** New tools, options, or
  behaviors are not considered done until they're covered in
  `test/smoke.test.js`.
- **Security claims match protocol reality.** FTP/FTPS client-side sub-roots
  are not described as a symlink-safe jail; a dedicated server-side
  account/chroot is the boundary. SFTP protections must document the residual
  server-side race.
- **Source and published availability are distinct.** Do not advertise `npx`
  or MCP registry installation until the corresponding artifact is public and
  independently verified.
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

- [ ] `npm test` passes (use the current total; do not hard-code it in docs).
- [ ] No new runtime dependency, or it was discussed in an issue first.
- [ ] New/changed behavior has matching smoke-test assertions.
- [ ] Docs updated in both `README.md` (English) and `README.fr.md` (French) if
      user-facing behavior changed.
- [ ] New configuration examples are strict JSON and relative Markdown links
      resolve.
- [ ] Security-sensitive changes are reflected in
      [docs/SECURITY-MODEL.md](./docs/SECURITY-MODEL.md).

## Releasing (maintainers)

Do not improvise the first publication from this short section. Follow the
[release guide](./docs/RELEASE.md), which covers:

- matching package, lockfile, server, tag, npm, and MCP registry versions;
- clean-tarball validation and end-to-end tests;
- npm Trusted Publishing/provenance and the short-lived `NPM_TOKEN` fallback
  needed only when first-publication bootstrapping requires it;
- manual MCP registry ownership and publication;
- post-publish verification and fix-forward rollback.

The npm package and MCP registry entry are not available until every applicable
manual prerequisite and verification step in that guide has passed.
