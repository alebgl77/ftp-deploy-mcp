# Verified staged promotion

[Français](./TRANSFERS.fr.md)

`ftp_upload`, `ftp_deploy` and `ftp_download` verify each file before promoting
it to its requested destination. Tool names and success fields remain unchanged.

## Upload and deployment

While holding the process-wide endpoint mutation lock, the server hashes the
local source with SHA256, uploads it to an unpredictable sibling named
`.ftp-mcp-<random>.tmp`, then reads that temporary file back. Its actual byte
count and SHA256 must match the source expectation before one rename promotes it
to the final path. Zero-byte files follow the same process.

If upload, verification or rename fails, the server never deletes the final
destination to make promotion succeed and never falls back to a direct overwrite.
It attempts to delete only its own temporary file. A cleanup failure preserves
the original diagnostic and adds a bounded warning that a temporary may remain.
Ordinary deployment failures retain the existing partial-result behavior;
cancellation or expiration stops subsequent stages and files.

FTP and standard SFTP rename behavior depends on the server and filesystem.
Replacement of an existing destination may be rejected. This feature does not
require the SFTP POSIX rename extension, promise universal atomic replacement,
or make a multi-file deployment atomic.

## Download

The server holds the lock for the canonical local destination across remote
servers and configured path aliases. It first reads a bounded remote SHA256
expectation, then downloads to an exclusive, unpredictable sibling temporary.
The actual downloaded bytes are bounded and their SHA256 must match. The
temporary is synchronized to disk and closed before promotion.

Containment, destination identity and overwrite policy are checked again before
promotion. With `overwrite:false` (the default), a same-directory hard link
creates the destination only if it is still absent, then the owned temporary is
unlinked. If another file appears, it is preserved. Filesystems that cannot
create hard links fail closed; there is no check-then-rename fallback.
With `overwrite:true`, a same-directory rename promotes the complete temporary.
Failures before promotion preserve the existing destination. A failed temporary
unlink after a successful hard-link promotion returns success with a cleanup
warning, because the requested complete file already exists.

The basename pattern `.ftp-mcp-*.tmp` is reserved and always excluded from
`ftp_deploy`, at the source root and in subdirectories, including when an
explicit `include` pattern matches it. This prevents this tool's deployment
selection from uploading a concurrent download's partial temporary.

## Configured limits

These optional fields belong to each server in the configuration file. Tool
arguments cannot override them.

| Field | Default | Maximum |
| --- | ---: | ---: |
| `maxTransferBytes` | 268435456 (256 MiB per file) | 1099511627776 (1 TiB) |
| `maxDeployFiles` | 10000 selected files | 100000 |
| `maxDeployBytes` | 1073741824 (1 GiB per deployment) | 1099511627776 (1 TiB) |

Values must be positive safe integers. Zero-byte files are accepted within a
positive limit. Known oversized uploads and deployments exceeding selected
file count, individual file size or total bytes are rejected before connecting.
Streaming checks count actual bytes, including hash readback and downloads;
declared file sizes alone cannot bypass a limit. Deployment checks also enforce
the cumulative source-byte budget as files are processed.
Each upload and its readback are additionally capped at the source's hashed
size, including zero. Failed attempts retain their reservation in the deployment
byte budget, so a growing source cannot send unbudgeted extra bytes.

## Limits of the guarantee

SFTP staging first creates an exclusive empty temporary with the server's
normal effective permissions, records those bits, then sets and verifies 0600
before writing source content. Before promotion it restores the existing
regular destination's permission bits (0777), or the recorded server mode for
a new destination. A required stat or chmod failure prevents promotion.
Downloads likewise copy an existing destination's 0777 bits to the local
temporary before synchronization; new local files keep the 0600 creation mode.
On Windows, native filesystem permission semantics apply.

FTP/FTPS has no portable permission-preservation mechanism here. Replacing an
existing remote file can change its permissions to the server's creation
defaults, including executable or private-file permissions. Configure the
remote account, umask and ACL policy appropriately before using staged FTP
replacement. Content verification does not preserve ownership, ACLs, extended
attributes, timestamps, hard-link relationships or special permission bits.

Readback verification adds network traffic and latency. A successful transfer
verifies one complete file's content; it is not a performance optimization or a
site transaction. There is no durable transfer journal, automatic rollback or
retry of an uncertain mutation.

Cancellation and deadlines stop later stages and close the transport. They do
not undo a promotion already accepted by the server, and an interrupted rename
can have an uncertain outcome. Temporary files may remain after interruption;
inspect the destination and temporary files before retrying. A noncooperative
operation retains its process lock until it actually settles.
An SFTP connection pins its initial canonical root. A known root change causes
`TARGET_CHANGED`; verification, promotion and cleanup refuse to rebase an
owned temporary onto the new root. The creation identity records the original
canonical root and path internally. Cleanup may therefore leave the owned
temporary under the old root for manual inspection instead of risking an
unrelated file under the new root.

Locks protect only one Node.js process. They do not coordinate separate
processes, remote writers or other programs sharing a host. Validation does not
claim protection against malicious same-OS-user path or source-file races.
Transfer quotas do not yet bound the complete local directory enumeration, and
the reserved-name rule does not prevent another OS tool from reading a temporary.
Selection uses synchronous recursive directory reads and has no per-directory
cancellation checkpoint or visited-entry limit. Excluded subtrees are pruned
where the existing patterns permit it, but many empty directories or unmatched
entries can still consume unbounded scan work relative to the selected-file
quota. A pre-aborted request is refused before scanning. During a scan, timer
and cancellation notifications can be delayed by the blocked event loop;
the elapsed deadline is checked at the next operation checkpoint, before
connection or returning a dry-run result. The configured timeout is therefore
not a hard wall-clock bound on directory discovery.

Internally, SFTP keeps an exclusive handle through initial FSTAT, restrictive
FCHMOD, confirming FSTAT and sequential bounded WRITE calls; CLOSE remains
awaited on failure or cancellation. Promotion reads existing mode bits via
the adapter's private `safePath` result. The initial temporary mode travels
only between adapter and transfer helper. These are internal details available
for future work; this release does not persist them in a rollback journal.
