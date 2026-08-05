# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Insecure transports are now refused by default.** Plain `ftp` and `ftps` with
  `insecureTLS: true` require an explicit per-server `"allowInsecure": true` opt-in;
  without it every connection attempt fails before any network I/O, with a message
  explaining the interception risk and the fix. `rejectUnauthorized: false` is only
  ever applied once that opt-in is present.
- **Very visible warnings on insecure servers**: at startup (stderr), in
  `ftp_list_servers` (⚠ INSECURE flag + status line), in `doctor`, in the FileZilla
  import, and appended to every tool result touching an explicitly-allowed insecure
  server.
- **Setup wizard hardening**: SFTP stays the default protocol; choosing plain FTP now
  shows a warning and requires typing `insecure` to confirm (otherwise it falls back
  to SFTP). Insecure servers found in imported configs are reviewed interactively;
  non-interactive runs never auto-allow them (fail closed).
- Boolean config flags (`readOnly`, `insecureTLS`, `implicitTLS`, `allowInsecure`)
  are now type-checked at load time.
- The `protocol` field is canonicalized to lowercase in `normalizeServer`, so a
  case-variant `"FTP"`/`"FTPS"` in a raw config can no longer slip past the
  insecure-transport gate (or silently downgrade FTPS to plaintext) on the
  `setup`/`doctor` code paths, which do not go through full config validation.
- Tool **error** results on an explicitly-allowed insecure server now carry the
  security warning too (a failed op may still have sent credentials over the
  insecure transport), and `ftp_deploy` dry runs on a blocked insecure server
  announce that the real deploy will be refused.
- `setup` reviews insecure transports on the **merged** effective config (a
  grant taken on the pre-merge input used to be silently discarded when the
  server already existed at the destination), also covers the
  keep-existing-config path, lists servers already carrying
  `"allowInsecure": true`, and marks their successful connection tests with an
  INSECURE tag.

### Fixed

- Interactive manual server entry in `setup` produced a malformed config file
  (the wizard's result was written through a missing `.config` property).

## [0.1.0] - 2026-07-20

### Added

- 10 MCP tools: `ftp_list_servers`, `ftp_test`, `ftp_list`, `ftp_read`, `ftp_upload`,
  `ftp_deploy`, `ftp_download`, `ftp_mkdir`, `ftp_rename`, `ftp_delete`.
- Multi-server configuration across FTP, FTPS, and SFTP.
- `ftp_deploy` recursive directory deploy with gitignore-like excludes at any depth,
  plus `dry_run`.
- Per-server path jail (`root`) confining every remote operation.
- Per-server `readOnly` mode blocking all writes.
- `${ENV:VAR}` placeholders for secrets in the config file.
- FileZilla `sitemanager.xml` import, including implicit FTPS sites.
- One-command `setup` wizard with MCP client auto-configuration and timestamped
  config backups.
- `doctor` read-only diagnostic command.
- `install.cmd` / `install.sh` one-command installers.
- Bilingual documentation (English and French).
- 189-assertion end-to-end smoke test suite against real local FTP and SFTP servers.
