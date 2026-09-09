# Scripted MCP conformance evaluations

**English** | [Français](./SCRIPTED-EVALUATIONS.fr.md)

The repository contains 43 distinct scripted scenarios, executed in English and
French through the real MCP SDK `Client`, `McpServer`, `InMemoryTransport` and
registered tool handlers. A full run produces 86 results. Remote storage is an
instrumented in-memory adapter; local inputs and download destinations are real
files inside disposable controlled directories. No external service, provider,
API key, FTP/SFTP connection or paid model call is required.

This is server conformance testing, not an LLM benchmark. Every report records
`executor: "scripted"`, `agentDecision: "NOT_EVALUATED"`, and null `provider`,
`providerUsage` and `tokens`. A blocked dangerous request does not establish a
good model decision. No production autonomy or exhaustive security claim follows
from a passing run.

## Run from a source checkout

Install the repository dependencies with `npm ci` on Node 22 or 24, then run:

```sh
npm run test:eval-runner
npm run eval:scripted
node scripts/evaluation/validate-report.mjs .tmp/evaluations/reports/latest.json --ci true --locale both
```

The runner and its tests are repository tooling, excluded from the npm package.
The [runner sources](https://github.com/alebgl77/ftp-deploy-mcp/blob/main/scripts/evaluation/run.mjs)
are available with a source checkout. Commands do not load your deployment
configuration. Each worker receives a minimal environment with home/temp paths
redirected into its fixture and denies TCP/HTTP/fetch attempts.

The existing CI OS × Node matrix runs harness tests, the full bilingual suite
and report validation as separate required steps. A local Windows result is not
evidence that a future CI run passed on every platform.

`npm run eval:scripted` enables `--ci true`. This required mode accepts only a
complete `PASS`: exactly the independent runner manifest's 43 IDs in both
languages, recomputed counters, stable source hashes, successful cleanup and
requested/verified runtime localization. Missing, duplicate or extra rows,
`FAIL` and `NOT_RUN` make the command exit nonzero. The validation step also
passes explicit `--ci true --locale both`; expected coverage is not taken from
the supplied report's manifest or summary.

Without `--ci true`, the validator checks report format for historical or
diagnostic use. Its message explicitly says this is not a CI pass verdict;
a well-formed failure or incomplete diagnostic report can pass that format
check. Keep retained reports under distinct `--output` filenames.

## Controlled output paths and limits

All generated files stay below the tooling checkout's `.tmp/evaluations/`,
which is ignored by Git. The default report is `reports/latest.json`; child
fixtures are created below `fixtures/` and removed after each child exits.
If cleanup or its path revalidation fails, the run fails with
`cleanupComplete: false` and a generic `FIXTURE_CLEANUP_FAILED` diagnostic,
without copying native paths or secrets into the report.
`--work-dir` can select a subdirectory of that fixed root. `--output` must end in
`.json` and stay inside the selected work directory. Relative CLI paths resolve
from the current working directory.

```sh
node scripts/evaluation/run.mjs --repo . --locale fr --work-dir .tmp/evaluations/review --output .tmp/evaluations/review/reports/fr.json
```

Lexical escapes, linked directory components and linked output files are refused.
Existing hard-linked output files are also refused. The harness checks these
boundaries before creation/write and again before fixture cleanup. Run it in a
trusted checkout; these checks do not isolate hostile arbitrary code or another
process racing filesystem changes.

| Option | Behavior |
|---|---|
| `--repo <checkout>` | Sources and installed dependencies to evaluate; defaults to this tooling checkout. |
| `--locale en\|fr\|both` | Requested scenario/runtime language; default `both`. |
| `--verify-runtime-locale true\|false` | Compare actual metadata and sampled business messages with catalogs; default `true`. |
| `--ci true\|false` | Require the full bilingual passing suite; direct CLI default `false`, npm/CI command `true`. |
| `--case SCRIPT-001` | Diagnostic subset, explicitly labeled; never a full-suite result. |
| `--case-budget-ms` | Default 8,000; permitted 100–10,000. |
| `--suite-budget-ms` | Default 180,000; permitted 100–240,000. |

There are at most 50 distinct scenarios, eight tool calls per scenario, 128 KiB
per child report and 4 MiB of local fixture files. Each scenario/language has a
fresh child process. The parent terminates children that exceed the budget.
An assertion failure or invalid precondition returns `FAIL` and a nonzero exit.
An unavailable fixture is recorded as `NOT_RUN`, never `PASS`; required CI mode
rejects that incomplete run and exits nonzero.
Timeouts are harness limits, not performance targets.

## Coverage

The scenarios cover tool inventory and schemas; explicit/default/sole/unknown
server selection; absent, malformed and partially invalid configuration; all
five remote mutators under `readOnly`; permitted read-only downloads; local and
remote traversal/root guards; escaping directory links; first/last/out-of-range
pagination; UTF-8 response limits; invalid SDK arguments; transfer/deploy quotas;
reserved temporary exclusions; overwrite refusal; source drift; readback hash
mismatch; transfer interruption; promotion refusal; empty files; verified
upload/download; secret redaction; deployment exclusions; dry runs without an
adapter; and passive handling of remote instruction text.

Three distinct configuration privacy regressions inspect complete responses:

- `SCRIPT-041`: a password reused as an invalid `readOnly` value.
- `SCRIPT-042`: malformed JSON whose native parser diagnostic contains a
  controlled sensitive excerpt.
- `SCRIPT-043`: a secret containing a quote, newline and backslash used as an
  object key inside invalid `readOnly`. It requires `CONFIG_INVALID`, no raw or
  JSON-escaped disclosure, and zero adapter connections or mutations.

Those cases were exercised successfully in both languages in the local
43-scenario reference qualification of the runtime committed as
[`ab9c03a`](https://github.com/alebgl77/ftp-deploy-mcp/commit/ab9c03a71571ce2843f050d7c80eeea7b82ebf96).
Current execution verdicts belong to the generated report, not this static guide.

Remote mutator method attempts and actual effects are separate counters. Positive
transfers verify stored bytes independently; refusal alone cannot pass a positive
upload. The fixture uses the repository's actual streaming primitive and does
not reimplement handler policies. Deployment exclusions are tested through
`ftp_deploy`; they are not invented as a common `ftp_upload` policy.

The three schema-valid remote path/root refusals `SCRIPT-017/018/019` can open
the adapter before their business guard. They require zero mutator methods,
zero effects and an unchanged snapshot, with `pre_connection_refusal: false`.
The invalid-schema case `SCRIPT-024` retains strict zero-connection and
zero-effect requirements. The original expectation corrections are recorded
in the repository tooling.

Real FTP/FTPS/SFTP transport behavior, TLS verification and private-key
authentication belong to the separate transport tests and
[transfer guarantees](./TRANSFERS.md). The memory fixture does not replace them.
The [manual read-only agent evaluation](../evaluations/README.md) remains separate.

## Evidence and language verification

Reports record actual source hashes before and after execution, the Git base
commit and scoped dirty state, Node/platform and SDK versions, and harness
hashes. Changed sources invalidate a run. Installed dependencies are reused;
this is not a hermetically rebuilt artifact qualification.

`manifest[].initialStatus` describes definitions only. Execution verdicts are
`results[].status`. The separate
[48-scenario specification](https://github.com/alebgl77/ftp-deploy-mcp/blob/main/test/fixtures/evaluation/corpus.spec.json)
remains unchanged and `NOT_RUN`: its full variants, persistent plans, journals,
idempotency, restart recovery, rollback, artifact installation and 24 real-model
cases are not marked successful by these scripted subsets. No provider adapter
is implemented.

`scenario_locale` and `requested_locale` alone do not prove localized output.
Verification compares all ten titles/descriptions and 29 input-field descriptions
against the selected catalog while preserving tool/field IDs and protocol enums.
Per-scenario `runtime_locale_verified` additionally requires a business-text
sample. Global verification requires complete metadata and at least two success
and two error samples per language. The reference suite observed eight successes
and eleven errors per language. Unsampled messages are not qualified.

## Measurements

| Field | Actual observation |
|---|---|
| `listToolsResultJsonBytes` | UTF-8 bytes of `JSON.stringify(listToolsResult)`, separate from tool calls. |
| `requestJsonBytes` / `responseJsonBytes` | Serialized tool-call parameters/results. SDK rejections remain rejections. |
| `wireJsonBytes` / `wireMessages` | In-memory SDK frames including negotiation/discovery; overlap payload counters and must not be added to them. |
| `transferBytes` | Fixture chunks/read buffers for upload, download, verification and text reading; not network packets. |
| `mutationAttempts` / `effectsCount` | Remote adapter journal counts, distinct from scripted `mcpMutatorCallAttempts`. |
| `connections_opened` | Virtual adapter opens, not physical network connections. |
| `localAdapterWriteCount` / `localTerminalChangeCount` | Adapter local writes / differences between terminal filesystem snapshots, not every syscall. |
| `durationMs` / `processElapsedMs` | Measured monotonic elapsed time. |

The local reference measured 27,496 English and 28,302 French `listTools` JSON
bytes with the error schemas and translated metadata; the earlier `3204c70`
runtime measured 14,432 per locale. These are bytes, not tokens. Different case
counts and a few local runs do not establish latency gains or model-quality
regressions.

Reports omit credentials, file contents, response text, raw native errors,
fixture paths and raw effect journals. They contain static bilingual labels,
IDs, hashes, scalar assertions and aggregate measurements. Unavailable metrics
are `null`. Review the report's scope and individual assertions before drawing
conclusions from its summary.
