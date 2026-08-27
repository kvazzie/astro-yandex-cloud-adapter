# Release readiness

This document defines the evidence required to publish `@astro-yandex-cloud/adapter`. A checked box means the requirement is implemented, documented, and verified by the named evidence—not merely planned.

## `0.1.0-beta.1`

### Release identity and claims

- [ ] Set the package version to `0.1.0-beta.1` and publish it under the npm `beta` dist-tag, not `latest`.
- [ ] Create the public `astro-yandex-cloud/adapter` GitHub repository and the public `@astro-yandex-cloud/adapter` npm package identity.
- [ ] Present both Object Storage Target and Object Storage + Cloud Functions Target as beta capabilities.
- [ ] Label Cloud Functions runtime compatibility as unverified until the stable-release cloud gate passes.
- [ ] Require Astro `^7.1.0` and Node `>=22.12.0`; remove the Astro 6 compatibility promise.

### Supported application behavior

- [ ] Static-only Builds emit a complete Client Artifact for the Object Storage Target.
- [ ] Runtime Builds emit a complete Client Artifact and Function Artifact for the Object Storage + Cloud Functions Target.
- [ ] `output: "static"` projects containing an On-demand Route are classified as Runtime Builds.
- [ ] Astro Actions work through API Gateway payload format `0.1`.
- [ ] Direct Function Invocation works for stateless endpoints and form actions that do not require `Cookie` or `Authorization` request headers.
- [ ] Prerendered, dynamic, parameter, spread, Astro-internal, and integration-injected routes are represented and executable.
- [ ] Server islands, middleware, endpoints, redirects, thrown errors, binary bodies, repeated query values, repeated headers, and response cookies are covered.
- [ ] Non-root Astro `base` values produce deployment requirements that preserve page and asset URLs.
- [ ] `astro preview` works for Static-only and Runtime Builds.
- [ ] Unsupported Astro features or configurations fail during the build with actionable messages instead of producing incomplete artifacts.

### Function runtime contract

- [ ] Accept direct Yandex Cloud Functions HTTPS invocation events.
- [ ] Accept API Gateway payload format `0.1`, including its actual request-path field.
- [ ] Do not claim API Gateway payload formats `1.0` or `2.0` until separately implemented and tested.
- [ ] Construct request origins from the documented `Host` header using HTTPS, with configured Astro `site` only as fallback.
- [ ] Do not trust forwarded origin headers without a future explicit trust option backed by ingress evidence.
- [ ] Match the documented Node.js invocation-context shape, including token, folder, payload, request, and timing fields.
- [ ] Emit `nodejs22` and `index.handler` as the Function Artifact runtime and entrypoint requirements without promising a fixed Node patch version.

### Dependency strategies

- [ ] Default to `bundle`, using Astro's Vite/Rolldown build pipeline without installing a second application bundler.
- [ ] Provide opt-in `install` behavior that emits exact dependency metadata and a deterministic lockfile.
- [ ] Require `install` for native runtime dependencies.
- [ ] Bundle ordinary JavaScript dependencies and allow Node builtins.
- [ ] Reject unresolved runtime packages outside the selected dependency strategy.
- [ ] Mark Sharp and runtime image transformation experimental until the stable cloud gate proves the actual Function Artifact.

### Deployment Manifest schema v1

- [ ] Publish a JSON Schema for schema version 1 and validate every generated Manifest against it.
- [ ] Treat the Manifest as a provider-neutral public contract rather than diagnostic output or an allocation script.
- [ ] Emit only requirements and statements inferred from application source, Astro configuration, and completed Artifact Generation.
- [ ] Describe Target, artifact paths, runtime requirements, complete route requirements, canonical Object Storage keys, and required base placement.
- [ ] Do not invent cache policy, routing topology, SST links, cloud resource handles, or permission to provision resources.
- [ ] Require consumers to reject unknown schema versions, ignore unknown fields within a known version, and validate all known fields and invariants.
- [ ] Require a new schema version for breaking fields or invariants.

### Affordable conformance evidence

