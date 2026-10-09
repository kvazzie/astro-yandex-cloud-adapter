# Prepare and publish beta releases

Version preparation and publication are separate workflows. Neither merging a
feature PR nor merging the Changesets version PR publishes a package.

## Repository setup

Complete these settings before publication. They are maintained outside Git;
the workflow does not create or weaken them.

Use the [repository setup and evidence record](repository-release-setup.md) for
the canonical identity, named maintainers, workflow ownership, and verification
of the live settings. Its pending entries must be completed before closing #16.

- Make `kvazzie/astro-yandex-cloud-adapter` public. npm provenance requires a
  public source repository and public package. The adapter's `repository.url`
  must match this repository.
- Protect `main` with review and the blocking CI jobs: `quality`,
  `Beta release rehearsal`, `Local S3 uploads and updates`, and the three
  non-experimental Astro compatibility jobs. Keep Astro next non-blocking.
  Require one approving review, dismiss stale approvals, and require approval
  of the latest push. CodeRabbit can supply the approval through its Request
  Changes Workflow. Keep code-owner approval optional for solo maintenance;
  `CODEOWNERS` identifies the maintainer of workflow and publication files.
  Disable force pushes, deletion, and administrator bypass.
- In **Settings > Actions > General**, allow GitHub Actions to create pull
  requests. Version preparation uses the default `GITHUB_TOKEN`, without a
  separate long-lived credential. GitHub requires approval to run CI on PRs that
  this token creates or updates. A maintainer with write access must select
  **Approve workflows to run** in the version PR's merge box after each update,
  then wait for all required checks to pass before merging.
- In **Settings > Environments > npm**, add required human reviewers, disable
  administrator bypass, and restrict deployment branches to `main`. Keep these
  protections for every release. A workflow's `environment: npm` alone does not
  configure approval. The publication-policy job refuses publication when the
  reviewer rule is absent or administrator bypass is enabled.

The version policy job has only Contents and Actions read permissions. The
version job has Contents and Pull requests write permissions, with no OIDC
permission. Publication policy has only read permissions. Only the publish job
has `id-token: write`, and that job uses the protected `npm` environment.
Both workflows share the `adapter-release` concurrency group and do not cancel
an in-progress publication. Release actions are pinned to commit SHAs.

## Prepare the first version

The checked-in `0.1.0-beta.0` is an unpublished versioning seed. The beta Changeset
and `.changeset/pre.json` make the next `pnpm release:version` produce
`0.1.0-beta.1`, including all pending package changes in its changelog. Do not
publish the seed. The publish command rejects it.

After this release setup reaches `main`, **Prepare beta version** waits for a
successful **CI** push run on the current `main` commit before creating or
updating `changeset-release/main`. A separate read-only policy job rejects PR or
fork CI, stale commits, and the latest CI attempt when it is unfinished or failed.
The version job checks out that exact commit and checks that `main` still points
to it immediately before running Changesets. It refreshes the pnpm lockfile and
formats the generated files. Review the resulting version PR and its CI,
including the packed candidate, then merge it through the normal review process.

Manual dispatch of **Prepare beta version** also requires `main` and successful
push CI for that exact current commit. If `main` advances while a run is queued,
wait for the newer push CI instead of preparing a version from an older result.
The workflow consumes no CI artifacts and executes no PR or fork source. For
later betas, add a Changeset and let the same workflow prepare the next number.
Keep prerelease mode enabled; exiting it is a separate stable-release decision.

**Beta release rehearsal** runs on PRs and pushes. In its disposable checkout it
runs version preparation, checks the first result is exactly `0.1.0-beta.1`,
checks the lockfile, types, and formatting, and runs `pnpm pack:check`. The
`rehearsed-beta` artifact contains the prepared tarball and its filename,
SHA-256 and SHA-512 identity report.
This job has no publication credentials and only dry-runs npm publication.

## Bootstrap the npm package

Trusted publishing needs an existing npm package, so the first publication uses
a temporary granular token. Confirm ownership of the `@astro-yandex-cloud` scope
and permission to create `@astro-yandex-cloud/adapter` before proceeding.

1. Create a short-lived granular npm token with read/write access limited to
   this package, or the scope permission needed to create it. Enable bypass 2FA
   for this temporary CI token. Do not use a classic token or give it unrelated
   package or organization administration permissions.
2. Store it as `NPM_BOOTSTRAP_TOKEN` in the protected **npm environment**, never
   as a repository secret. Only the approved publish step receives it through
   `NODE_AUTH_TOKEN`.
3. Complete the [release checklist](release-readiness.md) and review the merged
   version commit and passing CI for that exact `main` SHA.
