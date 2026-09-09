# Changelog

**English** | [Français](./CHANGELOG.fr.md)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-09

The GitHub tag and release are cut from this commit. Publication to npm and to
the MCP registry is still pending, so `npx -y ftp-deploy-mcp` and registry-based
installation do not work yet; install from source. Package and server metadata
are aligned at 0.2.0. All changes below are relative to 0.1.0, the only version
ever released.

### Added

- Bilingual command line. `--lang en` and `--lang fr` (also `--lang=fr`) select
  the language of general and subcommand help, `setup` prompts and choices,
  connection-test labels, `doctor` diagnostics, `import-filezilla` warnings and
  server startup messages. The new `FTP_MCP_LANG` environment variable sets the
  same default, and the option takes precedence over it, including over an
  invalid environment value. The option is read before the subcommand parser and
  may appear before or after the subcommand. Only `en` and `fr` are accepted; an
  invalid or incomplete option exits unsuccessfully before `setup` or
  `import-filezilla` writes anything. OS locale variables such as `LANG` are
  never consulted. See [languages](./docs/LANGUAGES.md).
- Localized MCP contracts. Tool titles, descriptions, input field descriptions,
  business success text and error messages follow the selected language. The ten
  tool names, structured result field names and public error codes are stable and
  are not translated, and no tool argument selects a language.
- `setup` writes `FTP_MCP_LANG` into the MCP client entries it generates,
  including `en`, so a configured server keeps its setup language after a
  restart. The paste-ready Trae snippet carries the same setting.
- Structured error envelope on every tool error. Alongside the `isError` text,
  results now carry `structuredContent.error` with `schema_version`, `code`,
  `message`, `retryable`, a per-call `request_id` UUID, `next_action` and
  `effects`. Upload, download and deployment errors can add a strict `partial`
  block (`completed_files`, `completed_bytes`, `failed_files`, optional
  `total_files`, and `final`). `request_id` is not a durable operation
  identifier; there is no journal, rollback or recovery command. This release
  returns `retryable: false` for every error and never retries an uncertain
  mutation. See the [error contract](./docs/ERROR-CONTRACT.md).
- Six per-server configuration keys, each with an enforced default and maximum.
  Tool arguments cannot override them, and values must be positive safe integers:
  `operationTimeoutMs` (default 120000 ms, accepted range 100–3600000),
  `maxTransferBytes` (default 268435456, maximum 1099511627776),
  `maxDeployFiles` (default 10000, maximum 100000),
  `maxDeployBytes` (default 1073741824, maximum 1099511627776),
  `maxScanEntries` (default 100000, maximum 1000000) and
  `maxScanDepth` (default 64, maximum 256). These defaults apply to servers that
  do not set them, so a deployment that succeeded on 0.1.0 can now be refused
  with `TRANSFER_LIMIT` or `SCAN_LIMIT` before any connection is opened.
  **BREAKING — `operationTimeoutMs` also introduces a deadline 0.1.0 never
  had:** every tool call now aborts with `TIMEOUT` after 120000 ms by default,
  and unlike the other limits it fires mid-flight rather than refusing up
  front, so a large or slow `ftp_deploy` that ran to completion on 0.1.0 can
  stop part-way with files already promoted and no rollback. Raise
  `operationTimeoutMs` (up to 3600000) for slow links. See
  [verified transfers](./docs/TRANSFERS.md) and
  [resource limits](./docs/RESOURCE-BOUNDS.md).
- Process-wide admission control. One Node isolate admits at most 64 concurrent
  tool calls; the 65th returns the new `CAPACITY_LIMIT` with `effects:none`,
  `retryable:false` and `next_action:retry`. This is a concurrency cap, not a
  lifetime quota: a slot is released when its worker and cleanup actually settle,
  including after cancellation or timeout, and there is no queue or automatic
  retry. Admission happens after schema validation and before preparation.
