# Contributing to ftp-deploy-mcp

**English** | [Français](./CONTRIBUTING.fr.md)

Thanks for considering a contribution. This project intentionally stays small and
dependency-light — please read the principles below before opening a PR.

## Dev setup

```bash
git clone https://github.com/alebgl77/ftp-deploy-mcp.git
cd ftp-deploy-mcp
npm ci --ignore-scripts
npm test
```

`npm test` is the main code gate. It spins up real local FTP and SFTP servers
on loopback ports and runs the full e2e suite against them — no external
network access is required or used. Documentation-only changes should also
parse changed JSON examples, check relative Markdown links, and run
`git diff --check`.

## Updating the dependency graph

`package-lock.json` is the only authoritative lockfile; do not add a parallel
`npm-shrinkwrap.json`. The six direct production dependencies are exact pins.
Routine setup uses `npm ci --ignore-scripts` and must not rewrite the graph.

For an intentional update, change only the approved exact versions, regenerate
the source lockfile with lifecycle scripts disabled and the qualified npm version,
and record that npm version. Review every added, removed or changed graph entry,
including `resolved`, `integrity`, optional/platform constraints and install
hooks. Do not accept unrelated graph changes from an automatic update or audit
fix. Run a clean install, the affected tests, the dependency audit and exact
tarball/isolated-consumer checks in the [release guide](./docs/RELEASE.md).
Keep the source, manifest and lockfile changes together for review.

The source installation distribution contains 82 files, including this lockfile. The separate npm package contains 81 files without a lockfile and remains unqualified after ten observed changes in a real installation. Installed-graph checks compare transitive dependencies and peers against the original source inventory; any difference blocks npm/MCP publication.

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

Run the main smoke suite:

```bash
node test/smoke.test.js
```

Run the transport qualification and release gates separately:

```bash
node --test test/transport-qualification.js
npm run test:release
```

`npm test` runs the main smoke suite and transport qualification. Before
opening a PR, run both and any release gates affected by the change; keep
existing assertions enabled.

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

- matching package, lockfile, server and tag versions, then separately
  verifying npm and Official MCP Registry versions after publication;
- clean-tarball validation and end-to-end tests;
- npm Trusted Publishing/provenance and the short-lived `NPM_TOKEN` fallback
  needed only when first-publication bootstrapping requires it;
- manual MCP registry ownership and publication;
- post-publish verification and fix-forward rollback.

The npm package and MCP registry entry are not available until every applicable
manual prerequisite and verification step in that guide has passed.
