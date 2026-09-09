# Pure durable workflow model, v1

[Français](./WORKFLOW-MODEL.fr.md)

This internal library contains the first pure phase of the durable deployment design. It does not activate state configuration, expose MCP tools, connect to a server or create a state directory. The workflow modules import only the codec and record modules of the existing storage library. This phase does not deliver an executable deployment workflow.

## Supported internal interfaces

| Module | Interface | Result |
| --- | --- | --- |
| `src/workflow/model.mjs` | `encodePlan(plan, limits)` | Independent canonical Buffer, including the library newline, after bounded encoding and closed validation. |
| `src/workflow/model.mjs` | `decodePlan(bytes, limits)` | Detached, deeply immutable validated plan; size and lexical bounds precede parsing. |
| `src/workflow/model.mjs` | `policyFingerprint({server,target,requirePlan,stateLimits})` | SHA256 of a versioned explicit nonsecret projection. |
| `src/workflow/model.mjs` | `idempotencyKeyHash({domainId,key})` | SHA256 of the canonical object `{v:1,domainId,key}`. |
| `src/workflow/events.mjs` | `createWorkflowPolicy(plan, limits)` | Pure synchronous `{validateEvent,reduce}` callbacks for the storage library. |
| `src/workflow/budget.mjs` | `reservationFor(plan, limits)` | Immutable exact storage reservation shape. |

Other exports are private helpers shared by these modules or used to inspect reservation evidence in tests. They are not additional integration contracts.

`limits` is the closed object `{stateLimits,maxTransferBytes,maxDeployBytes,maxDeployFiles}`. The three server ceilings are required positive safe integers, with current maxima of 1 TiB, 1 TiB and 100000. `stateLimits` uses the storage library's effective closed policy. A file count must fit both file ceilings; all source bytes and the first full restoration of changed existing files must fit their respective first-pass transfer ceilings. These bounds are not reconstructed from a policy hash.

## Plan and policy representation

Plan keys are exactly `{v,createdAt,expiresAt,serverAlias,target,policyHash,files}`. Target keys are exactly `{protocol,host,port,user,root,localRoot,canonicalRoot}`. Each file has exactly `{index,localPath,remotePath,bytes,sha256,before,parent,desiredMode}`. Indices are consecutive from zero and files are ordered by `remotePath` using binary UTF-16 comparison, independent of locale. Local and remote paths are unique, normalized slash-separated relative paths under the bound roots. Planned remote files cannot also serve as another planned file's parent.

The configured remote root is normalized absolute POSIX syntax. The local root is canonical absolute native syntax; the pure layer cannot observe filesystem identity. SFTP's recorded canonical parent must be contained in `canonicalRoot`, and can differ from the lexical parent. FTP/FTPS's parent must equal the normalized lexical parent. Relative paths reject drive prefixes; non-prefix colons are preserved as POSIX names. Actual native-path interpretation, containment, parent identity, regular-file observations and source revalidation belong to later integration.

FTP/FTPS absent targets are refused in this version. SFTP absence requires later native no-such-file proof under an existing canonical parent. Existing SFTP files retain their recorded ordinary mode, new SFTP files use explicit decimal 420 (0644), and FTP/FTPS mode is null. No directories are created by this phase.

The fingerprint expects a normalized server entry. It projects only target identities/roots, six execution/scan ceilings, six policy booleans, sorted deduplicated canonical SHA256 pins, `requirePlan`, and effective `stateLimits`. Passwords, passphrases, private key paths and unrelated server fields are never traversed or hashed. A secret accessor is not read. Host/protocol normalization matches `remoteLockKey`; user case remains significant. A malformed explicit root is refused, never silently defaulted.

Fingerprint encoding has separate transient bounds: depth 8, 64 object keys, 1024 UTF-16 units per string, 1024 pins/array entries and 262144 complete bytes. Excess input fails with a safe `PLAN_UNSUPPORTED` stage; there is no truncation. Thus `maxPlanFiles:1` does not prevent multiple pins. The raw printable ASCII idempotency key is 16–128 characters and is not returned or retained by the hash function.

