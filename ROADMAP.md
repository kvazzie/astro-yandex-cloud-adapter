# Roadmap

The repository is a pnpm monorepo for tightly coupled Yandex Cloud Astro products. Each product has a distinct responsibility, while all consumers share the versioned Deployment Manifest and conformance fixtures.

## Now: Bare Adapter beta

Publish `@astro-yandex-cloud/adapter@0.1.0-beta.1` when the [beta release gate](docs/release-readiness.md#010-beta1) is complete.

The Bare Adapter owns Artifact Generation only. Its immediate priorities are:

- Correct Static-only and Runtime Build classification, including Astro-internal and integration-injected routes.
- Working Astro Actions through API Gateway payload `0.1`.
- Direct Function Invocation for stateless endpoints and form actions.
- Working preview for both build classes.
- Non-root base placement.
- Bundle and install dependency strategies using Astro's build pipeline.
- A provider-neutral, JSON-Schema-validated Deployment Manifest.
- Deployment-shaped local S3 and packed-consumer conformance tests.
- Honest beta documentation and supply-chain-safe publication.

## Stable Bare Adapter

Promote to `0.1.0` only after the [stable cloud gate](docs/release-readiness.md#stable-010) passes for actual Yandex Object Storage and Cloud Functions resources.

Stable promotion does not require the SST component or GitHub Action. A manual deployment path can establish the evidence.

## Function Runtime Bridge

Create a framework-neutral package for translating direct/API Gateway `0.1` Yandex Cloud Functions invocations to Web Standards requests and responses.

The package will:

- Contain no Astro-specific build behavior.
- Own the reusable cloud deployment harness and conformance matrix.
- Record the last verified Yandex `nodejs22` runtime version.
- Be consumed by the Bare Adapter once its contract is proven.
- Allow adapter tests to target the same implementation that earned real-cloud evidence.

Extract this package when work on real Function deployments begins; do not duplicate the current runtime implementation in advance.

## Yandex SST Astro component

Create a separately versioned deployment product, tentatively `@astro-yandex-cloud/sst`, when SST-backed deployment work begins.

The component will:

- Use `@astro-yandex-cloud/adapter` as the sole Astro adapter.
- Consume or run a Bare Adapter build and interpret its Deployment Manifest.
- Mirror the provider-neutral author experience of `sst.aws.Astro` while exposing Yandex-specific capabilities explicitly.
- Provision Yandex Target resources by default using public Pulumi/Yandex primitives.
- Keep SST state-backend selection entirely user-owned.
- Accept concrete SST Resource Links through component configuration rather than serializing them into the Manifest.
- Decide explicitly, from component configuration, whether to provision API Gateway or another routing topology.
- Return deployment outputs and expose created resources for customization.
- Avoid coupling to undocumented SST internal modules and publish an SST/Pulumi compatibility matrix.

## GitHub deployment Action

Create a GitHub Action for users of the Bare Adapter who do not use SST.

The Action will:

- Read the generated Deployment Manifest.
- Deploy artifacts to explicitly identified, existing Yandex Cloud resources.
- Avoid Provisioning in its initial version.
- Create immutable Cloud Function versions.
- Upload Client Artifact objects with the required keys and metadata.
- Avoid destructive object pruning by default.
- Expose deployment outputs and support verification and rollback workflows.

## Shared packages

Keep Manifest schema/types/validation in the Bare Adapter until the SST component or GitHub Action becomes the second real consumer. Then extract only the proven shared contract into a small package.

Keep the Function Runtime Bridge separate from the Manifest package: invocation translation and deployment requirements change for different reasons.

## GitHub issue draft: prove Sharp in Yandex Cloud Functions

Create this issue after the public repository exists.

**Suggested title**: Verify and define Sharp support in the Yandex Cloud Function Artifact

### Problem

The adapter currently describes Sharp/runtime image transformation as limited or experimental, but local bundling and handler execution cannot prove native compatibility in Yandex Cloud's `nodejs22` runtime. The support claim needs deployment evidence from the adapter's actual Function Artifact.

### Acceptance criteria

- Build a fixture using Astro runtime image transformation and the Function Artifact `install` dependency strategy.
- Verify deterministic package metadata and lockfile generation for the exact Sharp version.
- Deploy the complete generated Function Artifact to the current Yandex `nodejs22` runtime through the shared cloud harness.
- Invoke an image transformation through the supported ingress and verify status, MIME type, dimensions, content, caching behavior, and repeated invocation behavior.
- Record artifact size, dependency installation result, cold-start behavior, runtime version, memory, and timeout settings.
- Verify failure messages for unsupported architectures, dependency installation failure, and packages exceeding deployment limits.
- Run the adapter's generated artifact—not a bridge-only fixture or a hand-authored function.
- Update adapter feature declarations, Manifest support metadata, tests, and documentation to state the exact proven support envelope.

### Evidence required

- Link to the cloud conformance run and deployment configuration.
- Record the Yandex runtime version and Sharp version.
- Preserve representative request/response assertions without retaining credentials or cloud resource secrets.
- Keep Sharp experimental if any acceptance criterion cannot be reproduced.
