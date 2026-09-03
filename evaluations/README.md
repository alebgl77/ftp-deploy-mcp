# Read-only agent evaluation

This directory contains a reproducible 10-question MCP evaluation for the four
read-only tools: `ftp_list_servers`, `ftp_test`, `ftp_list`, and `ftp_read`.
It does not include a runner, install dependencies, or perform any setup by
itself.

## Prepare disposable servers

1. Create an empty, disposable FTP account and an empty, disposable SFTP
   account. Each account must expose its configured root as `/`.
2. Manually copy the contents of [`fixture/`](./fixture/) into the empty visible
   root of each account. Copy the contents, not the `fixture` directory itself,
   so both roots contain `README.txt`, `catalog/`, and `reports/` directly.
3. Keep both copies unchanged while running the evaluation. The questions do
   not depend on directory order; listing assertions use entry sets, counts, or
   pagination metadata.

Use FTP only for a loopback-only, disposable test service with a dedicated
server-side chroot. Its visible root and configured `root` must both be `/`.
`allowInsecure: true` is acceptable here only because the service is disposable
and restricted to loopback; do not reuse that exception for a remote host.

For SFTP, obtain the host-key SHA-256 fingerprint from the disposable server's
trusted console or another authenticated channel. Verify it out of band, then
provide it through `EVAL_SFTP_HOST_KEY_SHA256`. Do not invent a fingerprint or
learn it only from the connection being evaluated.

## Configure the MCP server

Create a strict JSON configuration outside this fixture and point
`FTP_MCP_CONFIG` to it. Supply connection values through environment variables;
do not put real credentials in this repository. Replace the example
`localRoot` with an existing absolute directory on the machine running the MCP
server. The evaluation is read-only, but an absolute `localRoot` keeps the
configuration aligned with the normal safety model.

```json
{
  "servers": {
    "eval-ftp": {
      "protocol": "ftp",
      "host": "${ENV:EVAL_FTP_HOST}",
      "user": "${ENV:EVAL_FTP_USER}",
      "password": "${ENV:EVAL_FTP_PASSWORD}",
      "localRoot": "/absolute/path/to/empty-eval-local-root",
      "root": "/",
      "allowInsecure": true,
      "readOnly": true
    },
    "eval-sftp": {
      "protocol": "sftp",
      "host": "${ENV:EVAL_SFTP_HOST}",
      "user": "${ENV:EVAL_SFTP_USER}",
      "password": "${ENV:EVAL_SFTP_PASSWORD}",
      "localRoot": "/absolute/path/to/empty-eval-local-root",
      "root": "/",
      "hostKeySha256": "${ENV:EVAL_SFTP_HOST_KEY_SHA256}",
      "readOnly": true
    }
  }
}
```

Set `EVAL_FTP_HOST` to the loopback address of the disposable FTP service. The
snippet uses the default FTP and SFTP ports; add numeric `port` values if the
disposable services use different ports. The two server names must remain
exactly `eval-ftp` and `eval-sftp`, and both servers must contain identical
fixture bytes.

## Run

Start an MCP client or evaluation harness over stdio with `node src/index.js`,
the external configuration selected by `FTP_MCP_CONFIG`, and
[`read-only.xml`](./read-only.xml) as the evaluation input. The harness must
allow only the four tools named above. Compare its final answers with each
`answer` element; do not compare server listing order, connection latency, or
timestamps.

These LLM evaluations are not executed in CI. They require externally managed
FTP and SFTP services plus a model-capable MCP client or harness. No score is
claimed in this repository.
