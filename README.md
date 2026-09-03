<div align="center">

<img src="assets/logo.svg" width="96" alt="ftp-deploy-mcp logo">

# ftp-deploy-mcp

**The deploy button for AI coding agents.**

Give Claude Code, Claude Desktop, Cursor, Windsurf, Trae, Antigravity, or any
MCP client a focused way to list, read, upload, download, and deploy files on
your own FTP, FTPS, and SFTP servers.

*Version française → [README.fr.md](./README.fr.md)*

[![CI](https://github.com/alebgl77/ftp-deploy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alebgl77/ftp-deploy-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

<img src="assets/banner.svg" width="100%" alt="ftp-deploy-mcp banner">

</div>

Purpose-built deployment controls keep credentials out of tool responses,
support read-only servers and dry runs, and limit local file access with
`localRoot`. The repository is covered by an extensive end-to-end suite that
runs against local FTP and SFTP servers. There is no telemetry.

> **Availability:** install from source today. The npm package and MCP registry
> entry have **not been published yet**, so `npx -y ftp-deploy-mcp` and
> registry-based installation will not work until the first release is
> announced. Existing Glama and MCP Index pages are discovery listings, not
> proof that an installable package is available. Package and server metadata
> remain at 0.1.0 until the release process is completed.

## First source install

1. Install Node.js 18 or newer.
2. Run `git clone https://github.com/alebgl77/ftp-deploy-mcp.git`, then
   `cd ftp-deploy-mcp`.
3. Run `npm install`.
4. Run `npm run setup`, then edit the generated server config: set an absolute
   `localRoot`, replace credentials, and configure the SFTP host-key pin or the
   FTP/FTPS safety acknowledgments described below.
5. Restart the MCP client and try a dry run:

```text
Call ftp_deploy with:
{"server":"prod","local_dir":"dist","remote_dir":"/","dry_run":true}
```

Windows users can run `install.cmd` and macOS/Linux users can run
`./install.sh` instead of steps 3–4. Review every generated server entry before
the first connection.

## Protocol and security matrix

| Protocol | Transport identity | Remote-root behavior | Recommended use |
|---|---|---|---|
| **SFTP** | Encrypted. `hostKeySha256` is required unless `allowUnknownHostKey: true` explicitly accepts impersonation risk. | `realpath`/`lstat` checks refuse symlink components and keep operations below `root`. A malicious or changing server can still create a race between validation and use. | Preferred. Pin a fingerprint verified out of band. |
| **FTPS** | Encrypted when certificate verification succeeds. `insecureTLS: true` also requires `allowInsecure: true` and disables MITM protection. | A client-side sub-root cannot be a reliable anti-symlink jail. `root` other than `/` is refused unless `allowUnsafeRemoteRoot: true`. | Use a dedicated, server-side chrooted account whose visible root is `/`. |
| **FTP** | Plaintext. Refused unless `allowInsecure: true` accepts interception and credential exposure. | Same limitation as FTPS: the real boundary is the server account/chroot, not lexical client path checks. | Legacy-only, on a trusted network, with a dedicated chrooted account. |

All three protocols also enforce `localRoot` for `ftp_upload`, `ftp_deploy`,
and `ftp_download`. This limits which local files the MCP server can access.

## What you get

- Ten focused MCP tools for server discovery, testing, listing, reading,
  uploading, recursive deploys, downloading, creating directories, renaming,
  and deleting.
- Multiple named servers in one local configuration.
- Gitignore-like deploy exclusions, dry-run, and per-server `readOnly` mode.
- FileZilla import, an interactive setup wizard, and a read-only `doctor`
  command.
- Credentials loaded locally from the config, environment variables, or SSH
  keys and never intentionally returned to the model.

## Server configuration

The first configuration found wins:

1. `--config <path>`
2. `FTP_MCP_CONFIG`
3. `./ftp-servers.json`
4. `~/.ftp-mcp/servers.json`

The teaching example below is JSON with comments. Real configuration files
must be strict JSON; start from
[ftp-servers.example.json](./ftp-servers.example.json).

```jsonc
{
  "defaultServer": "prod",
  "servers": {
    "prod": {
      "protocol": "sftp",
      "host": "ssh.example.com",
      "port": 22,
      "user": "deploy",
      "password": "${ENV:PROD_PASSWORD}",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "passphrase": "${ENV:PROD_KEY_PASSPHRASE}",
      "localRoot": "/home/alice/projects/site",
      "root": "/var/www/site",
      "hostKeySha256": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "readOnly": false
    }
  }
}
```

Replace the all-`A` fingerprint; it is deliberately non-functional for a real
host. Use `hostKeySha256` as an array during a controlled key rotation:

```json
"hostKeySha256": [
  "SHA256:old_verified_43_character_base64_value_here",
  "SHA256:new_verified_43_character_base64_value_here"
]
```

The illustrative labels above show the shape but are not valid pins. Each real
entry is exactly `SHA256:` plus 43 characters of unpadded base64.

### Field reference

| Field | Applies to | Meaning |
|---|---|---|
| `protocol` | all | Required: `ftp`, `ftps`, or `sftp`. |
| `host` / `port` / `user` | all | Connection endpoint and account. Default ports are 21, 990 for implicit FTPS, and 22 for SFTP. |
| `password` | all | Password or `${ENV:NAME}` placeholder. |
| `privateKeyPath` / `passphrase` | SFTP | SSH private key path and optional passphrase. A leading `~` is expanded. These authenticate the user; they do not verify the server. |
| `localRoot` | all | Required for upload, deploy, and download. Must resolve to an existing absolute local directory; a leading `~` is supported. Relative and symlink/junction escapes are refused. Relative tool paths resolve inside it, and absolute tool paths must still remain inside it. |
| `root` | all | Remote root, default `/`. Tool paths are resolved below it. SFTP performs server-side realpath/lstat checks. FTP/FTPS need a server-side chroot for a trustworthy boundary. |
| `hostKeySha256` | SFTP | Required fingerprint string or non-empty array of pins. Format: `SHA256:<43-character unpadded base64>`. Cannot be combined with `allowUnknownHostKey`. |
| `allowUnknownHostKey` | SFTP | Emergency compatibility override. `true` accepts an unverified server identity and visibly warns on results. |
| `readOnly` | all | Blocks upload, deploy, mkdir, rename, and delete. A deploy dry run remains available. |
| `implicitTLS` | FTPS | Uses implicit TLS, normally on port 990. |
| `insecureTLS` | FTPS | Disables certificate verification. Requires `allowInsecure: true`. |
| `allowInsecure` | FTP/FTPS | Explicitly accepts plaintext FTP or unverified FTPS. It does not make the connection secure. |
| `allowUnsafeRemoteRoot` | FTP/FTPS | Allows a `root` other than `/` despite the unresolved symlink-escape risk. Use only when the server-side account boundary is understood. |

Any string can contain `${ENV:VARIABLE_NAME}`. Missing variables produce a
named configuration error.

### Verify an SFTP fingerprint out of band

Do not trust a fingerprint obtained only through the connection you are about
to verify.

1. Obtain the SHA-256 host-key fingerprint from the hosting provider's
   authenticated control panel or support channel, or from an administrator
   through a separately authenticated channel.
2. If you administer the host, use its trusted console to run a command such as
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`.
3. Compare the complete `SHA256:...` value before putting it in
   `hostKeySha256`. `ssh-keyscan` may collect a candidate key, but by itself it
   does not authenticate that key.

For rotation, verify the new fingerprint out of band, temporarily configure
both old and new pins, rotate the server key, confirm connections use the
expected key, then remove the old pin. Do not use `allowUnknownHostKey` as a
rotation shortcut.

## Tool reference

All remote path arguments are relative to the configured remote `root`. The
`server` parameter is optional when `defaultServer` is set or only one server
exists.

| Tool | Main parameters | Purpose |
|---|---|---|
| `ftp_list_servers` | none | Show server metadata and active safety warnings, never passwords. |
| `ftp_test` | `server?` | Connect and list the visible root. |
| `ftp_list` | `server?`, `path?`, `limit?`, `offset?` | List a remote directory. `limit` defaults to 50 (1–200); `offset` defaults to 0. |
| `ftp_read` | `server?`, `path`, `max_bytes?` | Read a bounded text file; binary data is refused. |
| `ftp_upload` | `server?`, `local_path`, `remote_path?` | Upload one file from `localRoot`. |
| `ftp_deploy` | `server?`, `local_dir`, `remote_dir?`, `include?`, `exclude?`, `dry_run?` | Recursively deploy a directory from `localRoot`. |
| `ftp_download` | `server?`, `remote_path`, `local_path`, `overwrite?` | Download into `localRoot`. |
| `ftp_mkdir` | `server?`, `path` | Create a remote directory recursively. |
| `ftp_rename` | `server?`, `from_path`, `to_path` | Rename or move. |
| `ftp_delete` | `server?`, `path`, `recursive?` | Delete a file or, with explicit recursion, a directory. |

### Response compatibility, pagination, and annotations

`ftp_list` returns one page instead of an unbounded directory listing. Its
successful response includes `total`, `count`, `offset`, `limit`, `has_more`,
and `next_offset` pagination fields. For example, a request with
`{"server":"prod","path":"/assets","limit":2,"offset":2}` may include the
following intentionally non-exhaustive excerpt. It omits the required
top-level `server`, `path`, and `security_warning` fields and the required
per-entry `size_bytes` and `modified_at` fields:

```json
{
  "structuredContent": {
    "entries": [
      { "name": "app.css", "type": "file" },
      { "name": "app.js", "type": "file" }
    ],
    "total": 6,
    "count": 2,
    "offset": 2,
    "limit": 2,
    "has_more": true,
    "next_offset": 4
  }
}
```

The existing human-readable `content` text is retained for compatibility.
On success, every tool except `ftp_read` also advertises an MCP
`outputSchema` and returns matching `structuredContent`; `ftp_read` remains a
bounded text-only tool. Tool errors remain `isError` responses with text
content and no `structuredContent`.

All tools publish MCP annotations describing read-only, destructive,
idempotent, and open-world behavior. These annotations are client hints, not a
security boundary; enforce access with server credentials, `readOnly`,
`localRoot`, and the protocol controls described above. `ftp_deploy` structured
results contain a summary and bounded samples, not exhaustive file lists.

`ftp_deploy` is not a transaction. If one or more transfers fail, the tool
returns an MCP error with a partial-deployment summary; files transferred
before the failure are not rolled back.

Default deploy exclusions include `node_modules`, `.git`, environment files,
logs, OS metadata, `ftp-servers.json`, and `.ftp-mcp` content at any depth.

## Client setup

`npm run setup` detects supported clients, creates timestamped backups before
changing existing client configuration, and prints a block for UI-only clients.
To wire a client manually, replace the path below with the absolute path to
this checkout:

```json
{
  "mcpServers": {
    "ftp": {
      "command": "node",
      "args": ["/absolute/path/to/ftp-deploy-mcp/src/index.js"]
    }
  }
}
```

Common locations include `.mcp.json` for Claude Code,
`~/.cursor/mcp.json` for Cursor, and
`~/.codeium/windsurf/mcp_config.json` for Windsurf. Claude Desktop and other
clients accept the same command/arguments structure through their MCP settings.

After the first npm release is verified, this source command can be replaced
with `npx -y ftp-deploy-mcp`. It is intentionally not presented as a working
installation method today.

## FileZilla import and diagnostics

```bash
node src/index.js import-filezilla --file /path/sitemanager.xml --out ./ftp-servers.json
npm run doctor
```

Imported passwords may be decoded into plaintext. Keep the output outside
version control, restrict its permissions, add `localRoot`, and review every
insecure-transport or FTP/FTPS remote-root warning before connecting.
`doctor` is read-only and reports configuration and client wiring without
printing passwords.

## Migrating from v0.1 to the unreleased v0.2

The source checkout contains v0.2 work, but no v0.2 package or registry release
exists yet.

1. Add an absolute `localRoot` to every server used by upload, deploy, or
   download.
2. For every SFTP server, add an out-of-band-verified `hostKeySha256`. Use
   `allowUnknownHostKey: true` only as a temporary, explicit risk acceptance;
   do not configure both fields.
3. For FTP/FTPS, prefer a dedicated server-side chroot whose visible root is
   `/` and set `root` to `/`. A non-root client path now requires
   `allowUnsafeRemoteRoot: true` and remains unsafe against server-side
   symlinks.
4. Treat a failed `ftp_deploy` as a partial deployment: inspect its summary and
   reconcile the remote tree before retrying.
5. Re-run `npm run setup` or update the MCP client command to this checkout,
   then run `npm run doctor` and a dry run.

Atomic replacement for newly written sensitive configuration is a v0.2 release
gate, not a guarantee of the current 0.1 metadata in this checkout. See
[docs/RELEASE.md](./docs/RELEASE.md) before cutting a release.

## Security and limitations

- The strongest FTP/FTPS boundary is the server's own account isolation or
  chroot. Client-side normalization rejects obvious traversal, but FTP lacks
  portable `REALPATH`/`LSTAT` primitives and cannot prove that a server-side
  symlink stays inside a configured sub-root.
- SFTP verifies the host pin and rejects symlink components using
  `realpath`/`lstat`. A server controlled by an attacker can still change
  filesystem state between checks and operations.
- `readOnly` reduces accidental writes through this MCP server; it is not a
  substitute for read-only credentials enforced by the remote server.
- FTP, `insecureTLS`, `allowUnknownHostKey`, and
  `allowUnsafeRemoteRoot` are explicit risk acceptances, not security features.

Read the full [security model](./docs/SECURITY-MODEL.md) and
[private disclosure policy](./SECURITY.md).

## Development

```bash
npm test
node src/index.js --version
node src/index.js --help
```

The test suite uses local FTP and SFTP servers and does not require an external
network. Contributions are welcome; see
[CONTRIBUTING.md](./CONTRIBUTING.md). Maintainers should use the
[release guide](./docs/RELEASE.md). A reproducible, externally hosted read-only
agent evaluation is documented in [evaluations/README.md](./evaluations/README.md).

## License

MIT — see [LICENSE](./LICENSE).
