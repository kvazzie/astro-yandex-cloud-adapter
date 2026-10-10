# Roadmap

The repository is a pnpm monorepo for tightly coupled Yandex Cloud Astro products. Each product has a distinct responsibility, while all consumers share the versioned Deployment Manifest and conformance fixtures.

## Now: Bare Adapter beta

Publish `@astro-yandex-cloud/adapter@0.1.0-beta.1` when the [beta release gate in issue #17](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/17) is complete.

The Bare Adapter owns Artifact Generation only. The current integration candidate
implements the remaining routing contract; review, final candidate CI, protected
`main` landing, publication and credential replacement are still release gates.
See the [routing examples](docs/beta-routing.md) and
[first beta evidence record](docs/releases/0.1.0-beta.1-evidence.md).

The beta covers:

- Correct Static-only and Runtime Build classification, including Astro-internal and integration-injected routes.
- Working Astro Actions through API Gateway payload `0.1`.
- Direct Function Invocation for stateless user-defined endpoints, including forms with an explicit public origin and Astro's origin check preserved.
- Target Modifiers, including an API Gateway Modifier that emits a customizable OpenAPI specification template without creating a Gateway.
- Optional recursive static 404 pages for Object Storage builds with API Gateway, including concrete dynamic scopes.
- Shared or separate Function Artifacts with stable route references.
- Working preview for both build classes.
- Non-root base placement.
- Bundle and install dependency strategies using Astro's build pipeline.
- A deployment-product-neutral, JSON-Schema-validated Deployment Manifest of actual artifacts, route requirements, and build provenance.
- Deployment-shaped local S3 and packed-consumer conformance tests.
- Honest beta documentation and supply-chain-safe publication.

## Stable Bare Adapter

Promote to `0.1.0` only after the [stable cloud gate in issue #83](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/83) passes for actual Yandex Object Storage and Cloud Functions resources.

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
- Respect the build's selected API Gateway Modifier and allow users to customize the generated OpenAPI template and Gateway resource.
- Expose Function and Object Storage or CDN URLs as Pulumi outputs that the application can use in a staged Astro build.
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
- Enumerate Client Artifact files from its declared directory rather than expecting a file inventory in the Manifest.
- Avoid destructive object pruning by default.
- Expose deployment outputs and support verification and rollback workflows.

## Shared packages

Keep Manifest schema/types/validation in the Bare Adapter until the SST component or GitHub Action becomes the second real consumer. Then extract only the proven shared contract into a small package.

Keep the Function Runtime Bridge separate from the Manifest package: invocation translation and deployment requirements change for different reasons.

## Deployment runbook CLI

The planned npx CLI reads only the Deployment Manifest JSON and emits a Markdown runbook for the completed build. It does not provision resources or require the generated OpenAPI template as an input.

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
- Update adapter feature declarations, tests, and documentation to state the exact proven support envelope. The Manifest does not carry Sharp support metadata.

### Evidence required

- Link to the cloud conformance run and deployment configuration.
- Record the Yandex runtime version and Sharp version.
- Preserve representative request/response assertions without retaining credentials or cloud resource secrets.
- Keep Sharp experimental if any acceptance criterion cannot be reproduced.
