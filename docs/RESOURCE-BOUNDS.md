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

## Internal prepared-tool lifecycle

The registry has an internal integration seam; existing tools still use their
ordinary `timeoutFor` resolver. No recovery tool, persistent request ID or new
configuration field is activated by this seam, and public descriptors/results
are unchanged.

A registration can supply the paired private callbacks `prepare(args,
operation)` and `disposePrepared(prepared, operation)`. Both must be functions.
The handler receives the prepared value as its third argument. Successful
preparation transfers ownership even when the value is `undefined`; the registry
awaits disposal exactly once after the handler or any later failure. A rejecting
preparation must close every resource it acquired before rejecting: the registry
cannot dispose a context that was never returned. The first failure survives a
failing disposer; disposal failure after successful handling becomes an ordinary
bounded tool error.

Preparation, handling and disposal run inside the admitted worker observed by
the transport. Cancellation or timeout can produce an early outward response,
but the admission slot and affected falsy correlation ID remain occupied until
actual settlement, including late preparation and disposal. Disposal runs even
after abort and must not be wrapped in `operation.step`, whose cancelled check
would prevent cleanup. Noncooperative work can therefore retain capacity
indefinitely; the deadline does not terminate arbitrary JavaScript or I/O.

The registry's private `preparedTimeoutMs` defaults to 120000 and accepts a
positive safe integer up to 3600000. Prepared tools bypass `timeoutFor` entirely.
Future assembly supplies the largest validated server timeout. After selecting
a server, preparation calls `operation.shortenTimeout(server.operationTimeoutMs)`
and `operation.check()` before effects. Shortening is measured from the original
operation start, never extends the current deadline, and immediately aborts an
already elapsed deadline. A finished operation cannot acquire another timer.

`operation.runPreparation(run)` is single-use and cannot nest. Its fixed 10000 ms
cap starts before callback invocation and is bounded by the main deadline.
Checks before and after the callback also enforce the cap when the event loop
has not delivered its timer. Expiry irreversibly aborts the whole operation with
`TIMEOUT`. Successful preparation removes only the stage cap, preserving the
main deadline. The actual callback remains awaited after an outward abort;
timers are cleared on abort and actual settlement.
