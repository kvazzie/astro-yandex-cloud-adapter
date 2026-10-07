# Release readiness

Use this checklist when preparing or verifying a release of `@astro-yandex-cloud/adapter`. Link evidence beside each completed item. Check an item only when its required implementation, documentation, and verification are complete.

The [beta specification][beta-spec] owns the detailed application behavior, implementation decisions, and testing requirements. This document owns the release checklist and the additional requirements for stable promotion. Keep detailed beta requirements in the issue and reference them here.

## `0.1.0-beta.1`

### Before publication

- [ ] Account for every in-scope requirement in the beta specification with links to its implementation, user documentation, and verification evidence. An implementation ticket being closed is not sufficient evidence.
- [ ] Record passing results for every required check in the specification's Testing Decisions, including supported Astro and Node combinations, local S3 tests, and tests of the exact packed candidate in a clean application. Record the non-blocking `astro@next` result separately.

  For local S3 evidence, use the **Local S3 uploads and updates** CI job and its
  `local-s3-results` artifact. See [the local procedure and coverage](local-s3-testing.md).

  For packed-candidate evidence, use CI's `checked-package` artifact and the
  release job's `publication-candidate` artifact. Both include the exact tarball
  and its SHA-512 validation report. See [the package check](package-check.md).

- [ ] Review the [installation and manual deployment instructions](../packages/adapter/README.md) against the specification's user requirements. Put the beta and unverified-cloud warning before installation, and keep Sharp experimental. Recheck the guide's pending-feature table against #67–#70 and update examples when those implementations and the first beta publication are available.
- [ ] Review the [artifact size report and Astro-owned path limitation](artifact-reports.md). Confirm the documented Yandex limits are current and the output scans permit only the identified upstream metadata.
- [ ] Confirm the public GitHub and npm identities and package links. Record who monitors private vulnerability reports.
- [ ] Record the required branch, workflow, and publication-environment protections. Confirm that version preparation and publication have separate permissions and that publication requires human approval.

  Follow the [maintainer release procedure](beta-releases.md). Publication fails
  until the repository is public, `npm` has required reviewers with administrator
  bypass disabled, and the selected commit has successful push CI.

- [ ] Review the Changesets version pull request and its passing CI results. Confirm version `0.1.0-beta.1`, the `beta` dist-tag, and the maintainer procedures for publication and recovery.

### Publication

- [ ] Approve publication through the protected `npm` environment. Immediately before publishing, validate the exact candidate tarball in the publish job and publish those same bytes under `beta` with provenance.
- [ ] For the first publication, use the temporary granular npm token. Delete it immediately after publication, then configure trusted publishing for the release workflow. Keep human approval for later publications.
- [ ] Record the registry version, dist-tag, provenance, and clean-install verification results. Keep Cloud Functions compatibility marked as unverified until the stable requirements below pass.

### Failed beta recovery

Keep published versions immutable. Deprecate a faulty beta with a reason and publish a corrected beta. Reserve unpublishing for credential exposure or severe security emergencies.

[beta-spec]: https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/1

## Stable `0.1.0`

Stable promotion requires the completed beta checklist and evidence from real Yandex Cloud resources:

- [ ] Deploy the exact packed candidate for both initial Targets.
- [ ] Verify actual Yandex Object Storage website index, error, redirect, object metadata, base-prefix, update, and rollback behavior.
- [ ] Verify the actual Function Artifact under the current `nodejs22` runtime through direct HTTPS invocation and API Gateway payload `0.1`.
- [ ] Exercise the complete bridge conformance matrix: methods, actual paths, single/repeated headers and query values, text/binary bodies, permitted cookies, redirects, empty responses, thrown errors, client address, invocation context, and platform limits.
- [ ] Record the last verified Yandex runtime version without converting its patch version into a permanent package promise.
- [ ] Consume the cloud-tested, framework-neutral Function Runtime Bridge rather than maintaining duplicate translation logic.
- [ ] Deploy the adapter's actual Sharp-capable Function Artifact and prove runtime image transformation before changing Sharp from experimental to supported.
- [ ] Publish stable `0.1.0` under `latest` only after the evidence above is recorded and reviewable.
