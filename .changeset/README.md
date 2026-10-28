# Changesets

Every ordinary PR adds a new `.changeset/*.md` file. Add it with the change,
before the PR is ready for review. One file per logical change is enough;
commits do not each need a changeset.

Run `pnpm change` interactively, or record a change without prompting:

```sh
pnpm change --bump patch --summary "Fix preview without a custom 404 page." @astro-yandex-cloud/adapter
```

Use `patch` for fixes, `minor` for compatible features, and `major` for breaking
changes. The summary becomes the changelog entry: explain what changes for a
package user. While preparing the initial `0.1.0-beta.1`, the existing intents
are collected at that exact version. Later minor or major bumps can change the
stable target, which requires a separate release-policy decision before running
version preparation. Stable promotion belongs to issue #83.

For tests, CI, internal documentation or refactoring that needs no package
release, record an explicit decision and its reason:

```sh
pnpm change --bump none --summary "Update CI checks; package behavior and published files are unchanged." @astro-yandex-cloud/adapter
```

Use a fresh file. Editing a changeset already on the PR base does not count as
acknowledging the new change. A `none` intent must include an explanation.
Ordinary PRs preserve existing intents, the release ledger, changelog and package
version. Package metadata, dependencies and the lockfile can change alongside a
new intent. Generated release changes belong to the version PR.

Check the committed branch against its PR base:

```sh
pnpm changeset:check --base origin/main
```

For a stacked PR, use its actual base, such as `origin/feat/complete-beta-routing`.
`pnpm change check` validates the intents and versioning configuration; the
repository check additionally requires a new intent in the PR diff. CI runs
both inside the already-required `quality` job. The generated version PR is accepted only when its files match a fresh
`pnpm release:version` run from its base, without branch-name or label bypasses.

Install the optional local pre-push hook with `pnpm hooks:install`. It checks
branch updates against the remote's `main` tracking ref without fetching. Tags,
other non-branch destinations and branch deletions skip the check.
For a stacked branch, set `CHANGESET_BASE` to its actual base when pushing.
If you already use custom hooks, integrate `.githooks/pre-push` into them instead
of replacing your hooks path. CI is the required check even when hooks are absent.

Use `pnpm change status` to preview the release plan. Ordinary PRs leave package
versions, changelogs and `.changeset/ledger.yaml` to version preparation. The
[release procedure](../docs/beta-releases.md) covers version PRs and publication.
