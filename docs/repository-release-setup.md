# Public repository and release permissions

This is the setup and evidence record for [issue #16][issue]. Account settings
remain maintainer-owned. Merging the repository files does not complete those
settings. Keep #16 open until every completion item below has evidence.

## Public identity

The canonical repository is
[`kvazzie/astro-yandex-cloud-adapter`][repository], matching the current tracker
and package metadata. The `astro-yandex-cloud/adapter` repository named in the
parent specification is not an instruction to transfer or rename this repository.
The maintainer confirmed this identity on 2026-10-05. Public visibility is still
pending.

| Link                          | Value                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Package                       | `@astro-yandex-cloud/adapter`                                                   |
| Repository                    | `git+https://github.com/kvazzie/astro-yandex-cloud-adapter.git`                 |
| Homepage                      | `https://github.com/kvazzie/astro-yandex-cloud-adapter#readme`                  |
| Bug reports                   | `https://github.com/kvazzie/astro-yandex-cloud-adapter/issues`                  |
| Releases                      | `https://github.com/kvazzie/astro-yandex-cloud-adapter/releases`                |
| Private vulnerability reports | `https://github.com/kvazzie/astro-yandex-cloud-adapter/security/advisories/new` |

The repository, homepage, and bug-report fields in
[`packages/adapter/package.json`](../packages/adapter/package.json) already match
this identity. The [release procedure](beta-releases.md) uses the same owner and
repository for trusted publishing and GitHub releases.

## Observed settings

Read-only GitHub API inspection on 2026-10-05 found:

| Requirement                     | Observed state                                                                             | Remaining work                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Public repository               | Canonical identity confirmed; repository is private                                        | Make it public                                                                     |
| npm scope/package permissions   | No authenticated npm account in the agent session                                          | Maintainer confirms permission to create `@astro-yandex-cloud/adapter`             |
| Publication approval            | `npm` exists, with no protection rules and administrator bypass enabled                    | Add a human reviewer and disable administrator bypass                              |
| Publication branch              | `npm.deployment_branch_policy` is `null`                                                   | Permit only the `main` branch, with no tag rules                                   |
| Main protection                 | `main.protected` is `false`; the protection API requires GitHub Pro or a public repository | Apply the review and CI requirements below after making the repository public      |
| Workflow ownership              | No `CODEOWNERS` on the setup PR's base                                                     | Merge the [ownership rules](../.github/CODEOWNERS), then require code-owner review |
| Independent review              | `@kvazzie` is the only collaborator                                                        | Arrange a reviewer with write access for owner-authored PRs                        |
| Private vulnerability reporting | API returned 404 while the repository is private                                           | Name a monitor before enabling and verifying reporting on the public repository    |
| Bootstrap credential            | `npm` has no secrets                                                                       | Create a temporary granular token and store it only as an environment secret       |
| Version preparation             | Actions cannot create or approve pull requests                                             | Enable Actions pull-request creation for the version workflow                      |

On 2026-10-05, the maintainer confirmed that `@kvazzie` will monitor private
vulnerability reports and handle bootstrap-token revocation, environment-secret
deletion, and trusted-publishing setup immediately after first publication.
Reporting still needs to be enabled. Do not add `SECURITY.md`.

## Required settings

### Main and workflow review

In [repository branch settings][branches], protect `main` with:

- Pull requests and at least one approving review.
- Dismissal of stale approvals when the reviewed changes change.
- Required code-owner review. The ownership file covers `.github/`, including
  itself, release scripts, Changesets configuration, package metadata, and
  dependency locks.
- Required status checks and branches up to date before merging. Select GitHub
  Actions as the expected source of each check.
- Protection applied to administrators, with force pushes and deletion disabled.

Use these exact required check names from the release setup in PR #77:

- `quality`
- `Beta release rehearsal`
- `Local S3 uploads and updates`
- `Astro compatibility (Node 22.12 / Astro 7.1)`
- `Astro compatibility (Node 22.15 / latest Astro 7)`
- `Astro compatibility (Node 24 LTS / latest Astro 7)`

Keep `Astro compatibility (Node 24 LTS / Astro next)` non-blocking. The rehearsal
and local S3 jobs are part of the pending PR stack; require them when that stack
reaches `main`. Verify the check names against the merged `ci.yml` and a CI run.

A PR author cannot approve their own PR. With `@kvazzie` as the only code owner,
workflow changes authored by `@kvazzie` need another consenting code owner with
write access. Add that person to the ownership rules before relying on owner
review for owner-authored workflow PRs. Do not bypass review to work around this.

In [Actions settings][actions], retain default read-only workflow permissions and
enable **Allow GitHub Actions to create and approve pull requests**. The version
workflow requests its own Contents and Pull requests write permissions; only the
protected publication job requests OIDC. This repository setting enables the
Changesets version PR, but it does not supply a human review or publication
approval.

### Publication environment

In [environment settings][environments], edit `npm`:

- Require at least one named human reviewer with repository access.
- Disable **Allow administrators to bypass configured protection rules**.
- Use selected deployment branches and tags with exactly one branch rule,
  `main`, and no tag rules.
- Allow the maintainer to approve their manually dispatched release if they are
  the sole deployment reviewer. Independent PR review still happens before the
  version commit reaches `main`.

The release workflow references `environment: npm`; that reference does not
create approval rules. Its publication-policy job checks public visibility,
required reviewers, disabled administrator bypass, and successful push CI.

### npm and vulnerability reporting

Confirm that the maintainer's npm account owns, or has the required publishing
permissions in, the `astro-yandex-cloud` organization. The account must be able
to create the first public `@astro-yandex-cloud/adapter` package. Record the npm
username and the permission evidence, without credentials.

Create a short-lived granular bootstrap token with **Packages and scopes** access
limited to this package or the scope needed to create it. Select **Read and write
(publish and stage)** and enable bypass 2FA for the temporary CI credential.
Organization administration access alone does not grant package publication
permission; leave unrelated organization permissions disabled. Record the token
expiry, never its value.

Store the token as `NPM_BOOTSTRAP_TOKEN` in the protected **npm environment**.
Do not store it as a repository secret, in a local file, or in issue or PR text.
Verify the environment secret's presence through secret metadata only.

After a named monitor accepts responsibility, enable **Private vulnerability
reporting** in [security settings][security]. Verify the reporting API returns
`enabled: true` and record the monitor's GitHub username.

First publication, immediate token revocation, and trusted-publisher configuration
belong to the publication ticket. Follow the [release procedure](beta-releases.md)
and record the person responsible for those follow-up actions here.

For a first-time npm publisher, create a personal npm account, verify its email,
and enable 2FA. Then create the `astro-yandex-cloud` organization using the
**Unlimited public packages** free plan. The organization name defines the npm
scope; the adapter package itself is created by the later first publication.
See [npm's organization guide][npm-organization] and
[granular token instructions][npm-tokens].

## Completion evidence

Replace each pending entry with the responsible person's confirmation, a date,
and an API result or settings link. Do not infer permission from a successful
package build or from the existence of the `npm` environment.

- [ ] Canonical public repository confirmed, public visibility verified, and
      package and release links reviewed. Evidence: pending.
- [ ] npm username and scope/package creation permission recorded. Evidence:
      pending.
- [ ] `main` requires the blocking CI checks, review, and code-owner approval;
      force pushes and deletion are disabled, including for administrators.
      Evidence: pending.
- [ ] Workflow ownership rules are effective on `main`, and an independent
      reviewer is available for owner-authored PRs. Evidence: pending.
- [ ] `npm` requires human approval, disables administrator bypass, and allows
      only the `main` branch. Evidence: pending.
- [ ] Named vulnerability-report monitor has accepted the role and reporting is
      enabled. Evidence: pending.
- [ ] Temporary bootstrap token is available only through the protected `npm`
      environment; its scope and expiration are recorded without its value.
      Evidence: pending.
- [x] Named person has accepted immediate token revocation, environment-secret
      deletion, and trusted-publishing setup after first publication. Evidence:
      `@kvazzie` confirmed this responsibility on 2026-10-05; retain the confirmation
      in the setup PR.
- [ ] Version preparation can create its PR while publication remains separately
      approved. Evidence: pending.

[issue]: https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/16
[repository]: https://github.com/kvazzie/astro-yandex-cloud-adapter
[branches]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/branches
[actions]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/actions
[environments]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/environments
[security]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/security_analysis
[npm-organization]: https://docs.npmjs.com/creating-an-organization
[npm-tokens]: https://docs.npmjs.com/creating-and-viewing-access-tokens
