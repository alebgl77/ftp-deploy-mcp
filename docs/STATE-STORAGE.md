# Internal state storage primitives

[Français](./STATE-STORAGE.fr.md)

This dependency-free internal library implements storage primitives only. It is
not connected to MCP tools, configuration, deployment, rollback or production
servers. The application must supply a closed plan schema and a pure event
validator/reducer. Storage never decides that a remote effect belongs to an
operation. A request UUID is not a persistent operation ID. No deployment
workflow is delivered by these primitives.

Run the isolated suite from the source checkout root:

```text
npm run test:state
```

Tests write only under `.tmp/state-tests/` and validated sibling fixtures. Child
processes deliberately crash and the tests explicitly remove stale locks only
after the process exits, to inspect retained evidence. This test-only recovery
helper is not exported by the library.

## Qualification scope

The isolated suite contains 123 tests, including 17 storage regressions. Local
qualification covers Windows/NTFS with Node 22.23.2. It does not establish
network integration, OS/Node CI qualification or a published release.

## API

Import the following from `src/state/index.mjs`:

```js
validateStateLimits(input = {})
openStateStore({ stateDir, localRoots, limits, signal, fault, create = true })
StateError // .code and .stage; no native detail/cause or persisted stack
```

`stateDir` is an explicit absolute canonical path. Canonical `localRoots` must
be disjoint from it in both directions. For an absent path, the nearest existing
ancestor establishes the projected canonical identity; siblings are allowed.
Identity and containment are checked again on opens. No supplied directory
means `STATE_DISABLED` and no creation. `create:false` makes an absent or empty
uninitialized directory fail with `STATE_INVALID/domain_uninitialized`, without
mkdir, lock or record writes. Nonempty uninitialized state is corrupt. A valid
existing domain still takes admission when opened.

Store methods:

```js
store.metadata
store.withEndpointLock(endpointSha256, async () => result)
store.publishPlan(planId, validatedPlanBytes) // -> { planId, digest }
store.readPlan(planId) // -> independent Buffer of canonical JSON + newline
store.claim({ planId, keyHash, targetHash, reservation, initialEvent,
              validateEvent, reduce }) // -> verified claim envelope
store.lookupClaim({ planId }) // or exactly { operationId }; envelope or null
store.openJournal(operationId, { validateEvent, reduce }) // -> writer
store.inventory() // bounded counts, actualBytes and reservedBytes
store.close() // await owned work and close owned backup readers
```

IDs are lowercase canonical UUID v4 values: plain domain UUID, `pln_<uuid>` and
`op_<uuid>`. Hashes are lowercase SHA256. Plans/claims bind version, domain and
identity, and digest canonical fields. Claims additionally bind the exact plan
digest, key hash, target hash and reservation. A repeated exact association
returns the same claim; another key for a consumed plan or another plan for a
key is a conflict. This does not retry application work.

```js
reservation = {
  applyJournalBytes, applyJournalEvents,
  recoveryJournalBytes, recoveryJournalEvents,
  backupBytes, backupFiles, metadataBytes,
  backups: [{ fileIndex, expectedBytes, expectedSha256, mode }]
}
```

`mode` is null or an ordinary mode between 0 and 0777. Indices are unique and
below maxPlanFiles. Exact reserved backup bytes/counts must fit the aggregate
backup capacity. An empty file still reserves an index and an artifact. The
separate journal classes cannot borrow each other's capacity.

`validateEvent(event)` must synchronously return exactly true. `reduce(state,
event)` must synchronously return bounded JSON state, starting with undefined.
Both execute at initialization, append and replay. Inputs and returned state
are copied; caller mutation cannot rewrite validated state. Asynchronous
callbacks are refused and late rejections consumed. The library rejects
prototype keys and explicit credential/diagnostic keys as an extra defense;
this is **not general secret detection**. Only the integration's closed schemas
decide which metadata is permitted. Native Error/config objects are not records.

Writer methods:

```js
writer.metadata // copies of tip, budget usage, reduced state; poisoned flag
writer.requireBudget({ bytes, events, budget: 'apply' | 'recovery' })
writer.append(event, { budget: 'apply' | 'recovery' })
writer.createBackup({ fileIndex, expectedBytes, expectedSha256, mode,
                      read: async sink => { /* honor sink backpressure */ } })
writer.openVerifiedBackup(index, { expectedBytes, expectedSha256, mode })
```

The returned backup reader has metadata, `revalidate()`, explicit positional
`read(buffer, offset, length, position)` and `close()`. It exposes no raw path or
raw file handle. Reads are capped at verified length, allow one active read per
reader, and close waits for a dispatched read. The owning store also closes
readers. Caller revalidates at use. Original mode is metadata; backup blobs stay
private 0600 rather than inheriting the remote file's mode.

`createBackup` allocates only its claim's exact index with wx. It checks actual
streamed bytes, SHA256 and exact length, syncs and closes before acknowledgement.
It awaits an abort-ignoring reader and delayed file close. Excess input or
ignored backpressure fails closed. Partial blobs remain explicit and cannot be
overwritten. Application backup intent/readiness events are the caller's job.
Storage never appends readiness or promotes a remote file automatically.

Backup dispatch checks the byte cap inside `_write`, including chunks supplied
by `end(chunk)` and a zero-byte reservation. The separate queue guard remains.
Destroying a Writable does not prove its asynchronous filesystem write settled:
the library tracks that work explicitly and awaits it before closing the handle,
releasing the backup slot or endpoint ownership, or completing store.close.
Post-open stat failures also await closure of the exact opened handle.

## Bounds and accounting

