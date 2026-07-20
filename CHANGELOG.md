# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
