# Release Guide

This is the maintainer checklist for the first npm and MCP registry
publication. It intentionally separates repository automation from manual
account, ownership, and registry work.

This guide prepares v0.2.0; it is not evidence of publication. Both workflows
are manual (`workflow_dispatch`). Pushing a tag alone publishes nothing.

## Manual prerequisites

Complete these outside the repository before creating a release tag:

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

Record who completed each manual prerequisite and when. Do not create the tag
while any ownership or credential step is unresolved.

## Version and changelog gate

For a v0.2.0 release:

1. Set `version` in [package.json](../package.json) and its lockfile to `0.2.0`.
2. Set the MCP server's reported version to the same value. Search the source
   and generated metadata for stale `0.1.0` strings; expected historical
   references in the changelog are exempt.
3. At final release approval, replace the v0.2.0 `Release candidate` status in
   [CHANGELOG.md](../CHANGELOG.md) with the effective publication date. While
   publication is pending, preserve the candidate status.
4. Confirm every user-visible v0.2 change is documented in both
   [README.md](../README.md) and [README.fr.md](../README.fr.md).
5. Verify the release includes atomic replacement for newly written sensitive
   configuration and tests its failure path. This is a release gate, not a
   documentation-only claim.
6. Confirm `node src/index.js --version`, package metadata, lockfile, tag, npm
   version, and MCP registry version will all agree.

Use a dedicated release commit. Do not tag a commit whose package or server
still reports 0.1.0.

## Validate the exact tarball

Run from a clean checkout of the intended release commit (Bash):

```bash
npm ci --ignore-scripts
npm test
node --test test/release-gates.js
export GITHUB_REF=refs/tags/v0.2.0
node scripts/release-gate.mjs --runtime
release_tmp="$(mktemp -d)"
npm pack --ignore-scripts --json --pack-destination "$release_tmp" > "$release_tmp/release-pack.json"
node scripts/release-artifact.mjs inspect "$release_tmp/release-pack.json"
npm install --prefix "$release_tmp/smoke" --ignore-scripts --omit=dev --no-audit --no-fund "$release_tmp/ftp-deploy-mcp-0.2.0.tgz"
node scripts/release-smoke.mjs "$release_tmp/smoke"
node scripts/release-artifact.mjs check "$release_tmp/release-pack.json.verified.json"
```

The local `GITHUB_REF` above simulates the metadata check; it does not create a
tag or authorize publication. The workflow receives its real ref from GitHub.
The archive check requires the exact allowlist in
`scripts/release-artifact.mjs`, including:

- `src/`, license, README, and required runtime metadata;
- absence of `ftp-servers.json`, local secrets, test credentials, temporary
  files, and maintainer-only state;
- a correct executable/bin entry and no dependency on unshipped workspace
  files;
- the expected package name and version.

The smoke script uses only the isolated installation for the server and MCP
client dependencies. It checks `--version`, `--help`, MCP initialize/version,
`ftp_list_servers`, and `ftp_deploy` with `dry_run: true` against test-only
configuration. It makes no FTP/SFTP connection. On Windows the scripts work
with PowerShell-created temporary directories too; use native environment
assignment and output handling instead of the Bash syntax above.

The npm workflow packs once, validates archive entries and SHA512, tests that
archive, rechecks its bytes, and publishes that same `.tgz` with `--provenance`
and lifecycle scripts disabled. No npm token is passed to install, tests, pack,
or verification. Review allowlist changes explicitly when adding shipped files.

## Publish npm

1. Review the prepared release workflow and confirm its trigger matches the
   intended tag policy.
2. Create an annotated tag whose name exactly matches the version:
   `git tag -a v0.2.0 -m "v0.2.0"`.
3. After maintainer approval and credential readiness, push the release commit
   and tag. Ensure the workflow is present on the default branch, then dispatch
   it explicitly on the tag:

   ```bash
   gh workflow run release.yml --ref v0.2.0
   ```
4. Require tests, version-consistency checks, tarball inspection, and provenance
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
npm view ftp-deploy-mcp@0.2.0 name version mcpName dist.integrity
npm view ftp-deploy-mcp@0.2.0 dist.tarball
npx -y ftp-deploy-mcp@0.2.0 --version
```

Compare the registry integrity/version with the validated tarball and tag.
Only after these checks pass should the README call `npx` a currently available
installation method.

Create the GitHub release from the same immutable tag and copy the relevant
changelog entry. Do not move or reuse a published tag.

## Publish to the MCP registry

Publish only after the npm workflow and its artifact checks have succeeded:

1. Review `server.json` against schema `2025-12-11`; it must agree with the tag,
   both lockfile versions, runtime version, npm identifier, and `mcpName`.
2. Dispatch the separate workflow on exactly the same tag:

   ```bash
   gh workflow run publish-mcp.yml --ref v0.2.0
   ```

3. This workflow reruns the metadata/runtime gates and verifies the exact npm
   version and `mcpName` from the public registry **before** MCP authentication.
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
