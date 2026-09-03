# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

This source line is not yet published to npm or the MCP registry. Package and
server metadata remain at 0.1.0 until the release checklist is completed.

### Added

- Per-server `localRoot` boundary for `ftp_upload`, `ftp_deploy`, and
  `ftp_download`. The root must be absolute (with `~` expansion supported);
  traversal and local symlink/junction escapes are refused.
- SFTP host-key pinning through `hostKeySha256`, accepting one SHA-256
  fingerprint or a non-empty array for controlled key rotation.
- Explicit `allowUnknownHostKey` override for operators who temporarily accept
  an unverified SFTP server identity.
- Explicit `allowUnsafeRemoteRoot` override for FTP/FTPS operators who accept
  the unresolved symlink risk of a client-side sub-root.
- Dedicated [security model](./docs/SECURITY-MODEL.md) and
  [first-release checklist](./docs/RELEASE.md).
- MCP output schemas and successful structured responses for every tool except
  the intentionally text-only `ftp_read`, plus annotations for all tools.
- A reproducible, external read-only agent evaluation fixture and 10-question
  MCP evaluation set.

### Changed

- SFTP connections without `hostKeySha256` are refused before authentication,
  unless `allowUnknownHostKey: true` is explicitly configured.
- FTP/FTPS connections whose `root` is not `/` are refused unless
  `allowUnsafeRemoteRoot: true` is explicitly configured. The recommended
  boundary is now a dedicated server-side chrooted account with `root: "/"`.
- `ftp_deploy` returns an MCP error when any transfer fails and includes a
  partial-deployment summary. Earlier successful transfers are not rolled back.
- `ftp_list` no longer returns every directory entry by default. It returns the
  first 50 entries and pagination metadata; callers can select an offset and a
  page size from 1 through 200.
- Existing text responses remain available alongside structured successful
  responses. Tool errors remain text-only `isError` results, and `ftp_deploy`
  reports bounded samples rather than exhaustive file lists.
- Boolean safety flags and SFTP fingerprint formats are validated per server.
- Setup and diagnostics surface active insecure-transport, unknown-host-key,
  and unsafe-remote-root acknowledgments.
- Documentation now distinguishes the working source install from future
  `npx` and MCP registry installation.

### Security

- Plain FTP and FTPS with `insecureTLS: true` remain refused unless the server
  explicitly sets `allowInsecure: true`. Warnings are attached to discovery,
  diagnostics, successes, and failures involving accepted insecure transports.
- SFTP resolves the configured remote root and uses realpath/lstat checks to
  refuse symbolic-link components and resolved paths outside that root. A
  malicious server can still race state between validation and operation.
- FTP/FTPS no longer describe lexical path normalization as a trustworthy
  anti-symlink jail; server-side account isolation is the real boundary.
- Local sources and download destinations are constrained under `localRoot`.
- Non-interactive setup continues to fail closed rather than granting insecure
  transport exceptions automatically.

### Fixed

- Interactive manual server entry in `setup` no longer writes the wizard result
  through a missing property.
- Case variants of protocol names can no longer bypass insecure-transport
  checks on setup and diagnostic paths.
- Tool errors retain applicable security warnings, including failures after an
  insecure connection may already have exposed credentials.

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
