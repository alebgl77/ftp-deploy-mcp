# Security Policy

**English** | [Français](./SECURITY.fr.md)

## Supported versions

The project has not yet completed its first npm or MCP registry publication.
Security fixes target the current source branch and the latest tagged 0.x
release. Older 0.x tags may be asked to upgrade rather than receive a backport.

| Version | Support |
|---|---|
| Current source / latest 0.x tag | Supported |
| Older 0.x tags | Best effort |

## Report a vulnerability privately

**Do not open a public GitHub issue, discussion, or pull request for a suspected
vulnerability.**

Use GitHub's private vulnerability reporting: open the
[repository Security page](https://github.com/alebgl77/ftp-deploy-mcp/security),
choose **Report a vulnerability**, and include:

- affected commit or version and protocol;
- minimal reproduction steps and required server configuration;
- expected versus observed access or disclosure;
- impact, including which local or remote files/credentials are exposed;
- any suggested remediation or disclosure deadline.

Avoid including live credentials or private keys. Use disposable test accounts
and redact logs. If private reporting is unavailable, open a public issue that
contains no vulnerability details and asks the maintainer to establish a
private channel.

The target is to acknowledge a complete report within 72 hours, then confirm
scope, coordinate a fix and tests, and agree on a disclosure date. This is a
response target, not a bug-bounty or resolution-time promise.

## In scope

- Access outside `localRoot` through traversal, symlink, junction, or download
  destination handling.
- SFTP access outside `root`, host-key verification bypass, or unsafe handling
  of a verified host-key rotation.
- FTP/FTPS connection to a non-root client jail without the explicit
  `allowUnsafeRemoteRoot` acknowledgment.
- Plain FTP or unverified FTPS without the explicit `allowInsecure`
  acknowledgment.
- Credential or key material exposed in tool results, diagnostics, logs, or
  errors.
- `readOnly` bypass, destructive-operation guard bypass, or incorrect success
  reporting after a partial deployment.
- Corruption or unsafe replacement of server or MCP client configuration.
- A release archive accepted with changed shipped source, a changed dependency
  manifest or source lockfile, or an unapproved dependency modifier or install hook.

Issues that depend on a malicious FTP server using symlinks outside a
client-configured sub-root are important but are **not claimed to be prevented**:
FTP/FTPS require a server-side account/chroot boundary. Likewise, SFTP
realpath/lstat checks reduce symlink escapes but cannot remove every race on a
malicious server. These limits are documented in the
[security model](./docs/SECURITY-MODEL.md).

## Dependency and release integrity

The six direct production dependencies use exact versions.
`package-lock.json` is the sole source graph authority, shipped in the 82-file
source installation archive. Use `npm ci --omit=dev --ignore-scripts` after
extraction and retain this file. Changes require review of the complete graph,
its URLs and integrity values, then the checks in the
[release guide](./docs/RELEASE.md).

The 81-file npm package contains no lockfile and remains unqualified. A real
installation changed ten production dependencies. Workflows reject installed
graph drift before npm or MCP publication; a source proof cannot authorize npm.
A future matching npm graph is evidence only for the tested environment and date,
with no guarantee about future installations.

A passing dependency audit is evidence for that graph on that date, not a
guarantee against future advisories or a certification of production use.
Report archive-validation bypasses privately using the same process above.
GitHub releases do not establish npm or Official MCP Registry availability.

## Research guidelines

- Test only systems and accounts you own or are authorized to assess.
- Do not access other users' data, degrade service, persist access, or use
  social engineering.
- Stop once the issue is demonstrated and share details privately.
- Give the project a reasonable opportunity to remediate before disclosure.

Good-faith research following these guidelines is welcome, but this document
does not grant authorization against third-party FTP/SFTP services.
