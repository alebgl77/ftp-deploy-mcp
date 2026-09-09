# Local scan and process admission limits

[Français](./RESOURCE-BOUNDS.fr.md)

## Deployment selection

Each configured server owns two optional positive safe integer policies. Tool
arguments cannot override either policy.

| Field | Default | Maximum |
| --- | ---: | ---: |
| `maxScanEntries` | 100000 visited entries | 1000000 |
| `maxScanDepth` | 64 directory levels below the root | 256 |

The root counts as one visited entry at depth zero. Every discovered directory
entry counts once, including directories, excluded files and symbolic links;
descending does not count a directory again. An exact accepted limit succeeds.
The next entry refuses the complete selection with `SCAN_LIMIT`. Directory depth
is inclusive: files inside a directory at the configured depth remain eligible,
but an unpruned child directory is refused before opening it. A pruned subtree
does not require descent or count its undiscovered descendants.

`maxDeployFiles` separately limits selected files during accumulation. Existing
per-file and deployment byte checks remain in force. A selection failure occurs
before any remote connection or mutation, for both dry runs and actual deploys.
`SCAN_LIMIT` returns `effects:none`, `retryable:false` and `next_action:fix_input`.

Selection reads directories sequentially using asynchronous `opendir` with a
32-entry buffer per handle and at most `maxScanDepth + 1` live handles. It checks
cancellation/deadlines around reads and yields to the event loop every 256
discovered entries. All directory closes are awaited, including on failure or
cancellation. A slow filesystem call or close can still exceed the deadline in
wall-clock time; an early timeout response does not mean cleanup has finished.

Only the proven built-in `node_modules`, `.git` and `.ftp-mcp` directory subtree
exclusions prune traversal. Custom exclusion patterns and include patterns never
prune; they retain the existing per-file matching rules. This corrects a former
false-positive sentinel test: `exclude:["**/__ftp_deploy_probe__"]` no longer
hides `docs/wanted.txt`. Some files mistakenly omitted by that behavior can now
appear in the selection. Review a dry run after changing exclusion patterns.

Symbolic links encountered during traversal are skipped. Existing lexical and
canonical `localRoot` checks and source revalidation at upload time remain in
place. They do not eliminate malicious path races by another program running
under the same OS account.

## Tool call admission

One Node isolate admits at most 64 tool calls across all registries sharing the
admission module. There is no additional admission queue or automatic retry.
An unknown tool still produces protocol error `-32602`; invalid arguments still
produce `INVALID_ARGUMENT`. Already-aborted requests start no preparation or
handler. Admission occurs after schema validation and before preparation.

The 65th call returns `CAPACITY_LIMIT`, `effects:none`, `retryable:false` and
`next_action:retry`. Retry explicitly when an active call has actually finished.
Each admitted call retains its slot through preparation, worker execution and
cleanup, including a delayed noncooperative I/O result after cancellation or
timeout. Existing endpoint FIFO locks are unchanged; their waiters also occupy
admission slots. Correlation IDs, including numeric `0`, `""`, numeric `1` and
string `"0"`, retain their transport behavior.

These limits do not coordinate separate processes, isolates or hosts. They do
not bound transport input buffers or parsing of rejected requests. Local scan
limits do not bound the underlying remote `list()` buffer; paginated MCP output
still follows the existing remote listing implementation.