- MCP cancellation and per-call deadlines. A peer `notifications/cancelled`
  aborts the operation and the SDK suppresses its result, so clients must not
  expect a delivered `CANCELLED` envelope; the separate internal deadline
  returns `TIMEOUT`. Cancellation and expiry stop later stages and close the
  transport, but do not undo effects already accepted by the server. A public
  transport decorator corrects the installed SDK's cancellation gap for the
  numeric correlation ID `0` and the empty string `""`; other IDs, including the
  string `"0"`, keep native SDK behaviour.
- Serialized mutations. Writing tools take a FIFO lock on the remote endpoint
  (protocol, host, port, user) and `ftp_download` takes one on the canonical
  local destination, so two calls cannot interleave writes on the same target.
  Locks are held until the underlying worker actually settles, not until the
  response is sent, and they coordinate only within one Node.js process.
- Per-server `localRoot` boundary for `ftp_upload`, `ftp_deploy`, and
  `ftp_download`. The root must be absolute (with `~` expansion supported);
  traversal and local symlink/junction escapes are refused.
- SFTP host-key pinning through `hostKeySha256`, accepting one SHA-256
  fingerprint or a non-empty array for controlled key rotation.
- Explicit `allowUnknownHostKey` override for operators who temporarily accept
  an unverified SFTP server identity.
- Explicit `allowUnsafeRemoteRoot` override for FTP/FTPS operators who accept
  the unresolved symlink risk of a client-side sub-root.
- MCP output schemas and successful structured responses for every tool except
  the intentionally text-only `ftp_read`, plus annotations for all ten tools.
- Bilingual documentation set, each page in English and French:
  [security model](./docs/SECURITY-MODEL.md),
  [release process](./docs/RELEASE.md),
  [error contract](./docs/ERROR-CONTRACT.md),
  [languages](./docs/LANGUAGES.md),
  [verified transfers](./docs/TRANSFERS.md),
  [resource limits](./docs/RESOURCE-BOUNDS.md),
  [state storage](./docs/STATE-STORAGE.md),
  [workflow model](./docs/WORKFLOW-MODEL.md) and
  [scripted MCP conformance](./docs/SCRIPTED-EVALUATIONS.md). `CONTRIBUTING`,
  `SECURITY`, `LICENSE` and this changelog gain French counterparts, joining the
  `README` pair that already shipped in 0.1.0; both `README` languages were
  rewritten for this release.
- A bilingual interactive HTML guide under `site/`, generated from
  `site/project-data.json` and `site/i18n.json` and verified in CI by
  `scripts/build-guide.mjs --check`. It lives in the repository only and is
  excluded from the npm package.
- A reproducible, external read-only agent evaluation fixture and 10-question
  MCP evaluation set, now in English (`evaluations/read-only.xml`) and French
  (`evaluations/read-only.fr.xml`), plus a separate scripted conformance runner
  of 43 scenarios executed in both languages against the real MCP SDK client and
  in-memory transport (`npm run eval:scripted`). The runner is repository
  tooling, is not an LLM benchmark, and is excluded from the npm package. See
  [scripted MCP conformance](./docs/SCRIPTED-EVALUATIONS.md).
- Internal, inert libraries `src/state/` and `src/workflow/`. They ship inside
  the package because it publishes `src`, but they expose no MCP tool, read no
  configuration, create no state directory and are not imported by the running
  server. They deliver no deployment workflow, rollback or recovery in this
  release; both [state storage](./docs/STATE-STORAGE.md) and the
  [workflow model](./docs/WORKFLOW-MODEL.md) state this explicitly.
- Contributor-facing npm scripts: `test:transports`, `test:contract`,
  `test:bounds`, `test:state`, `test:workflow`, `test:eval-runner` and
  `eval:scripted`. CI additionally runs `scripts/check-docs.mjs` for bilingual
  documentation and `test/release-gates.js`.
- `server.json` MCP registry metadata, declaring the `FTP_MCP_CONFIG` and
  `FTP_MCP_LANG` environment variables and a stdio transport.
