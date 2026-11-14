# Roadmap

The repository is a pnpm monorepo for tightly coupled Yandex
Cloud Astro products. Each product has a distinct responsibility,
while all consumers share the versioned
[_Deployment Manifest_](GLOSSARY.md#deployment-manifest) and
conformance fixtures.

## Now: [_Bare Adapter_](GLOSSARY.md#bare-adapter) beta

Publish `@astro-yandex-cloud/adapter@0.1.0-beta.1` when the
[beta release gate in issue #17](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/17)
is complete.

The _Bare Adapter_ owns
[_Artifact Generation_](GLOSSARY.md#artifact-generation) only.
The current integration candidate implements the remaining
routing contract; review, final candidate CI, protected `main`
landing, publication and credential replacement are still release
gates. See the [routing examples](docs/beta-routing.md) and
[first beta evidence record](docs/releases/0.1.0-beta.1-evidence.md).

The beta covers:

- Correct [_Static-only Build_](GLOSSARY.md#static-only-build)
  and [_Runtime Build_](GLOSSARY.md#runtime-build)
  classification, including Astro-internal and
  integration-injected routes.
- Working Astro Actions through API Gateway payload `0.1`.
- [_Direct Function Invocation_](GLOSSARY.md#direct-function-invocation)
  for stateless user-defined endpoints, including forms with an
  explicit public origin and Astro's origin check preserved.
- [_Target Modifiers_](GLOSSARY.md#target-modifier), including an
  [_API Gateway Modifier_](GLOSSARY.md#api-gateway-modifier) that
  emits a customizable OpenAPI specification template without
  creating a Gateway.
- Optional recursive static 404 pages for Object Storage builds
  with API Gateway, including concrete dynamic scopes.
- One complete native Astro App in a shared
  [_Function Artifact_](GLOSSARY.md#function-artifact), with
  stable route references. Separate functions /
  `functionPerRoute` are deliberately retired; see
  [ADR 0013](docs/adr/0013-retire-separate-functions-and-use-native-astro-app.md)
  before proposing per-route packaging again.
- Working preview for both build classes.
- Non-root base placement.
- Bundle and install [_dependency_](GLOSSARY.md#dependency)
  strategies using Astro's build pipeline.
- A [_deployment_](GLOSSARY.md#deployment)-product-neutral,
  JSON-Schema-validated _Deployment Manifest_ of actual
  artifacts, route requirements, and build provenance.
- _Deployment_-shaped local S3 and packed-consumer conformance
  tests.
- Honest beta documentation and supply-chain-safe publication.

## Stable _Bare Adapter_

Promote to `0.1.0` only after the
[stable cloud gate in issue #83](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/83)
passes for actual Yandex Object Storage and Cloud Functions
resources.

Stable promotion does not require the SST component or GitHub
Action. A manual _deployment_ path can establish the evidence.

## [_Function Runtime Bridge_](GLOSSARY.md#function-runtime-bridge)

The framework-neutral
`@astro-yandex-cloud/function-runtime-bridge` package now lives
in this monorepo. The _Bare Adapter_ consumes it and bundles it
into its output. Independent publication and a separate
repository remain possible later.

Remaining work for the _Function Runtime Bridge_:

- Own the reusable cloud _deployment_ harness and conformance
  matrix.
- Record the last verified Yandex `nodejs22` runtime version.
- Prove direct/API Gateway `0.1` translation in real deployments.
- Keep adapter tests on the same implementation that earns that
  evidence.

The package and local checks exist; real-cloud compatibility is
still unverified. See
[ADR 0008](docs/adr/0008-share-a-cloud-tested-function-runtime-bridge.md).

## Yandex SST Astro component

Create a separately versioned
[_deployment product_](GLOSSARY.md#deployment-product),
tentatively `@astro-yandex-cloud/sst`, when SST-backed
_deployment_ work begins.

The component will:

- Use `@astro-yandex-cloud/adapter` as the sole Astro adapter.
- Consume or run a _Bare Adapter_ build and interpret its
  _Deployment Manifest_.
- Mirror the provider-neutral author experience of
  `sst.aws.Astro` while exposing Yandex-specific capabilities
  explicitly.
- Provision Yandex [_Target_](GLOSSARY.md#target) resources by
  default using public Pulumi/Yandex primitives.
- Keep SST state-backend selection entirely user-owned.
- Accept concrete SST Resource Links through component
  configuration rather than serializing them into the Manifest.
- Respect the build's selected _API Gateway Modifier_ and allow
  users to customize the generated OpenAPI template and Gateway
  resource.
- Expose Function and Object Storage or CDN URLs as Pulumi
  outputs that the application can use in a staged Astro build.
- Return _deployment_ outputs and expose created resources for
  customization.
- Avoid coupling to undocumented SST internal modules and publish
  an SST/Pulumi compatibility matrix.

## GitHub _deployment_ Action

Create a GitHub Action for users of the _Bare Adapter_ who do not
use SST.

The Action will:

- Read the generated _Deployment Manifest_.
- Deploy artifacts to explicitly identified, existing Yandex
  Cloud resources.
- Avoid [_Provisioning_](GLOSSARY.md#provisioning) in its initial
  version.
- Create immutable Cloud Function versions.
- Upload [_Client Artifact_](GLOSSARY.md#client-artifact) objects
  with the required keys and metadata.
- Enumerate _Client Artifact_ files from its declared directory
  rather than expecting a file inventory in the Manifest.
- Avoid destructive object pruning by default.
- Expose _deployment_ outputs and support verification and
  rollback workflows.

## Shared packages

Keep Manifest schema/types/validation in the _Bare Adapter_ until
the SST component or GitHub Action becomes the second real
consumer. Then extract only the proven shared contract into a
small package.

Keep the _Function Runtime Bridge_ separate from the Manifest
package: invocation translation and _deployment_ requirements
change for different reasons.

## _Deployment_ runbook CLI

The planned npx CLI reads only the _Deployment Manifest_ JSON and
emits a Markdown runbook for the completed build. It does not
provision resources or require the generated OpenAPI template as
an input.

## GitHub issue draft: prove Sharp in Yandex Cloud Functions

Create this issue after the public repository exists.

**Suggested title**: Verify and define Sharp support in the
Yandex Cloud _Function Artifact_

### Problem

The adapter currently describes Sharp/runtime image
transformation as limited or experimental, but local bundling and
handler execution cannot prove native compatibility in Yandex
Cloud's `nodejs22` runtime. The support claim needs _deployment_
evidence from the adapter's actual _Function Artifact_.

### Acceptance criteria

- Build a fixture using Astro runtime image transformation and
  the _Function Artifact_ `install` _dependency_ strategy.
- Verify deterministic package metadata and lockfile generation
  for the exact Sharp version.
- Deploy the complete generated _Function Artifact_ to the
  current Yandex `nodejs22` runtime through the shared cloud
  harness.
- Invoke an image transformation through the supported ingress
  and verify status, MIME type, dimensions, content, caching
  behavior, and repeated invocation behavior.
- Record artifact size, _dependency_ installation result,
  cold-start behavior, runtime version, memory, and timeout
  settings.
- Verify failure messages for unsupported architectures,
  _dependency_ installation failure, and packages exceeding
  _deployment_ limits.
- Run the adapter's generated artifact—not a bridge-only fixture
  or a hand-authored function.
- Update adapter feature declarations, tests, and documentation
  to state the exact proven support envelope. The Manifest does
  not carry Sharp support metadata.

### Evidence required

- Link to the cloud conformance run and _deployment_
  configuration.
- Record the Yandex runtime version and Sharp version.
- Preserve representative request/response assertions without
  retaining credentials or cloud resource secrets.
- Keep Sharp experimental if any acceptance criterion cannot be
  reproduced.
