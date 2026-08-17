# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using GitHub Security Advisories: go to the
[repository's Security tab](https://github.com/alebgl77/ftp-deploy-mcp/security)
and click **"Report a vulnerability"**.

### In scope

- **Path-jail bypass** — any way to read, write, or delete outside a server's
  configured `root`.
- **Insecure-transport opt-in bypass** — any way to open a plain-FTP or
  unverified-TLS connection without the explicit per-server
  `"allowInsecure": true` acknowledgment.
- **Credential leakage into tool output** — passwords, passphrases, or private
  keys appearing in a tool's response, logs, or error messages.
- **Config-file corruption** — `setup` or any other command corrupting or
  silently overwriting an existing MCP client config or `ftp-servers.json`
  without a backup.

### Response target

You will receive an acknowledgment within **72 hours** of your report.