- A repository `Dockerfile` and `.dockerignore` building a `node:24-alpine`
  image whose entrypoint is the stdio server; mount a configuration file and
  point `FTP_MCP_CONFIG` at it. No image is published, and neither file is
  included in the npm package.

### Changed

- **BREAKING — Node.js 18, 19, 20 and 21 are no longer supported.**
  `engines.node` moves from `>=18` to `>=22`. CI qualifies Node 22 and 24 on
  Linux, Windows and macOS.
- **BREAKING — an explicit configuration selector now fails closed.** When
  `--config <path>` or `FTP_MCP_CONFIG` is present, that single path is
  authoritative: it must exist, be a regular file and load successfully, and no
  other candidate is attempted. `--config` takes priority over
  `FTP_MCP_CONFIG`, and an empty explicit value is rejected. Only when neither
  is set does discovery still try `./ftp-servers.json` then
  `~/.ftp-mcp/servers.json`. In 0.1.0 both selectors were merely the first
  entries of a fallback list, so a missing or unreadable explicit path silently
  fell through to another file. The server still starts; every tool that needs
  the configuration now fails with `CONFIG_INVALID` instead of operating on an
  unintended configuration, and `ftp_list_servers` returns `status: "invalid"`
  with the loader diagnostic.
- One rejected server entry no longer disables the whole configuration. Entries
  are validated individually: valid servers stay usable, and each invalid one is
  reported by name with its reason through `ftp_list_servers` (`status`,
  `valid_count`, `invalid_count` and a bounded `errors` list). Naming a rejected
  entry returns that entry's `CONFIG_INVALID`, an unknown name
  returns `SERVER_UNKNOWN`, and omitting `server` with several valid candidates
  and no `defaultServer` returns `SERVER_REQUIRED`. In 0.1.0 the first invalid
  entry made the entire file unusable and every tool call failed. Envelope
  problems — no `servers` object, an empty one, an unknown `defaultServer`, an
  unset `${ENV:VAR}` — still reject the whole file, as does a file in which
  every entry is invalid.
- **BREAKING — `localRoot` is now required** by `ftp_upload`, `ftp_deploy` and
  `ftp_download`, **and relative tool paths now resolve against it instead of
  the server process's working directory.** A server entry without an absolute
  `localRoot` refuses those three tools with `CONFIG_INVALID`. In 0.1.0
  `local_path` and `local_dir` resolved against `process.cwd()`, so an unchanged
  call such as `ftp_deploy {"local_dir":"dist"}` now reads `<localRoot>/dist`
  instead of `<cwd>/dist` — it can silently select a different directory, or
  fail with `NOT_FOUND` or `PATH_REJECTED` when the old target sits outside the
  root. Absolute paths keep their meaning and must still resolve inside
  `localRoot`. `ftp_list_servers` reports each server's `localRoot` status.
- Tool errors are no longer text-only. Every error result now carries the
  structured `{error}` envelope described above, and the nine tools with an
  output schema publish a JSON Schema draft-07 `oneOf` of their success object
  and that envelope. `ftp_read` keeps text-only success and no output schema;
  its errors still use the same internally validated envelope. Existing text
  responses remain available alongside structured successful responses, and
  `ftp_deploy` still reports bounded samples rather than exhaustive file lists.