4. Run **Publish beta** with `main` selected. Its policy job requires a public
   repository, the environment's required reviewers, disabled administrator
   bypass, and successful push CI for the selected SHA. Then review the pending
   `npm` deployment and approve it as a required reviewer.
5. The approved job uses Node 24 and npm 11.21.0. It builds the adapter, packs one
   candidate with pnpm, passes that explicit path to the clean-application
   checker, records its filename and SHA-256 and SHA-512 digests, verifies its
   SHA-512 identity again, and passes the same archive to
   `npm publish --ignore-scripts --access public --tag beta --provenance`.
   npm handles publication because its CLI supports trusted-publisher OIDC.
   Installation, version preparation, registry queries, and packing use pnpm.
6. Revoke the bootstrap token in npm immediately after successful publication
   and delete the GitHub environment secret, including after a partially failed
   run that already published. Do this while the separate registry verification
   runs. Do not keep it as fallback authentication.
7. Verify `pnpm view @astro-yandex-cloud/adapter@beta version dist --json`, the
   npm provenance statement, and the clean registry installation. Confirm `beta`
   points to `0.1.0-beta.1` and `latest` does not select this release. Retain the
   run URL, `publication-candidate`, and `registry-verification` artifacts in the
   [first beta evidence record](releases/0.1.0-beta.1-evidence.md). If the earlier
   workflow published or this job fails, rerun `pnpm release:verify` with the
   original publication report and the full source SHA of that approved run,
   as documented in that record.

## Switch to trusted publishing

In the npm package's **Settings > Trusted publishing**, add GitHub Actions with
these exact values:

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Organization/user | `kvazzie`                     |
| Repository        | `astro-yandex-cloud-adapter`  |
| Workflow filename | `release.yml`                 |
| Environment       | `npm`                         |
| Allowed actions   | Direct publish, `npm publish` |

Use the filename alone, including its extension. New trusted publishers may
default to staged publishing; explicitly permit direct `npm publish` for this
workflow. Verify that `NPM_BOOTSTRAP_TOKEN` has been deleted. The empty token
allows npm to use OIDC, with provenance, after environment approval. The workflow
does not grant OIDC permission to version preparation or PR checks.

In npm's **Publishing access**, require 2FA and disallow traditional tokens after
configuring the trusted publisher. Later releases use the same version PR,
manual dispatch, policy check, and human approval. Keep a fresh Changeset for
each correction. Do not edit a published version or reset the beta counter.

A new trusted publisher must complete its first successful publication within
two days or the configuration expires. Record its creation and expiry in the
handoff. If the next reviewed beta is not ready in that window, recreate the
configuration immediately before its protected publication. Do not publish an
unneeded version to validate it or restore the bootstrap token. Configuration
alone does not prove successful OIDC publication. See [npm's expiry rule](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

Record the successful source commit and registry version. To add a GitHub
release after confirming publication, a maintainer can create a prerelease at
that exact commit, with a tag such as `@astro-yandex-cloud/adapter@0.1.0-beta.1`.
The publish job has read-only GitHub contents permission and does not create tags
or releases.

## Recovery

If validation or authentication fails before npm accepts the version, fix the
cause and rerun the workflow on the reviewed commit. Check registry state first.
An existing version makes the publish command stop successfully without changing
dist-tags or republishing. A registry error other than E404 fails the job.
If npm accepted the version but artifact upload or a later step failed, recover
the run evidence and verify the registry; do not try to overwrite the version.
Revoke the bootstrap token whenever the first publication reached npm.

For a faulty published beta, deprecate that exact version with a useful reason:

```sh
pnpm deprecate @astro-yandex-cloud/adapter@0.1.0-beta.1 \
  "Preview fails for this beta. Use 0.1.0-beta.2 or a previously verified beta."
```

Use a maintainer's authenticated npm session with 2FA for recovery operations.
Add a correction Changeset, review and merge the next version PR, and publish the
new beta through the same protected workflow. If necessary, move `beta` back to a
previously verified beta while the correction is prepared:

```sh
pnpm dist-tag add @astro-yandex-cloud/adapter@0.1.0-beta.2 beta
```

Substitute the actual known-good version and verify the resulting tag. If this
was the first beta and no safe version exists, deprecate it and remove the `beta`
tag until the replacement passes. Never move a beta to `latest` as recovery.
Keep published versions immutable. Reserve unpublishing for credential exposure
or severe security emergencies, following npm's policy. For exposure, revoke the
credential first, investigate access, and record the incident.

## References

- [Changesets prereleases](https://github.com/changesets/changesets/blob/main/docs/prereleases.md)
- [Changesets action compatible with Changesets 2](https://github.com/changesets/action/tree/v1.9.0)
- [GitHub workflow trigger tokens](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub workflow completion events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm granular tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [npm deprecation](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions)
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish)
