# MCP error contract

[Français](./ERROR-CONTRACT.fr.md)

The ten tool names and success field shapes remain stable. Nine tools publish
a JSON Schema draft-07 `oneOf` with two strict alternatives: the existing
success object and `{error}`. `ftp_read` retains text-only success and no
output schema; its errors still use the internally validated envelope.
Clients should use `isError` and the stable fields below, rather than parse
the localized human text.

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Error: READ_ONLY: …" }],
  "structuredContent": {
    "error": {
      "schema_version": 1,
      "code": "READ_ONLY",
      "message": "…",
      "retryable": false,
      "request_id": "46d0223a-de77-4f28-bf77-f8b9706a4ecb",
      "next_action": "fix_config",
      "effects": "none"
    }
  }
}
```

`request_id` is a fresh server-generated UUID for one call. It is unrelated to
the JSON-RPC correlation ID and is not a durable operation identifier. No
`operation_id`, journal, recovery command or rollback is provided.

## Stable decisions and effect observations

The accepted `code` values are:

`CONFIG_REQUIRED`, `CONFIG_INVALID`, `SERVER_REQUIRED`, `SERVER_UNKNOWN`,
`INVALID_ARGUMENT`, `READ_ONLY`, `TRANSPORT_POLICY`, `HOST_KEY_REJECTED`,
`REMOTE_ROOT_REJECTED`, `PATH_REJECTED`, `NOT_FOUND`, `ALREADY_EXISTS`,
`TRANSFER_LIMIT`, `TRANSFER_VERIFY`, `TARGET_CHANGED`, `CANCELLED`, `TIMEOUT`,
`DEPLOY_PARTIAL`, `TRANSPORT_ERROR`, `OUTPUT_LIMIT`, `INTERNAL_ERROR`,
`SCAN_LIMIT`, `CAPACITY_LIMIT`.

`SCAN_LIMIT` refuses the complete local selection before connecting, with
`effects:none` and `next_action:fix_input`. `CAPACITY_LIMIT` refuses admission
before preparation, with `effects:none` and `next_action:retry`. Both keep
`retryable:false`; see [resource limits](./RESOURCE-BOUNDS.md).

The accepted `next_action` values are `fix_input`, `fix_config`,
`select_server`, `inspect_target`, `retry`, `contact_operator`, and `none`.
This release conservatively returns `retryable: false` for every error.
It never retries an uncertain mutation automatically.

| `effects` | Meaning |
| --- | --- |
| `none` | No mutating operation was dispatched by this call. |
| `possible` | Mutation was dispatched, without a confirmed effect yet. |
| `confirmed` | At least one effect was acknowledged; further uncertain effects may exist. |

Effects include temporary files, cleanup and local download writes. A remote
read-only policy does not prohibit local download writes. `confirmed` does
not mean that the entire operation succeeded, and zero completed files does
not prove that nothing changed. A transport close failure after promotion
retains confirmed effects.

Upload, download and deployment errors can include strict `partial` fields:
`completed_files`, `completed_bytes`, `failed_files`, optional `total_files`,
and `final`. Counts are safe nonnegative integers from observed promotions
and failed file attempts, not text parsing. Bytes count completed files;
they do not represent all network traffic or partially written temporaries.
`final: false` marks an early snapshot while the underlying worker still
settles. An early snapshot is not later revised on the wire.

## Protocol, cancellation and output boundaries

Arguments rejected by a known tool's declared input schema produce
`INVALID_ARGUMENT` before its handler, connection or filesystem write. Later
business-policy refusals can occur after connection. An unknown tool returns a
bounded JSON-RPC `-32602` protocol error without echoing its name. Malformed
protocol frames retain the SDK's protocol-error handling.

MCP peer cancellation aborts the operation, and the SDK suppresses its result;
clients must not expect a delivered `CANCELLED` envelope. Internal deadlines
are distinct and may return `TIMEOUT`. The public transport decorator corrects
the installed SDK's cancellation gap for numeric `0` and the empty string
`""` using two independent slots. Other IDs, including the string `"0"`, keep
native SDK behavior. A duplicate active correlation ID in either corrected
slot closes the connection. Slots and mutation locks remain owned until the
actual worker settles, even after an early response. A response whose send
already started cannot be recalled. Cancellation does not undo effects.

Known tool results are redacted, bounded and validated once at the boundary.
The 25,000-byte limit covers UTF-8 `JSON.stringify` of the complete result,
including both text and structured data, after redaction expansion. Required
security notices have a separate trusted rendering role. Remote strings such
as `Page:` and `SECURITY WARNING` cannot acquire that role. Pagination is
rebuilt after sample shrinking. An `OUTPUT_LIMIT` fallback preserves request
UUID, effects and observed partial counters.

Typed decisions precede translation. Native diagnostic details remain source
data under a localized wrapper; ambiguous FTP responses, including code 550,
do not become `NOT_FOUND` based on prose. Secrets are masked in free text.
Only schema-specific public constants and the UUID minted for this result
are preserved at their exact structured paths. Error objects, causes, stacks,
credentials and raw arguments are not serialized. Configuration credentials
are collected privately before validation, including values from rejected
entries and resolved environment placeholders. Public loader diagnostics use
the same mask. Malformed JSON receives a generic syntax diagnostic with no
parser excerpt; no reliable secret extraction from malformed input is claimed.
Rejected FileZilla blocks are identified by their numeric block index without
echoing untrusted names or protocol fields.

See [languages](./LANGUAGES.md), the [security model](./SECURITY-MODEL.md)
and [verified transfers](./TRANSFERS.md) for the remaining operational limits.