- `ftp_upload`, `ftp_deploy` and `ftp_download` now verify every file before
  promoting it. Uploads hash the local source with SHA256, write to an
  unpredictable sibling named `.ftp-mcp-<random>.tmp`, read that temporary back,
  compare byte count and digest, then promote with one rename. On failure the
  server never deletes the final destination to make promotion succeed and never
  falls back to a direct overwrite; it deletes only its own temporary, and a
  cleanup failure adds a bounded warning that a temporary may remain. Downloads
  read a bounded remote SHA256 expectation first, then promote by same-directory
  hard link with `overwrite:false` (the default) or by rename with
  `overwrite:true`. The basename pattern `.ftp-mcp-*.tmp` is reserved and always
  excluded from `ftp_deploy`, even when an explicit `include` matches it. This
  adds network traffic and latency, does not make a multi-file deployment
  atomic, and does not promise universal atomic replacement: FTP and SFTP rename
  behaviour depends on the server and filesystem. SFTP records the temporary's
  server-assigned mode, restricts it to 0600 while writing, and before promotion
  restores the existing destination's permission bits (0777 mask), or that
  recorded creation mode for a new file; a required stat or chmod failure
  prevents promotion. FTP/FTPS has no portable permission-preservation mechanism
  here, so replacing an existing remote file can reset its permissions to the
  server's creation defaults. Locally, `ftp_download` copies an existing
  destination's 0777 bits onto its temporary, but a **new** local file is now
  created with mode 0600 rather than 0.1.0's process-umask default, and
  promotion with the default `overwrite:false` needs hard-link support in the
  destination directory and fails closed without it. See
  [verified transfers](./docs/TRANSFERS.md).
- Deployment selection is now bounded and asynchronous. `maxScanEntries` and
  `maxScanDepth` cap visited entries and directory depth; exceeding either
  refuses the complete selection with `SCAN_LIMIT` (`effects:none`,
  `retryable:false`, `next_action:fix_input`) before any remote connection, for
  dry runs as well as real deploys. See
  [resource limits](./docs/RESOURCE-BOUNDS.md).
- **Deployment selection can now include files it previously skipped.** Only the
  built-in `node_modules`, `.git` and `.ftp-mcp` directory names prune
  traversal. Custom `exclude` patterns and `include` patterns no longer prune
  directories; they keep their existing per-file matching rules. This removes a
  former directory-probe false positive in which, for example,
  `exclude: ["**/__ftp_deploy_probe__"]` also hid `docs/wanted.txt`. Review a
  dry run after upgrading if you rely on exclusion patterns.
- **BREAKING — plain FTP, and FTPS with `insecureTLS: true`, are now refused.**
  0.1.0 had no insecure-transport gate and connected to both without objection.
  0.2.0 raises `TRANSPORT_POLICY` before any network I/O unless the server entry
  sets `allowInsecure: true`, so every 0.1.0 `"protocol": "ftp"` entry — the
  default, namesake protocol of this package — stops connecting until that flag
  is added.
- **BREAKING — SFTP connections without `hostKeySha256` are refused** before
  authentication, with `HOST_KEY_REJECTED`, unless `allowUnknownHostKey: true`
  is explicitly configured. 0.1.0 performed no host-key verification and had no
  such field, so every existing SFTP server entry stops connecting until one of
  the two keys is added.
- **BREAKING — FTP/FTPS connections whose `root` is not `/` are refused**
  unless `allowUnsafeRemoteRoot: true` is explicitly configured;
  `REMOTE_ROOT_REJECTED` is raised before any network I/O. 0.1.0 accepted any
  `root` and its own README recommended exactly this pattern
  (`"root": "/var/www/site"`), so those entries stop connecting until the flag
  is added. The recommended boundary is now a dedicated server-side chrooted
  account with `root: "/"`.
- `ftp_deploy` returns an MCP error when any transfer fails and includes a
  partial-deployment summary, now also as structured `partial` counters. Earlier
  successful transfers are not rolled back.
- `ftp_list` no longer returns every directory entry by default. It returns the
  first 50 entries and pagination metadata; callers can select an offset and a
  page size from 1 through 200.
- Tool results are bounded to 25000 bytes of UTF-8 `JSON.stringify` covering
  both text and structured data after redaction. Oversized results shrink their
  bounded samples and rebuild pagination first, then truncate the largest text
  body with a `… [output truncated]` marker, and fall back to `OUTPUT_LIMIT`
  only when nothing can be shrunk — while preserving the request UUID, effects
  and observed partial counters. This cap sits below `ftp_read`'s unchanged
  `max_bytes` window (default 262144, hard max 1048576): a read that returned
  256 KB of content on 0.1.0 now returns roughly 25 KB, marked as truncated, in
  a successful result.
