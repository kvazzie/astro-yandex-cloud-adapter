# Public repository and release permissions

This is the setup and evidence record for [issue #16][issue]. Account settings
remain maintainer-owned. Merging the repository files does not complete those
settings. Keep #16 open until every completion item below has evidence.

## Public identity

The canonical repository is
[`kvazzie/astro-yandex-cloud-adapter`][repository], matching the current tracker
and package metadata. The `astro-yandex-cloud/adapter` repository named in the
parent specification is not an instruction to transfer or rename this repository.
The maintainer confirmed this identity on 2026-10-05 and authorized public
visibility on 2026-10-06. The repository is now public.

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

GitHub settings were configured and verified through the API on 2026-10-06.
The npm organization was created by the maintainer and its membership page
verified on the same date:

| Requirement                     | Observed state                                                                                                                         | Remaining work                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Public repository               | `visibility: public`                                                                                                                   | Complete                                                                                           |
| npm scope/package permissions   | `kvazzie` owns `astro-yandex-cloud`; 2FA enabled                                                                                       | Complete                                                                                           |
| Publication approval            | Required reviewer `@kvazzie`; `can_admins_bypass: false`                                                                               | Complete                                                                                           |
| Publication branch              | Exactly one deployment rule, `main`, with type `branch`                                                                                | Complete                                                                                           |
| Main protection                 | One approval, latest-push approval, stale-approval dismissal, strict CI, administrator enforcement; force pushes and deletion disabled | Add the rehearsal and local S3 checks after their workflows reach `main`                           |
| Workflow protection             | Main's required review and checks apply to workflow changes                                                                            | Ownership declarations are included in this PR                                                     |
| Automated review                | CodeRabbit's repository settings have Request Changes Workflow enabled and author approval overrides disabled                          | Verify an approving review after the next completed review; this PR also records the configuration |
| Private vulnerability reporting | `enabled: true`; monitor `@kvazzie` confirmed                                                                                          | Complete                                                                                           |
| Bootstrap credential            | `NPM_BOOTSTRAP_TOKEN` present only in `npm`; expires 2026-10-13                                                                        | Complete                                                                                           |
| Version preparation             | Default workflow permissions `read`; `can_approve_pull_request_reviews: true`                                                          | Complete                                                                                           |

On 2026-10-05, the maintainer confirmed that `@kvazzie` will monitor private
vulnerability reports and handle bootstrap-token revocation, environment-secret
deletion, and trusted-publishing setup immediately after first publication.
Private vulnerability reporting is enabled. No `SECURITY.md` is needed.

## Required settings

### Main and workflow review

In [repository branch settings][branches], protect `main` with:

- Pull requests and at least one approving review.
- Dismissal of stale approvals when the reviewed changes change.
- Approval of the latest push by someone other than its pusher. CodeRabbit can
  supply an approving review when its Request Changes Workflow is enabled.
- Optional code-owner approval for solo maintenance. The ownership file identifies
  the maintainer of `.github/`, review configuration, release scripts, Changesets,
  package metadata, and dependency locks; it does not add a second approval gate.
- Required status checks and branches up to date before merging. Select GitHub
  Actions as the expected source of each check.
- Protection applied to administrators, with force pushes and deletion disabled.

These checks are currently required, with GitHub Actions as their expected source:

- `quality`
- `Astro compatibility (Node 22.12 / Astro 7.1)`
- `Astro compatibility (Node 22.15 / latest Astro 7)`
- `Astro compatibility (Node 24 LTS / latest Astro 7)`

Keep `Astro compatibility (Node 24 LTS / Astro next)` non-blocking. The rehearsal
and local S3 jobs are part of the pending PR stack; require them when that stack
reaches `main`, using the exact names `Beta release rehearsal` and
`Local S3 uploads and updates`. Requiring absent jobs now would block earlier PRs
in the stack. Verify the check names against the merged `ci.yml` and a CI run.

A PR author cannot approve their own PR, but a separate human collaborator is not
required for this repository's ordinary review gate. CodeRabbit can request
changes and submit approval after reviewing the latest commit, resolving its
required threads, and passing its pre-merge checks. Its comments or status check
alone are not approving reviews.

The [CodeRabbit configuration](../.coderabbit.yaml) enables
`reviews.request_changes_workflow` and disables author-triggered approval
overrides with `reviews.allow_author_approval: false`. Inheritance preserves
other existing CodeRabbit settings. These values were also saved in
[CodeRabbit's repository settings][coderabbit-settings] on 2026-10-06, with
inheritance enabled, so existing PRs do not need to wait for this file to merge.
The review workflow switch is on and the author approval switch is off. CodeRabbit
uses the configuration on the feature branch under review. See
[CodeRabbit's workflow][coderabbit] and [YAML configuration][coderabbit-yaml].

Required code-owner approval stays disabled because `@kvazzie` is the sole code
owner and cannot approve their own PR. All main-bound PRs, including workflow and
review-configuration changes, still require an approving review and the required
CI checks. Publication approval remains a separate human decision.

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
  the sole deployment reviewer. Required PR review still happens before the
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

- [x] Canonical public repository confirmed, public visibility verified, and
      package and release links reviewed. Evidence: maintainer confirmation and
      repository API `visibility: public`, verified 2026-10-06.
- [x] npm username and scope/package creation permission recorded. Evidence:
      maintainer confirmed organization creation on 2026-10-06;
      [npm membership settings][npm-members] show `kvazzie` as owner, with 2FA
      enabled. New packages under the scope join the Developers team with
      read/write access. No package has been published.
- [x] `main` requires currently available blocking CI checks and an approving review;
      force pushes and deletion are disabled, including for administrators.
      Evidence: [branch protection settings][branches] and protection API,
      verified 2026-10-06. Add the two pending CI jobs when their workflows land.
- [x] Workflow changes require the same review and CI as other main-bound PRs.
      Evidence: main's protection API, verified 2026-10-06. Code ownership remains
      informational for the solo maintainer.
- [x] CodeRabbit's Request Changes Workflow is enabled and author approval
      overrides are disabled. Evidence: saved repository settings, verified
      2026-10-06, and matching configuration in this PR.
- [ ] An approving CodeRabbit review is verified after a completed review.
      Evidence: pending; npm setup is complete and this PR is ready for review.
- [x] `npm` requires human approval, disables administrator bypass, and allows
      only the `main` branch. Evidence: environment and deployment-branch-policy
      APIs, verified 2026-10-06.
- [x] Named vulnerability-report monitor has accepted the role and reporting is
      enabled. Evidence: `@kvazzie` confirmed; reporting API `enabled: true`,
      verified 2026-10-06.
- [x] Temporary bootstrap token is available only through the protected `npm`
      environment; its scope and expiration are recorded without its value.
      Evidence: maintainer completed the wizard with scope `astro-yandex-cloud`
      and expiry `2026-10-13`. Secret metadata verified on 2026-10-06 shows
      `NPM_BOOTSTRAP_TOKEN` in `npm`, updated at `2026-10-05T22:12:32Z`, and no
      repository-level bootstrap secret. The upload succeeded; a timeout in the
      wizard's subsequent metadata read did not affect storage. No token value
      was read or recorded by the agent.
- [x] Named person has accepted immediate token revocation, environment-secret
      deletion, and trusted-publishing setup after first publication. Evidence:
      `@kvazzie` confirmed this responsibility on 2026-10-05; retain the confirmation
      in the setup PR.
- [x] Version preparation is permitted to create its PR while publication remains
      separately approved. Evidence: Actions workflow-permissions API has default
      `read` permissions and `can_approve_pull_request_reviews: true`; `npm`
      requires `@kvazzie` approval, verified 2026-10-06.

[issue]: https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/16
[repository]: https://github.com/kvazzie/astro-yandex-cloud-adapter
[branches]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/branches
[actions]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/actions
[environments]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/environments
[security]: https://github.com/kvazzie/astro-yandex-cloud-adapter/settings/security_analysis
[npm-organization]: https://docs.npmjs.com/creating-an-organization
[npm-members]: https://www.npmjs.com/settings/astro-yandex-cloud/members
[npm-tokens]: https://docs.npmjs.com/creating-and-viewing-access-tokens
[coderabbit]: https://docs.coderabbit.ai/pr-reviews/request-changes-workflow
[coderabbit-settings]: https://app.coderabbit.ai/repository/1348871130/settings/review/settings
[coderabbit-yaml]: https://docs.coderabbit.ai/getting-started/yaml-configuration