- [ ] Run typechecking, ESLint, formatting, unit tests, integration tests, and the adapter build.
- [ ] Test Node 22.12 with Astro 7.1 exactly.
- [ ] Test Node 22.15 with the latest Astro 7, including generated-handler execution.
- [ ] Test Node 24 LTS with the latest Astro 7.
- [ ] Run `astro@next` as a non-blocking compatibility signal.
- [ ] Cover Static-only, Runtime Build, Astro Actions, server islands, injected routes, non-root base, unsupported builds, and both preview paths with fixtures.
- [ ] Cover direct HTTPS and API Gateway `0.1` event translation.
- [ ] Validate Client Artifact placement, object keys, prefixes, MIME metadata, and update behavior against a local S3-compatible implementation.
- [ ] Pack the exact candidate, extract or install it in a clean consumer, and run type resolution, build, generated handler, and preview checks against the packed files.
- [ ] Verify that the Deployment Manifest and adapter-owned artifact output contain no user-specific absolute build paths.
- [ ] Emit a non-fatal artifact-size report with relevant Yandex limits; leave enforcement of final archive and ingress limits to Deployment Products.

### User documentation

- [ ] Put the beta and unverified-cloud warning before the installation example.
- [ ] Document supported Astro and Node ranges, Targets, application behavior, dependency strategies, artifact layouts, and every known limitation.
- [ ] Document Direct Function Invocation limitations and API Gateway payload `0.1` compatibility.
- [ ] Document the Deployment Manifest and link its JSON Schema.
- [ ] Provide one copy-paste Object Storage deployment path covering upload, object metadata, base placement, website index/error behavior, verification, update, and rollback.
- [ ] Provide one copy-paste Cloud Functions deployment path covering source upload, runtime, entrypoint, dependencies, limits, environment variables, invocation, verification, update, and rollback.
- [ ] Explain that Request Routing is user-owned and provide a tested API Gateway `0.1` example without generating or deploying router configuration.
- [ ] State that GitHub issues are the support channel without a response-time commitment.

### Publication safety

- [ ] Use pnpm for workspace, build, test, pack, versioning, and publication operations wherever it supports the required behavior.
- [ ] Add a Changeset for the beta and require its version pull request to pass blocking CI.
- [ ] Upgrade the release runner to a Node version supported by npm trusted publishing.
- [ ] Give the Changesets version job the required `contents` and `pull-requests` permissions without OIDC publication authority.
- [ ] Give the publish job `id-token: write` only inside a protected, human-approved `npm` environment.
- [ ] Pin third-party release actions to immutable commit SHAs and add workflow concurrency.
- [ ] Validate the exact tarball in the privileged publish path immediately before publication.
- [ ] Bootstrap the first package publication from the protected GitHub environment using a temporary granular npm token with provenance enabled.
- [ ] Delete the bootstrap token immediately, configure npm trusted publishing for `release.yml`, and require human approval for subsequent publications.
- [ ] Enable and monitor GitHub private vulnerability reporting; do not add an unmonitored `SECURITY.md`.
- [ ] Protect `main`, require blocking checks and review, prevent force pushes/deletion, and protect workflow changes.
- [ ] Document release, rollback, token-bootstrap, trusted-publisher, and recovery procedures for maintainers.

### Failed beta recovery

- [ ] Never overwrite a published version.
- [ ] Deprecate a faulty beta with a reason and publish a corrected beta.
- [ ] Reserve unpublishing for credential exposure or severe security emergencies.

## Stable `0.1.0`

Stable promotion requires every beta gate plus evidence from real Yandex Cloud resources:

- [ ] Deploy the exact packed candidate for both initial Targets.
- [ ] Verify actual Yandex Object Storage website index, error, redirect, object metadata, base-prefix, update, and rollback behavior.
- [ ] Verify the actual Function Artifact under the current `nodejs22` runtime through direct HTTPS invocation and API Gateway payload `0.1`.
- [ ] Exercise the complete bridge conformance matrix: methods, actual paths, single/repeated headers and query values, text/binary bodies, permitted cookies, redirects, empty responses, thrown errors, client address, invocation context, and platform limits.
- [ ] Record the last verified Yandex runtime version without converting its patch version into a permanent package promise.
- [ ] Consume the cloud-tested, framework-neutral Function Runtime Bridge rather than maintaining duplicate translation logic.
- [ ] Deploy the adapter's actual Sharp-capable Function Artifact and prove runtime image transformation before changing Sharp from experimental to supported.
- [ ] Publish stable `0.1.0` under `latest` only after the evidence above is recorded and reviewable.
