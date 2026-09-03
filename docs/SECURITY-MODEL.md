# Security Model

This document describes what ftp-deploy-mcp protects, what it assumes, and
where operators must provide stronger controls. It applies to the unreleased
v0.2 source line; verify the release notes for the exact artifact you run.

## Assets and trust boundaries

The project handles four sensitive areas:

1. local credentials and SSH private-key paths;
2. local files reachable by upload, deploy, and download;
3. remote files reachable through a configured account;
4. MCP client and server configuration written by setup.

The MCP client and the model can request any exposed tool operation. Treat them
as an operator with the permissions of the configured accounts, subject to
`localRoot`, remote-path checks, `readOnly`, and explicit destructive
parameters. A compromised local user account, modified dependency, malicious
MCP client, or credential with broader server permissions is outside the
boundary these application checks can reliably contain.

The remote service is trusted to implement its protocol honestly. SFTP adds
identity and filesystem checks, but a hostile authenticated server can still
race filesystem state. FTP and FTPS do not expose portable primitives needed
to prove a client-side sub-root is free of symlink escapes.

## Control map

| Control | Protects against | Does not protect against |
|---|---|---|
| `localRoot` | Local traversal and local symlink/junction escape for upload, deploy, and download. | A compromised local account or files legitimately inside the root. |
| SFTP `hostKeySha256` | Connecting to an SFTP endpoint presenting an unexpected host key. | A compromised server holding the expected key, or a pin obtained through the attacked channel. |
| SFTP realpath/lstat checks | Known remote symlink components and resolved paths outside `root`. | All time-of-check/time-of-use races on a malicious or concurrently changing server. |
| FTP/FTPS `root: "/"` policy | Avoids presenting a client-side subdirectory as a proven security jail. | Escape from an account that the FTP server itself has not isolated. |
| `readOnly` | Writes requested through this MCP server. | Other clients using the same credentials, or server credentials that remain writable. |
| `allowInsecure` gate | Accidental use of plaintext FTP or FTPS without certificate verification. | Interception after the operator accepts the risk. |
| `dry_run` | Previewing deploy selection without transferring files. | Changes made by another process after the preview. |
| Credential redaction | Intentional return of configured passwords, passphrases, or private keys in tool output. | Secrets stored inside a remotely read file, dependency compromise, memory inspection, or unsafe operator logs. |

## Local filesystem boundary

Every server used with `ftp_upload`, `ftp_deploy`, or `ftp_download` must define
`localRoot`. It must resolve to an existing absolute directory; `~` is expanded
before the absolute-path check.

Relative tool paths are resolved under that directory. Absolute tool paths are
accepted only if they remain inside it. Existing upload/deploy sources are
resolved to their real paths and refused if a symlink or junction exits the
root. Download destinations are checked component by component so an existing
symlink or junction cannot redirect the write.

This is least-privilege path scoping, not an operating-system sandbox. Use a
dedicated OS account or container when the MCP client itself is not trusted.

## SFTP server identity and remote paths

SFTP connections require `hostKeySha256` as a single fingerprint or non-empty
array. A pin is `SHA256:` plus the 43-character unpadded base64 encoding of the
32-byte SHA-256 host-key digest. User authentication keys and host keys solve
different problems: a private key authenticates the client to the server; the
host-key pin authenticates the server to the client.

Obtain the fingerprint from an authenticated hosting panel, a trusted server
console, or an administrator over a separately authenticated channel. A value
seen only through `ssh-keyscan` on the same network is a candidate, not an
out-of-band verification.

For a planned rotation:

1. verify the new key fingerprint out of band;
2. add it alongside the old fingerprint in the pin array;
3. rotate the server key and test the connection;
4. remove the old fingerprint after the rollout is complete.

`allowUnknownHostKey: true` disables server identity verification and must not
be combined with `hostKeySha256`. It is a visible, explicit acceptance of
impersonation risk, not a trust-on-first-use store.

For remote paths, SFTP resolves the configured root and checks path components
with realpath/lstat, refusing symbolic links. These checks substantially improve
the boundary over FTP, but cannot make multiple network round trips atomic. A
malicious or concurrently changing server may alter an object between a check
and the following operation.

## FTP and FTPS remote roots

FTP has no portable equivalent of the SFTP realpath/lstat checks. Normalizing
`..` and joining paths below a configured subdirectory catches lexical
traversal, but it cannot determine whether a server-side path component is a
symlink to somewhere else.

Therefore:

- the reliable boundary is a dedicated account isolated or chrooted by the FTP
  server;
- that account's visible root should be the intended deployment root;
- configure the MCP `root` as `/`;
- a non-`/` FTP/FTPS root is refused unless
  `allowUnsafeRemoteRoot: true` explicitly accepts the unresolved risk.

FTPS protects transport confidentiality only when certificate verification
succeeds. `insecureTLS: true` requires `allowInsecure: true` and is vulnerable
to impersonation. Plain FTP always requires `allowInsecure: true` and exposes
credentials and content to the network.

## Writes, deletion, and partial deployment

`readOnly: true` blocks upload, deploy, mkdir, rename, and delete through the
MCP server. Prefer credentials that are also read-only at the remote service.
Recursive deletion requires an explicit argument, and deletion of the
configured root is refused.

A deploy is not a transaction. If any transfer fails, `ftp_deploy` returns an
MCP error and a partial-deployment summary. Transfers completed earlier in the
same call remain on the server. Operators should inspect and reconcile remote
state before retrying.

Setup keeps timestamped backups when changing existing MCP client
configuration. Atomic replacement of newly written sensitive configuration is
a release gate for v0.2; do not infer that every historical or unpublished
write path is atomic. Keep independent backups and validate the packaged
artifact before release.

## Secrets and operational guidance

- Keep `ftp-servers.json` out of version control and restrict its permissions.
- Prefer `${ENV:NAME}` placeholders or a protected SSH private key to plaintext
  secrets in JSON.
- Give each environment a separate, least-privilege server account.
- Use `readOnly` plus server-side read-only permissions for audit-only targets.
- Review `ftp_list_servers` and `doctor` warnings before the first real deploy.
- Start with `dry_run`, then deploy a non-production target when possible.
- Rotate any credential that appears in a tool response or shared log.

No telemetry is sent by the project. Network connections are made to configured
servers, while package installation may independently contact npm according to
npm's normal behavior.

## Vulnerability disclosure

Potential bypasses of these controls should be reported privately. Follow
[SECURITY.md](../SECURITY.md), use disposable credentials, and avoid including
live secrets in the report.