`INIT.planDigest` binds SHA256 of the canonical plan **payload** returned by `encodePlan`. It is deliberately different from `claim.planHash`, which the storage library binds to its sealed domain/plan-ID container. They must not be compared directly.

## Reducer and retained evidence

The reduced root has fixed fields `{v,phase,planDigest,applyCharged,recoveryCharged,files}`. Each row has `{state,backup,apply,recovery}`. Both attempt namespaces have fixed keys `a1/a2/a3`, initially null. Used slots have `{phase,token,mode,staged,cleanup,proof}`. The `staged` boolean preserves historical durable staging proof even for FTP mode null and abandoned slots. No unbounded attempt array is used.

Schema validation is separate from transition validation. Events are closed, versioned and have only the approved fields. Replay is deterministic and does not mutate inputs. All changed-existing backups must be ready before any apply staging. Attempts use consecutive slots, all predecessors must be terminal, and every token remains unique across the whole operation even after cleanup. Apply and recovery transfer charges are independent and permanent, including abandoned attempts. Recovery starts at the highest still-APPLIED index.

`APPLIED` follows a durable PROMOTING record and represents an acknowledged result supplied by later integration. Observing matching output after uncertainty yields only permanent `SATISFIED_UNOWNED`, never rollback ownership. The pure reducer checks the event contract; it cannot itself attest a remote acknowledgement, native absence or backup verification.

Cleanup requires historical durable staging and its own intent/result. INTENT-only temporaries and removal slots cannot be cleaned. Cleanup prevents later promotion/restoration of that stage. Acknowledged promotions have no remaining temporary warning. `RESTORED` retains `proof:'ack'|'observed'`; observed restoration retains its temporary warning until an independent CLEANED result. A satisfied unowned destination always makes completion a warning phase, even if its temporary is cleaned.

All apply events stop at APPLY_COMPLETE or ROLLBACK_START. All recovery events except START require ROLLING_BACK; completion ends cleanup too. Old apply temporaries cannot be cleaned after rollback starts. A nonterminal phase does not assert a currently running process. A conservative preflight sizes all six slots before admitting a policy/reservation, and every reduced state is bounded again by `maxPlanBytes`. The sizing field maxima need not be simultaneously reachable.

## Finite reservation

With unchanged `U`, changed-existing `C`, changed-absent `A`, and `D=C+A`, the event ceilings are `2+U+2C+18D` for apply and `2+18C+6A` for recovery. Each category is sized using the actual canonical sealed `{v,seq,prev,budget,event,hash}` frame plus newline, at the highest sequence/index widths. Mutually exclusive outcomes use their largest complete encoding, including RESTORED's longest proof. Null FTP modes are measured as null.

Only changed existing files reserve backups, including zero-byte backups. Claim metadata is solved monotonically using the real sealed claim grammar until `metadataBytes = 2 * encodedClaimBytes + 8192`. The finite iteration bound fails closed. Minimal admission accounts for storage's fixed domain overhead, both reserved plan slots, both journal classes, backups and metadata. The actual store must additionally account for already occupied global capacity.

The frame helper derives its budget from event scope, with no separate budget parameter. Later integration must use a private append wrapper with the same derivation, open journals through the approved exact-head/suffix checks, and call `requireBudget` for the real intent plus mandatory result before each effect. This pure phase does not implement those effectful orchestration steps.

## Verification and limits

Run `npm run test:workflow` from the source checkout root. The 100 tests in `test/workflow/` are also run by `npm test`, which CI uses. Tests use in-memory canonical storage records and never create filesystem state. They cover all transition categories, finite attempts, ownership, phase/cleanup ordering, separate charges, malformed schemas, secret projection exclusion, maximum policy/file counts, digit-width boundaries, real claim metadata and exact/+1 quota saturation.

No network, SDK integration, process locking, crash restart, encrypted transport, cross-platform CI or remote cleanup guarantee is claimed here. Those later implementation gates and their independent review remain mandatory before activating the workflow in the runtime. Hashes do not detect ABA, and content equality is not ownership.
