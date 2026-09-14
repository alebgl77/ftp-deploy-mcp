# Release Guide

**English** | [Français](./RELEASE.fr.md)

This is the maintainer checklist for the GitHub source release v0.2.1 and,
separately, a future first npm and Official MCP Registry publication. A GitHub
release does not make the npm identifier, `npx` command or registry entry
available. The published GitHub v0.2.0 tag and release remain immutable.

Check available source assets on [GitHub Releases](https://github.com/alebgl77/ftp-deploy-mcp/releases/latest).
The npm and MCP workflows are manual (`workflow_dispatch`); do not dispatch
them as part of a source-only GitHub release.

## Manual prerequisites

Complete these outside the repository before dispatching npm or MCP publication:

- Confirm control of the intended npm package name and maintainer access to the
  npm account or organization.
- Enforce npm two-factor authentication and use a dedicated maintainer account
  with least privilege.
- For a package that already exists, configure npm Trusted Publishing for
  `alebgl77/ftp-deploy-mcp` and workflow filename `release.yml`. No named GitHub
  environment is configured by these workflows.
- For the **first** publication, npm requires the package to exist before a
  trust relationship can be configured. A maintainer must create a short-lived
  granular token with the minimum available publish scope and the required
  non-interactive/2FA permission, and store it only as `NPM_TOKEN` in GitHub
  Actions secrets. After the first successful publish, configure Trusted
  Publishing, remove that secret, and revoke the token immediately. Never
  commit, paste into an issue/chat, or print the token. Do not create a
  persistent token as a workaround. See [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
  and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- Confirm that the release workflow requests npm provenance and has only the
  permissions it needs. Repository automation cannot create npm ownership or
  approve a new package name.
- Establish the publisher identity and namespace required by the official MCP
  registry, and confirm access to its current publishing tool. A prepared
  manifest or third-party index listing is not a registry publication.
- Confirm that GitHub environments, required reviewers, branch protection, and
  release permissions are in place.

Record who completed each manual prerequisite and when. Do not start npm or MCP
publication while any ownership or credential step is unresolved. These registry
prerequisites do not establish whether a GitHub source release is ready.

## Version and changelog gate

For the v0.2.1 GitHub release:

1. Set `version` in [package.json](../package.json), the root and root-package
   metadata of `package-lock.json`, and `server.json` to `0.2.1`. The source lockfile
   is the sole authoritative lockfile; do not keep a parallel `npm-shrinkwrap.json`.
2. Set the MCP server's reported version to the same value. Search the source
   and generated metadata for stale release strings; expected historical
   references in the changelog are exempt.
3. Use the paired heading `## [0.2.1] - 2026-09-14` in
   [CHANGELOG.md](../CHANGELOG.md) and [CHANGELOG.fr.md](../CHANGELOG.fr.md).
   Confirm the effective release date is a valid calendar date, update it only
   if the actual release day changes, and preserve the complete 0.2.0 history.
4. Confirm every user-visible patch change is documented in both
   [README.md](../README.md) and [README.fr.md](../README.fr.md).
5. Verify the release includes atomic replacement for newly written sensitive
   configuration and tests its failure path. This is a release gate, not a
   documentation-only claim.
6. Confirm `node src/index.js --version`, package metadata, source lockfile and tag
   agree. Verify npm and Official MCP Registry versions separately only after
   their respective publications.

Use a dedicated release commit. Never move or reuse the published v0.2.0 tag.

## Review the source and installed dependency graphs

The sole source authority is `package-lock.json`, with six exact direct pins and
112 non-root records: 110 production and two development. Source/Docker/user
installs use `npm ci --omit=dev --ignore-scripts`; contributors use
`npm ci --ignore-scripts`. No shrinkwrap is retained. npm 12 no longer reads or
writes shrinkwrap files, including in dependencies; see the
[official npm lockfile documentation](https://docs.npmjs.com/cli/v12/configuring-npm/package-lock-json/).

For an approved dependency update, change only the intended exact versions and
regenerate the source lock with scripts disabled. Record Node/npm versions and
review every graph change, registry URL, integrity value and optional/platform
constraint. Keep the original reviewed source inventory as the authority when
checking installations; never update it from the installed graph.

The built-in-only graph verifier reads actual package manifests and installed
lock records, including the hidden lock when present. It resolves transitive
dependencies and peers from their real locations, including hoisted and nested
packages. It rejects version/resolution/integrity drift, undeclared extras,
missing required packages and changed dependency declarations. Declared optional
omissions and source-proven development packages are reported separately; a
present optional dependency with changed bytes or metadata is not an omission.
No dependency code is imported by this verifier.

## Qualify the source installation archive

There are two fixed distributions. `ftp-deploy-mcp-0.2.1-source.tar.gz` contains
82 regular files under `package/`, including the source lock. It is an
installation archive, not the complete repository: tests, maintainer scripts and
the HTML guide remain in the repository. GitHub's automatic source ZIP/tar
contains the complete repository. The separate npm archive
`ftp-deploy-mcp-0.2.1.tgz` contains 81 files and no lockfile.

Capture all 82 reviewed source files before installation, tests or packing.
Keep the portable inventory outside the checkout and retain its original SHA256
independently of any generated proof. A source-only snapshot qualifies a pre-tag
candidate; publication requires the actual clean tracked tag/event checkout.
For a pre-tag candidate, run from the intended checkout (Bash):

```bash
source_root="$(pwd -P)"
release_tmp="$(mktemp -d)"
inventory="$release_tmp/source-inventory.json"
node scripts/release-artifact.mjs snapshot "$inventory" --source-root "$source_root" --source-only
```

Record the original snapshot output in `inventory_sha256` before continuing.
Never replace it with a value reread from a rewritten proof.

```bash
npm ci --ignore-scripts
npm test
npm run test:release
node scripts/release-gate.mjs --source-only --runtime
node scripts/release-artifact.mjs build-source "$release_tmp/source-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --source-only
node scripts/release-artifact.mjs preflight "$release_tmp/source-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --distribution source
```

The builder writes only captured bytes into a private staging directory and uses
real tar with bounded stdout. It validates every byte before exclusive archive
and metadata writes. Retain the preflight's original canonical `tarball` path
and SHA512 `integrity` outputs in those variables, then install in a fresh folder:

```bash
mkdir "$release_tmp/consumer"
tar --ignore-zeros -xzf "$tarball" -C "$release_tmp/consumer"
(cd "$release_tmp/consumer/package" && npm ci --omit=dev --ignore-scripts)
node scripts/release-graph.mjs --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --product-root "$release_tmp/consumer/package" --install-root "$release_tmp/consumer/package" --output "$release_tmp/source-graph.json" --source-only
npm audit --prefix "$release_tmp/consumer/package" --omit=dev --audit-level=moderate
node scripts/release-artifact.mjs check "$release_tmp/source-pack.json.verified.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --expected-integrity "$integrity" --expected-tarball "$tarball" --distribution source --source-only
```

Run the independent consumer runtime/transport cases, audits and production SBOM
checks against this extracted installation before approving it. The installed
product needs no `.git`; its Git provenance comes from the external checkout and
original inventory. Never install the source tar.gz as an npm package. Users
extract `package/`, run `npm ci --omit=dev --ignore-scripts` there, then run
`node src/index.js setup` explicitly. Contributor commands run from the full
repository, not from this installation archive.

The proof binds an explicit `source` or `npm` distribution, exact filename,
`package/` prefix, scope, commit, inventory SHA256, original integrity and
canonical artifact path. The controller supplies the expected distribution;
`inspect`/`check` default to npm and refuse a source proof. Changing a proof or
renaming an archive cannot change its distribution.

## Keep npm qualification separate

npm remains unqualified: a real npm 10.9.8 consumer changed ten production
dependencies. Its failed candidate and reports are retained, never promoted to
source-release evidence or attached as a qualified asset. A future matching npm
graph would establish only the tested environment/date, not reproducibility of
future npm installs. To inspect a separate npm candidate with the original
82-file source inventory:

```bash
npm pack --ignore-scripts --json --pack-destination "$release_tmp" > "$release_tmp/npm-pack.json"
node scripts/release-artifact.mjs preflight "$release_tmp/npm-pack.json" --source-root "$source_root" --inventory "$inventory" --inventory-sha256 "$inventory_sha256" --distribution npm
```

Inspection checks all 81 npm bytes against the source; the source lock remains
external authority. Install this exact npm candidate in an isolated prefix with
scripts disabled, then invoke `release-graph.mjs` with `--product-root` pointing
to `<prefix>/node_modules/ftp-deploy-mcp` and `--install-root` to the prefix.
Any graph difference must fail before smoke tests, artifact transfer or npm/MCP
publication. A source-only pass never authorizes a registry publication.

## Artifact validation and provenance limits

The fixed allowlists exclude local configuration, credentials, tests, temporary
files and maintainer state. Complete package metadata and the source lock are
structurally validated; each shipped byte must match the original inventory.
Publication commands receive real `GITHUB_REF` and `GITHUB_SHA` from GitHub;
HEAD and the exact tag target must match that event. Never invent this context.
Use `snapshot` without `--source-only`, `inspect` instead of `preflight`, and
`check` without `--source-only` only in that real publication context.

Compressed bytes are read once with an 8 MiB cap and provide the original SHA512.
Strict built-in gzip decoding has a 32 MiB total output cap, including TAR headers
and padding. `engine.bytesWritten` must be an integer within the input length;
any unconsumed byte must be NUL. Terminal NUL padding is allowed, nonzero hidden
tails are rejected. Every inspection tar call receives the same decoded raw TAR,
without `-z`, and uses `--ignore-zeros`. Untrusted archive paths are never
extracted to disk during inspection.

| Inspection limit | Maximum |
|---|---|
| Compressed archive | 8 MiB |
| Complete decoded TAR, headers and padding included | 32 MiB |
| Each expected or extracted file | 1 MiB |
| Complete inspection | 90 seconds |
| Each tar invocation | 15 seconds, or the shorter remaining budget |

These are input/output/time limits, not an exact memory bound. The deadline is
checked before and after synchronous gzip decoding and cannot preempt it. Failed
validation emits no new proof or publication outputs. Recheck original inventory,
source bytes, integrity and path immediately before publication. The controls
assume trusted workflow code and runner, not a fully compromised runner.

Git commit identity, checkout byte inventory and archive digest are distinct.
CRLF/LF checkout conversion can produce different valid inventories on different
systems. Qualification binds the exact Windows-built asset to its recorded
checkout bytes; the six OS/Node CI jobs qualify their own checkouts, not that
Windows archive on every OS. After the final commit, establish an inventory for
that commit and reinspect the same frozen bytes before release. Retain the
pre-commit evidence as historical evidence, not as the final commit binding.
On Windows, use native PowerShell paths, environment assignments and output
handling instead of the Bash syntax above.

## Separate qualification from publication

The npm qualification job has `contents: read`, no OIDC permission and no
secrets. It captures the source inventory before installation/tests/packing,
then installs, tests, audits and qualifies the exact archive and consumer.
The publication job starts on a fresh runner after qualification succeeds.
Both checkouts are pinned to the event's `github.sha`; HEAD and the actual tag
target must match that commit. Build outputs cannot select the privileged code.

Only the `.tgz`, pack JSON and source inventory cross the job boundary through
the exact upload artifact ID, downloaded outside the fresh checkout. No scripts,
`node_modules`, caches, environment files or first-runner proof are transferred.
The inventory is portable: commit, release identity, relative paths, sizes and
byte hashes. Each command validates its own explicit canonical source root;
moving roots never rewrites the original inventory bytes or SHA256.

Qualification job outputs retain the original inventory SHA256 and archive
SHA512. Fresh privileged `inspect` must enforce that original expected integrity
against both pack JSON and compressed bytes before creating a local proof or
outputs. It binds the portable inventory to the fresh source and newly downloaded
canonical archive path. The final `check` uses the original inventory digest and
the privileged inspection's integrity/path outputs; npm publishes only that
checked path with `--provenance` and lifecycle scripts disabled. Registry
verification retains those same original bindings.

The privileged inspection receives `SOURCE_INVENTORY_SHA256` and
`BUILD_INTEGRITY` from the original qualification job outputs:

```bash
node scripts/release-artifact.mjs inspect "$RUNNER_TEMP/release-input/release-pack.json" --source-root "$GITHUB_WORKSPACE" --inventory "$RUNNER_TEMP/release-input/source-inventory.json" --inventory-sha256 "$SOURCE_INVENTORY_SHA256" --expected-integrity "$BUILD_INTEGRITY"
```

The first qualification inspection emits the original archive digest; this
fresh privileged inspection must require it, not choose a new expected value.

Privileged jobs run only approved validators using Node built-ins, the npm CLI
or the pinned MCP publisher. They run no `npm ci`/`npm install`, project tests,
consumer smoke checks or `--runtime`. `NPM_TOKEN`, when needed for bootstrap,
exists only in the final npm publish step. The MCP workflow uses the same job
separation. Its nonprivileged job first captures the inventory, then `fetch-npm`
verifies registry identity and SHA512, requires the fixed official HTTPS URL,
downloads within the 8 MiB/time bounds and inspects all 81 files. It installs that
actual download without scripts, checks the graph and runs consumer checks. The
job output retains this qualified archive's original integrity. The privileged
job receives it and requires it from the registry again before authentication:

```bash
node scripts/release-artifact.mjs verify-npm --source-root "$GITHUB_WORKSPACE" --expected-integrity "$QUALIFIED_INTEGRITY" --distribution npm
```

The standalone `verify-npm` form therefore enforces expected integrity too.
No dependency files or code from the first runner are transferred; only the fresh
event-pinned checkout supplies the published `server.json`.

## GitHub release and assets

After independent qualification and review, use the final verified commit,
require its complete public CI, then create v0.2.1. Retain the exact validated
`ftp-deploy-mcp-0.2.1-source.tar.gz` bytes. Prepare `SHA256SUMS` for this archive,
the standalone bilingual HTML guide and final evidence/SBOM; upload only these
verified files. Publish EN/FR notes that accurately describe the source scope,
then download again and verify hashes. Record commit, tag, actual time, names
and digests.

Attach no drifting npm `.tgz`. GitHub's automatic ZIP/tar remains the separate
complete repository. Asset uploads remain pending until verified; npm and MCP
remain unqualified/pending. A source release does not make npm, `npx` or the
Official MCP Registry available.

## Publish npm

1. Review the prepared release workflow and confirm its trigger matches the
   intended tag policy.
2. Create an annotated tag whose name exactly matches the version:
   `git tag -a v0.2.1 -m "v0.2.1"`. If the GitHub source release already created
   this tag, verify and reuse its unchanged target; do not recreate it.
3. After maintainer approval and credential readiness, push the release commit
   and tag. Ensure the workflow is present on the default branch, then dispatch
   it explicitly on the tag:

   ```bash
   gh workflow run release.yml --ref v0.2.1
   ```
4. Require tests, version-consistency checks, installed graph equality, tarball inspection, and provenance
   generation to pass before the publish step.
5. Wait for that workflow run to finish successfully. Its last step compares
   the public npm name, exact version, `mcpName`, and SHA512 integrity to the
   validated archive. Only 404 propagation responses are retried (six attempts,
   five-second delay, 15-second request timeout); authentication, HTTP errors,
   invalid metadata, and mismatched integrity fail closed. A failed check after
   publish does **not** prove npm publication failed: inspect the exact version
   before doing anything else, and do not rerun npm publication blindly.
6. For the first-publish bootstrap, configure Trusted Publishing and revoke and
   remove the token immediately after success. For later releases, leave
   `NPM_TOKEN` absent so npm authenticates with GitHub OIDC. Verify the trust
   configuration before the next release; do not republish the same version to
   test it.
7. Verify the public artifact independently:

```bash
npm view ftp-deploy-mcp@0.2.1 name version mcpName dist.integrity
npm view ftp-deploy-mcp@0.2.1 dist.tarball
npx -y ftp-deploy-mcp@0.2.1 --version
```

Compare the registry integrity/version with the validated tarball and tag.
Only after these checks pass should the README call `npx` a currently available
installation method.

Create the GitHub release from the same immutable tag and copy the relevant
changelog entry. Do not move or reuse a published tag.

## Publish to the MCP registry

This step remains pending. Publish only after separate npm qualification, including the installed graph. The MCP workflow downloads and qualifies the actual published npm archive again; identity alone is insufficient:

1. Review `server.json` against schema `2025-12-11`; it must agree with the tag,
   source lockfile root/root-package versions, runtime version, npm identifier,
   and `mcpName`.
2. Dispatch the separate workflow on exactly the same tag:

   ```bash
   gh workflow run publish-mcp.yml --ref v0.2.1
   ```

3. The nonprivileged job also qualifies the actual npm download and installed graph. Its
   fresh privileged successor verifies structural metadata, the exact npm
   version, `mcpName` and the qualified integrity **before** MCP authentication, without dependency
   installation, tests or `--runtime`.
4. It verifies the pinned official publisher archive, then runs
   `mcp-publisher login github-oidc` and `mcp-publisher publish`. GitHub OIDC
   proves the `io.github.alebgl77/` namespace; no dedicated MCP secret is used.
   The publisher validates the manifest during publication. The workflow logs
   out afterwards. See the [official GitHub Actions guide](https://modelcontextprotocol.io/registry/github-actions)
   and [registry quickstart](https://modelcontextprotocol.io/registry/quickstart).
5. From a clean environment, find the official registry entry, install it by
   its documented route, start the server, and confirm `--version` plus an MCP
   `ftp_list_servers` call.
6. Check that Glama and MCP Index discovery listings point to the canonical
   repository and released version, but do not treat those third-party pages as
   registry verification.

The workflow pins `mcp-publisher` **v1.8.1**, Linux amd64, SHA256:

```text
a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc
```

On 2026-09-03, the downloaded archive matched the digest returned by the
[official GitHub release API](https://api.github.com/repos/modelcontextprotocol/registry/releases/tags/v1.8.1)
for the [v1.8.1 release](https://github.com/modelcontextprotocol/registry/releases/tag/v1.8.1).
The workflow verifies this SHA256 before extracting or executing the binary;
it never resolves a mutable `latest` URL. This is a pinned digest verification,
not a claim that a Sigstore signature was independently verified. Updating the
tool requires reviewing and re-verifying both the version and digest.

If npm succeeded but MCP publication failed, correct the MCP-specific issue
and rerun only `publish-mcp.yml` on the unchanged tag. Do not attempt to recreate
an existing npm version. The MCP Registry is a preview service; check its live
entry after publishing before making availability claims.

## Rollback and incident response

Before publication, stop the workflow and fix the release commit. If an
unpublished tag was pushed, remove it only after confirming no artifact was
created, then create a corrected tag.

After npm publication, assume the version is immutable:

- stop MCP registry publication if it has not happened;
- deprecate the broken npm version with a precise warning;
- fix forward with a new patch version and a new tag;
- use npm unpublish only for a qualifying emergency and within npm policy, not
  as a normal rollback;
- never overwrite, move, or reuse the published tag/version;
- withdraw or deprecate the MCP registry version if the registry supports it,
  then publish the fixed patch version;
- revoke any bootstrap token, rotate exposed credentials, and preserve logs and
  integrity values for incident review;
- revert README availability claims if users can no longer install a safe
  version.

For a suspected security issue, pause the release and follow
[SECURITY.md](../SECURITY.md).

## Post-release checks

For the source release, verify its archive, checksum, source graph, runtime and
external commit inventory. Perform the following registry checks only after
separate npm/MCP publication has actually succeeded.

- Confirm npm provenance is visible and refers to the expected repository,
  workflow, commit, and tag.
- Confirm source, tarball, GitHub release, npm, server `--version`, and MCP
  registry all report the same version.
- Test source install, exact-version `npx`, and registry installation from
  clean environments.
- Update both README availability notices and add the verified `npx` path.
- Announce only installation paths that were actually tested.
- Monitor private security reports and release failures, and prepare a patch
  rather than altering the published artifact.