- Boolean safety flags and SFTP fingerprint formats are validated per server.
- `setup` surfaces active insecure-transport acknowledgments; `doctor` surfaces
  active insecure-transport, unknown-host-key and unsafe-remote-root
  acknowledgments.
- Documentation now distinguishes the working source install from future
  `npx` and MCP registry installation.
- The published package now also ships `docs/`, `evaluations/`, `server.json`,
  `CONTRIBUTING.md`, `CONTRIBUTING.fr.md`, `SECURITY.md`, `SECURITY.fr.md`,
  `CHANGELOG.fr.md` and `LICENSE.fr.md`. The package and `server.json`
  descriptions are now bilingual and describe local confinement and verified
  staging.
- New runtime dependency `zod-to-json-schema`, used to publish the tool input
  and output JSON Schemas.
- The local FTP test server now uses the `@electerm/ftp-srv` development
  dependency.

### Removed

- `assets/banner.svg`, `assets/banner.png`, `assets/demo.svg` and
  `assets/diagram.svg`. The README banners are now `assets/banner-en.png` and
  `assets/banner-fr.png`, with their generation prompts and provenance recorded
  under `assets/provenance/`.
- The `ftp-srv` development dependency, replaced as noted above.

### Fixed

- Interactive manual server entry in `setup` no longer writes the wizard result
  through a missing property.
- Case variants of protocol names can no longer bypass insecure-transport
  checks on setup and diagnostic paths.
- Tool errors retain applicable security warnings, including failures after an
  insecure connection may already have exposed credentials.

### Security

- Insecure transports are refused by default; see the **BREAKING** entry under
  *Changed* for the new `allowInsecure` gate and its upgrade impact. Warnings
  are attached to discovery, diagnostics, successes, and failures involving
  accepted insecure transports.
- SFTP resolves the configured remote root and uses realpath/lstat checks to
  refuse symbolic-link components and resolved paths outside that root. A
  malicious server can still race state between validation and operation. An
  SFTP connection also pins its initial canonical root; a known root change
  returns `TARGET_CHANGED` and refuses to rebase an owned temporary.
- FTP/FTPS no longer describe lexical path normalization as a trustworthy
  anti-symlink jail; server-side account isolation is the real boundary.
- Local sources and download destinations are constrained under `localRoot`.
- Non-interactive setup fails closed: it reports insecure transports but never
  grants an `allowInsecure` exception automatically.
- Error confidentiality is enforced at the result boundary. Error objects,
  causes, stacks, credentials and raw arguments are never serialized; secrets
  are masked in free text; configuration credentials are collected before
  validation, including values from rejected entries and resolved `${ENV:VAR}`
  placeholders, so loader diagnostics use the same mask. Malformed configuration
  JSON yields a generic syntax diagnostic with no parser excerpt, and rejected
  FileZilla blocks are identified by numeric index without echoing untrusted
  names or protocol fields. Remote strings such as `Page:` and `SECURITY
  WARNING` cannot impersonate the trusted notice rendering.
- The committed lockfile resolves the MCP SDK's transitive `hono` dependency to
  the patched 4.13.5.

## [0.1.0] - 2026-07-20

### Added

- Ten MCP tools: `ftp_list_servers`, `ftp_test`, `ftp_list`, `ftp_read`,
  `ftp_upload`, `ftp_deploy`, `ftp_download`, `ftp_mkdir`, `ftp_rename`, and
  `ftp_delete`.
- Multi-server configuration across FTP, FTPS, and SFTP.
- Recursive directory deploy with gitignore-like excludes and dry-run.
- Per-server remote `root` path normalization and `readOnly` mode.
- `${ENV:VAR}` placeholders for configuration secrets.
- FileZilla import, including implicit FTPS sites.
- Setup wizard with MCP client configuration backups.
- Read-only `doctor` diagnostic and source installers.
- English and French documentation.
- End-to-end tests against local FTP and SFTP servers.
