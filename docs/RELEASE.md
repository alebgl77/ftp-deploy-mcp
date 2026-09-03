# Release Guide

This is the maintainer checklist for the first npm and MCP registry
publication. It intentionally separates repository automation from manual
account, ownership, and registry work.

At the time this guide was written, the npm package and MCP registry entry were
not published. The source is installable, while package and server metadata
remain at 0.1.0 until a release change updates them together.

## Manual prerequisites

Complete these outside the repository before creating a release tag:

- Confirm control of the intended npm package name and maintainer access to the
  npm account or organization.
- Enforce npm two-factor authentication and use a dedicated maintainer account
  with least privilege.
- Configure npm Trusted Publishing for this GitHub repository, its release
  workflow, and any named GitHub environment. Match the workflow filename and
  owner/repository exactly.
- Decide how the **first** npm publish will be bootstrapped. If npm permits the
  trusted-publisher relationship before the package exists, use it. If the
  package must exist first, create a short-lived, granular publish token, store
  it only as the repository secret `NPM_TOKEN`, publish once, then configure
  Trusted Publishing, delete the secret, and revoke the token immediately.
  Never commit or print the token.
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
3. Change the v0.2.0 heading in [CHANGELOG.md](../CHANGELOG.md) from
   `Unreleased` to the release date.
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

Run from a clean checkout of the intended release commit:

```bash
npm ci
npm test
npm pack --dry-run
npm pack
npm publish --dry-run
```

Review the `npm pack --dry-run` file list for:

- `src/`, license, README, and required runtime metadata;
- absence of `ftp-servers.json`, local secrets, test credentials, temporary
  files, and maintainer-only state;
- a correct executable/bin entry and no dependency on unshipped workspace
  files;
- the expected package name and version.

Install the generated `.tgz` in a new temporary directory, not from the working
tree:

```bash
npm init -y
npm install --ignore-scripts /absolute/path/to/ftp-deploy-mcp-0.2.0.tgz
./node_modules/.bin/ftp-deploy-mcp --version
./node_modules/.bin/ftp-deploy-mcp --help
```

On Windows, invoke the generated `.cmd` shim or run the packaged
`src/index.js` with Node. Also connect a disposable MCP client to the installed
tarball and run `ftp_list_servers` plus a dry run against test-only
configuration. Validate the tarball bytes/checksum that will be published.

## Publish npm

1. Review the prepared release workflow and confirm its trigger matches the
   intended tag policy.
2. Create an annotated tag whose name exactly matches the version:
   `git tag -a v0.2.0 -m "v0.2.0"`.
3. Push the release commit and tag according to the workflow's documented
   trigger. If the workflow is manual, select the tagged commit explicitly.
4. Require tests, version-consistency checks, tarball inspection, and provenance
   generation to pass before the publish step.
5. For a trusted publish, verify the workflow did not fall back to a persistent
   `NPM_TOKEN`. For a necessary first-publish bootstrap, revoke and remove the
   token immediately after success, then configure and test Trusted Publishing.
6. Verify the public artifact independently:

```bash
npm view ftp-deploy-mcp@0.2.0 name version dist.integrity
npm view ftp-deploy-mcp@0.2.0 dist.tarball
npx -y ftp-deploy-mcp@0.2.0 --version
```

Compare the registry integrity/version with the validated tarball and tag.
Only after these checks pass should the README call `npx` a currently available
installation method.

Create the GitHub release from the same immutable tag and copy the relevant
changelog entry. Do not move or reuse a published tag.

## Publish to the MCP registry

Publish only after the npm artifact has been independently verified:

1. Revalidate the registry manifest against the official registry schema and
   current publisher tool.
2. Set the exact package name, immutable version, source repository, and launch
   command that were just verified on npm.
3. Authenticate with the manually established publisher identity/namespace.
4. Run the official registry validation, inspect the rendered metadata, then
   perform the publish action.
5. From a clean environment, find the official registry entry, install it by
   its documented route, start the server, and confirm `--version` plus an MCP
   `ftp_list_servers` call.
6. Check that Glama and MCP Index discovery listings point to the canonical
   repository and released version, but do not treat those third-party pages as
   registry verification.

Registry commands and authentication change independently of this repository.
Use the official publisher documentation available at release time instead of
copying an unverified command into this guide.

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