| Limit | Default | Maximum |
|---|---:|---:|
| maxStateBytes | 1073741824 | 17179869184 |
| maxBackupBytes | 536870912 | 8589934592 |
| maxPlans | 100 | 1000 |
| maxOperations | 100 | 1000 |
| maxPlanFiles | 1000 | 10000 |
| maxPlanBytes | 4194304 | 33554432 |
| maxJournalBytes | 16777216 | 268435456 |
| maxJournalEvents | 50000 | 500000 |
| maxBackupFiles | 10000 | 100000 |

Limits are positive safe integers; unknown keys and maxBackupBytes greater than
maxStateBytes fail validation. The complete envelope counts toward its file
limit. Domain/head/event lines include newline and are at most 4096 bytes;
plans/claims use maxPlanBytes. Nesting is at most 8, strings at most 1024 UTF-16
code units, arrays at most maxPlanFiles and objects at most 64 keys. Persisted
bytes/lexical shape are bounded before JSON.parse. Encoding also spends a byte
budget while traversing rather than building an unbounded intermediate tree.
Duplicate keys, alternate JSON spellings, dangerous keys and invalid UTF-8 fail.

Logical retained reservation is:

```text
67 * 4096 fixed bytes
+ 2 * maxPlanBytes per plan
+ applyJournalBytes + recoveryJournalBytes + backupBytes + metadataBytes per claim
```

The fixed reserve covers one domain marker and the 66 bounded lock records.
Each metadataBytes must cover at least twice its encoded claim size plus 8192
bytes for head/publication metadata. Journal and backup capacities are separate
and not counted again as metadata. Plans reserve their maximum immutable and
temporary footprint even when smaller. Inventory counts actual files, including
empty blobs and lock records, while conservative capacities remain charged.
The artifact ceiling is 71 fixed + 3 per plan + 6 per operation + 2 per reserved
backup file. Unexpected shapes fail before descending into arbitrary trees.

maxStateBytes measures logical bytes/reservations, **not allocated filesystem
blocks, inode usage or free disk**. Independent maxima need not fit together.
No automatic purge, claim eviction, quota reclamation or orphan removal exists.

## Ordering, corruption and platform scope

Fixed layout: domain.json, plans/, claims/, operations/, locks/. Claims are named
by plan ID. Operations contain journal.jsonl, head.json and backups/index.blob.
Publication temps have unpredictable library-generated names. Nothing derives a
filename from model paths, event content or a raw idempotency key.

The lock order is external process endpoint mutex → endpoint file stripe →
short global admission. There are exactly 64 stripes: first 8 hash hex digits
modulo 64, named stripe-00.lock through stripe-63.lock. Distinct endpoints may
collide. Locks use wx, bounded owner tokens and fail-fast STATE_BUSY. There are
no library waiters, retry timers, TTL/PID stealing or global signal handlers.
An endpoint's record can be observed during its bounded initialization;
inventory counts its artifact, while only the owner validates its token before
release. Admission serializes metadata mutation, replay and inventory. Backup
streaming and endpoint callbacks run outside admission.
If a recognized endpoint stripe disappears between listing and stat, inventory
tolerates only ENOENT for that stripe. Admission, persistent references, unknown
names and other filesystem errors remain strict failures.

Immutable publication uses a synced/closed sibling temporary, a same-directory
hard-link create, unlink of that owned temporary, then directory sync. No-clobber
unsupported by the filesystem fails closed. Head replacement uses same-directory
rename; it never deletes the destination first. Claims are published **last**,
after initial journal/head sync and close. Their publication is the authority;
the library has no callback that performs an effect as part of a claim.

Journal hash chains include sequence, previous hash, budget class and validated
event. Head records exact byte length, sequence and hash. Replay verifies all
events and compares head exactly. Append checks the small cached tip and file
identity, writes without O_CREAT, syncs/closes, then publishes head. It does not
replay the journal per event. A stale writer receives STATE_BUSY/stale_writer.
A persistence failure poisons its writer; explicit reopen must validate all
evidence. Removed suffixes, extra suffixes, partial lines, missing references,
unknown versions and orphaned temps are never adopted, repaired or reset.

Cancellation can refuse admission; it never releases ownership around a pending
write/sync/close/callback. `close()` is called outside owned callbacks and settles
them. Failure to remove a lock leaves it locked. Offline recovery requires all
cooperating writers stopped; inspect and retain evidence before any operator
decision. No automatic recovery command is supplied by this internal library.

The executed platform is Windows with Node 22.23.2. A real directory handle
opened successfully; fsync returned EPERM with syscall fsync; close succeeded.
The opened handle must first pass FSTAT/isDirectory. Only **win32 + EPERM +
syscall fsync on that proven directory handle** maps to
metadata `directorySync:false`, `directorySyncLimitation:'windows_eperm_fsync'`.
Ordinary files are refused, and a failed FSTAT still awaits handle closure.
An EPERM from file sync, open, close, link, rename or any other operation is not
suppressed. Unexpected directory sync failures also propagate. POSIX creations
use 0700/0600 and directory/privacy checks; POSIX gates are present but were not
executed on this Windows host. Windows requires operator-controlled ACLs.

Metadata reports process-crash support and `powerLoss:'not_guaranteed'`. There
is no universal power-loss, atomic-site, transactional deployment, remote
ownership, cross-host or hostile same-account guarantee. Coherent restoration
of an old whole-domain snapshot cannot be detected by these digests. A malicious
operator can recompute them. Same-account races and filesystem-specific hard
link/rename behavior remain explicit limits. Integration still needs its own
closed reducer, effect ordering, ownership, expiry and rollback tests.
