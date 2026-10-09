# `@astro-yandex-cloud/adapter`

Both the Object Storage Target and Object Storage + Cloud Functions Target are
**beta**. Cloud Functions compatibility has **not been verified in real Yandex
Cloud**. Sharp and runtime image transformation remain **experimental** with the
`install` dependency strategy and unsupported with `bundle`.

This Bare Adapter generates artifacts for existing Yandex resources. You own
Deployment, Request Routing, and Provisioning. It does not create a bucket,
Function, Gateway, domain, IAM policy, or other resource, and it does not upload
the build.

The cloud procedures below were checked against primary documentation on
2026-10-05 but have not been executed against Yandex Cloud. Local build, handler,
preview, package, and S3 tests do not establish provider compatibility. Stable
release and supported Sharp claims require the later real-cloud tests in the
[release checklist](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/main/docs/release-readiness.md).

Start with installation and local preview, then deploy only the artifacts your
Manifest lists:

- [Install the beta](#install-the-beta)
- [Choose a Target](#choose-a-target)
- [Build, inspect, and preview](#build-inspect-and-preview)
- [Deploy to Object Storage](#deploy-the-client-artifact-to-object-storage)
- [Deploy to Cloud Functions](#deploy-a-function-artifact-to-cloud-functions)
- [Route through API Gateway](#route-pages-and-endpoints-through-api-gateway)
- [Constrained direct invocation](#constrained-direct-function-invocation)
- [Limitations and support](#limitations-and-support)

## Install the beta

Use Astro `^7.1.0` and Node.js `>=22.12.0` for installation and application builds.
Astro 6 and other Astro major versions are outside the declared peer range. CI
covers Node 22.12, Node 22.15, and Node 24 with Astro 7. The `astro@next` check is
experimental. The Function runtime identifier `nodejs22` does not promise the
Node patch version used to build your application.

As of 2026-10-07, this package is not published to npm. The intended first release
is `0.1.0-beta.1` under `beta`. After publication, run these commands in an
existing Astro application:

```sh
npm view @astro-yandex-cloud/adapter dist-tags --json
npm install --save-exact @astro-yandex-cloud/adapter@beta
```

Check that `beta` resolves to a prerelease, and commit the application's lockfile.
Keep that exact version for rebuilds and rollback. Do not substitute `latest` for
an unavailable beta. These commands follow [npm's dist-tag documentation](https://docs.npmjs.com/cli/commands/npm-dist-tag).

Before publication, download the tarball and `package-check.json` from a passing
CI run's `checked-package` artifact, or run `pnpm install --frozen-lockfile` and
`pnpm pack:check` in a checkout of this repository. Compare the tarball's SHA-512
with the report, then install that exact file in your application:

```sh
# Replace this path with the checked candidate you downloaded or packed.
npm install /absolute/path/to/checked-adapter-candidate.tgz
```

The repository's `0.1.0-beta.0` is an unpublished versioning seed. Version
preparation produces the intended `0.1.0-beta.1`; neither is a stable support claim.
Use the exact filename and version from the downloaded validation report.
See [candidate validation](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/main/docs/package-check.md)
for what the archive check proves. Installing a [local tarball](https://docs.npmjs.com/cli/commands/npm-install)
does not publish a package or deploy an application.

## Choose a Target

| Configuration                        | Application behavior                                | Emitted Serving Artifacts                               |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- |
| `target: "object-storage"`           | Static-only Builds; On-demand Routes fail the build | Client Artifact                                         |
| `target: "object-storage-functions"` | Prerendered and On-demand Routes                    | Client Artifact, plus a Function Artifact when required |

The default is `object-storage`. For a static website, use `astro.config.mjs`:

```js
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  output: "static",
  trailingSlash: "always",
  adapter: yandexCloud({ target: "object-storage" }),
});
```

Use your actual public origin for `site`. `trailingSlash: "always"` fits directory
index hosting. Match your website or router to the emitted URLs and files if you
choose a different `trailingSlash` or `build.format`.

For a Runtime Build, select the Object Storage + Cloud Functions Target:

```js
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  output: "static",
  adapter: yandexCloud({
    target: "object-storage-functions",
    dependencyStrategy: "bundle",
  }),
  image: { service: passthroughImageService() },
});
```

In Astro's default `output: "static"`, a page or endpoint can export
`prerender = false` to execute on demand. With `output: "server"`, routes execute
on demand unless they export `prerender = true`. Integration-injected routes and
active internal routes, including Actions, server islands, and runtime images,
also affect the emitted artifacts. Read [Astro's rendering guide](https://docs.astro.build/en/guides/on-demand-rendering/)
and [image service configuration](https://docs.astro.build/en/guides/images/).

### Modifiers and implementation status

The [Manifest and routing decision](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/63#issuecomment-5900071837)
defines the API Gateway Modifier for both Targets. It prepares page and endpoint
routing without managing the Gateway. Direct invocation is restricted to
stateless user-defined endpoints. Actions, server islands, and on-demand pages
require Gateway. The current handler can process Gateway payload `0.1`, but the
current adapter options are only `target` and `dependencyStrategy`.

The following decision requirements are still pending in this checkout:

| Capability                                                             | Current status                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| API Gateway Modifier and generated OpenAPI template                    | [#67](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/67); current Manifests record `apiGateway: false` and omit `gatewayTemplate` |
| Recursive custom 404 routing and Function fallback copies              | [#68](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/68)                                                                          |
| Direct request-target restoration and explicit public origin for forms | [#69](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/69); current Manifests omit `directInvocation`                               |
| Configurable Function partitioning                                     | [#70](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/70); current Runtime Builds emit one shared Function                         |

Do not add invented modifier options to `astro.config.mjs`. The Gateway and direct
invocation sections explain the agreed contract and identify the metadata needed
to use it. A successful build today does not prove those routing features exist.
Until #67 is implemented, Gateway configuration must be authored and verified by
the user. Until #69 is implemented, the direct endpoint and form procedure below
cannot be used with the current build.

### Function dependencies

`dependencyStrategy` applies to the whole Function Artifact:

- `bundle`, the default, includes ordinary JavaScript dependencies through
  Astro's Vite/Rolldown pipeline. Node builtins remain runtime imports. The
  generated `package.json` has no application dependencies to install. Custom
  package externals, unresolved runtime package imports, and native runtime code
  are rejected.
- `install` leaves runtime packages external and writes exact dependency versions
  and a deterministic npm `package-lock.json`, lockfileVersion 3. Upload both
  files with the source. Yandex runs `npm ci --production`, installing
  `dependencies`, not `devDependencies`. To check installation locally, copy the
  Function Artifact to a disposable directory and run that same command there.

Select `dependencyStrategy: "install"` for native dependencies such as Sharp.
Their native binaries must work in Yandex's runtime, which has not been verified.
The passthrough image service in the example avoids runtime Sharp transformation.
Static image processing happens during the build. Dependency installation follows
[Yandex's Node.js documentation](https://yandex.cloud/en/docs/functions/lang/nodejs/dependencies).

## Build, inspect, and preview

Run these commands in your application:

```sh
npx astro build
npx astro preview
```

Preview serves Prerendered Routes and assets from the Client Artifact. Runtime
requests use the generated Function handler. It preserves Astro `base` and uses
the local HTTP origin, including for same-origin POSTs and Actions. Check a
prerendered page, a browser asset, and each kind of On-demand Route your app uses.
Preview does not reproduce Yandex IAM, website hosting, filtered headers, or
Gateway limits.

With the default `outDir`, a Static-only Build under either Target emits:

```text
dist/
  client/                  prerendered pages, browser assets, and public files
  yandex-cloud.json         Deployment Manifest
```

A Runtime Build additionally emits:

```text
dist/
  function/
    index.js               handler, configured as index.handler in Yandex
    chunks/                code-split application and runtime modules
    package.json           generated Function package metadata
    package-lock.json      present with the install strategy
```

Read paths from the Manifest if you customize `outDir`. Keep every file in a
Function Artifact, including all chunks. Do not upload only `index.js`, or upload
the application's source `package.json` instead of the generated one.

Each build reports local bytes, file count, and the largest file for each emitted
artifact. Warnings do not fail the build. Those totals exclude compression, ZIP
overhead, and dependencies installed later. Measure the final archive and check
ingress limits separately. Adapter-owned metadata uses portable paths, but
Astro-owned runtime metadata and compiled component diagnostics retain absolute
build paths. See [artifact reports and path limitations](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/main/docs/artifact-reports.md).

### Deployment Manifest and packaged schema

`dist/yandex-cloud.json` is a schema-versioned JSON declaration, not an upload
script or authorization to allocate resources. Inspect it before any deployment:

```sh
node --input-type=module <<'JS'
import { readFile } from "node:fs/promises";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";

const manifest = parseDeploymentManifest(
  JSON.parse(await readFile("dist/yandex-cloud.json", "utf8")),
);
console.log(JSON.stringify(manifest, null, 2));
console.log("Packaged schema:", import.meta.resolve(
  "@astro-yandex-cloud/adapter/deployment-manifest.schema.json",
));
JS
```

The package exports its JSON Schema as
`@astro-yandex-cloud/adapter/deployment-manifest.schema.json`. The
[schema source shipped in the package](https://github.com/kvazzie/astro-yandex-cloud-adapter/blob/main/packages/adapter/.generated/deployment-manifest.schema.json)
and the packaged parser define version 1. Reject unknown schema versions. Within
version 1, tolerate unknown additive fields while validating known fields and
artifact references. Breaking changes after first publication require a new
schema version.

- `target` and `modifiers` record build provenance. They do not identify existing
  cloud resources. An `object-storage-functions` Static-only Build has an empty
  `artifacts.functions` array and needs no Function deployment.
- `artifacts.client` and `artifacts.functions[]` identify the actual Serving
  Artifacts by stable ID. Paths are relative to the Manifest directory. Each
  Function entry declares its runtime and entrypoint.
- `routes.prerendered[]` maps page and endpoint URLs to concrete Object Storage
  keys and Client Artifact IDs. `routes.onDemand[]` records Astro patterns, route
  kinds, and Function Artifact IDs. Patterns are routing requirements, not
  filenames or separate Function entrypoints.
- `base` determines Object Storage placement. `assetsPrefix`, when present,
  records the configured generated-asset origin; it does not rewrite arbitrary
  `public/` references.
- `routes.notFound[]` records explicit custom 404 scopes. Recording a scope does
  not make the pending recursive routing implementation available.
- When implemented and selected, `gatewayTemplate.path` locates the generated
  OpenAPI template, and `directInvocation.requestTargetParameter` names the
  reserved parameter for a direct Function URL. Neither is emitted today.

Enumerate all regular files recursively under the Client Artifact, including
hidden files. The Manifest deliberately has no per-file inventory. For each
relative filename, use that filename as the key at `base: "/"`, or prepend the
base without its leading slash plus `/`. Do not prepend the base twice to the
already complete `routes.prerendered[].objectKey` values.

## Deploy the Client Artifact to Object Storage

This procedure applies to both Targets. It is **unverified in Yandex Cloud**.
Have an existing bucket and an existing credentials profile with the required
object permissions. Configure [AWS CLI for Yandex Object Storage](https://yandex.cloud/en/docs/storage/tools/aws-cli)
using a service account's static access key. These commands assume that profile
is selected by your environment. Public website access, a private Gateway reader,
CDN, TLS, and domain setup remain yours.

### Initial upload and website configuration

After inspecting the Manifest, set these values. The example places a build with
`base: "/docs"` under `docs/`; add `base: "/docs"` to your Astro configuration
before building if that is the URL prefix you want. For `base: "/"`, set
`BASE_PREFIX=''`.

```sh
BUCKET='your-existing-bucket'
CLIENT_DIR='dist/client'
BASE_PREFIX='docs/'

aws --endpoint-url https://storage.yandexcloud.net s3 cp \
  "$CLIENT_DIR/" "s3://$BUCKET/$BASE_PREFIX" \
  --recursive --no-follow-symlinks --dryrun
```

Check that the source is the Client Artifact, not all of `dist`, then repeat
without `--dryrun`. Recursive upload enumerates the directory instead of relying
on a page list. For `/docs`, `client/index.html` becomes `docs/index.html`, and
`client/_astro/app.js` becomes `docs/_astro/app.js`. Keep unrelated bucket objects.

AWS CLI guesses MIME types by extension. Verify HTML, JavaScript, CSS, JSON, XML,
SVG, text, and binary objects. Correct a wrong guess by uploading that file with
an explicit Content-Type, for example:

```sh
aws --endpoint-url https://storage.yandexcloud.net s3 cp \
  "$CLIENT_DIR/index.html" "s3://$BUCKET/${BASE_PREFIX}index.html" \
  --content-type 'text/html; charset=utf-8'
```

Use an appropriate binary type, or `application/octet-stream` when unknown.
Review Content-Encoding separately if you introduce precompressed files. Choose
your own Cache-Control policy; the adapter does not set one. See [AWS upload options](https://docs.aws.amazon.com/cli/latest/reference/s3/cp.html).

For direct website hosting, use Object Storage's website endpoint and configure
its index document. The following command is for a dedicated root-base website
with an emitted root `404.html`:

```sh
aws --endpoint-url https://storage.yandexcloud.net s3 website "s3://$BUCKET" \
  --index-document index.html --error-document 404.html
```

The index document is a filename, not `docs/index.html`. For a `/docs` build, keep
`index.html` as the directory index and use the actual error key such as
`docs/404.html` if present. A `/docs` build does not supply the bucket root's index
page. If there is no custom 404 file, omit `--error-document`. If Astro emitted
`404/index.html` or another key, use that actual key instead. Follow
[Yandex's website setup](https://yandex.cloud/en/docs/storage/operations/hosting/setup).

The website endpoint resolves directory indexes and the configured error
document. An S3 object endpoint addresses object keys directly; requesting
`/docs/` there does not imply `docs/index.html`. Explicit Gateway page mappings
also use object keys rather than website rules. Object Storage website settings
provide one bucket-level error document, not recursive Astro 404 scopes.
Redirects, slash normalization, and extensionless URLs require a matching
user-owned hosting or routing configuration.

### Verify the deployed client

Check the object inventory and representative metadata:

```sh
aws --endpoint-url https://storage.yandexcloud.net s3 ls \
  "s3://$BUCKET/$BASE_PREFIX" --recursive
aws --endpoint-url https://storage.yandexcloud.net s3api head-object \
  --bucket "$BUCKET" --key "${BASE_PREFIX}index.html"
```

Set `PUBLIC_URL` to the actual website, CDN, or Gateway URL including the base:

```sh
PUBLIC_URL='https://www.example.com/docs'
curl -i "$PUBLIC_URL/"
curl -i "$PUBLIC_URL/a-known-page/"
curl -i "$PUBLIC_URL/a-missing-page"
```

Use one of your real routes in place of `a-known-page`. Confirm status, body,
Content-Type, slash behavior, and the intended 404 body/status. Load the page in
a browser and check generated assets and `public/` files at their configured
origins. A public URL returning 403 usually needs access-policy investigation;
it does not establish that a custom 404 is working.

### Update and roll back the client

Before rebuilding, save the previous complete `dist` outside `dist`, its
application lockfile, deployed object-key inventory, and hosting configuration.
For example, `mkdir -p releases` then `cp -a dist releases/previous-dist` preserves
the current artifacts when that destination does not already exist. Retain old
hashed assets for pages still in browsers or caches.

Build and preview the new release, inspect its Manifest, then upload new assets
before replacing HTML:

```sh
aws --endpoint-url https://storage.yandexcloud.net s3 cp \
  "$CLIENT_DIR/" "s3://$BUCKET/$BASE_PREFIX" \
  --recursive --no-follow-symlinks --exclude '*.html'
aws --endpoint-url https://storage.yandexcloud.net s3 cp \
  "$CLIENT_DIR/" "s3://$BUCKET/$BASE_PREFIX" \
  --recursive --no-follow-symlinks
```

Do not use `--delete` for a routine update. Updates are not atomic, so
coordinate Client, Function, and routing changes and allow both releases' assets
during the transition. Verify again before retiring old assets.

For rollback, set `CLIENT_DIR` to the saved release's Client Artifact and
`BASE_PREFIX` to its Manifest base. Repeat `s3 cp --recursive` without `--dryrun`
to overwrite the changed files, then restore the previous website/Gateway/CDN
configuration and verify again. Use `cp` rather than timestamp-based `sync` so
older rollback bytes are actually uploaded. New-only page objects can still
answer after rollback; remove only keys identified by comparing the two saved
release inventories. Keep shared assets and unrelated bucket contents. S3
versioning can provide an additional recovery method if you configured it
beforehand; this procedure does not depend on it.

## Deploy a Function Artifact to Cloud Functions

This procedure is **unverified in Yandex Cloud**. Skip it when
`artifacts.functions` is empty. Use an existing Function per emitted Function
Artifact and [an authenticated Yandex CLI profile](https://yandex.cloud/en/docs/cli/quickstart).
The current build emits one shared Function; every On-demand Route references
that artifact. Resource IDs and permissions are supplied by you.

### Package and create a version

Set `FUNCTION_DIR` from the Manifest. Start with a fresh ZIP outside that directory
and put its contents at the archive root:

```sh
FUNCTION_DIR='dist/function'
FUNCTION_ID='your-existing-function-id'

# Run in a subshell; function-release.zip must not already exist.
(cd "$FUNCTION_DIR" && zip -r ../function-release.zip .)
unzip -l dist/function-release.zip
```

The archive must contain root-level `index.js`, `package.json`, every chunk and
other generated file, and `package-lock.json` for `install`. Do not wrap them in
a `function/` directory. Package the original generated source, not a disposable
local dependency-install directory.

Create a version using the Manifest runtime and entrypoint. Memory and timeout
below are example user choices, not inferred requirements:

```sh
yc serverless function version create \
  --function-id "$FUNCTION_ID" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 10s \
  --source-path dist/function-release.zip \
  --environment APP_ENV=beta

yc serverless function version list --function-id "$FUNCTION_ID"
```

Wait for the version to become active. Record its version ID and inspect build
and dependency-installation logs. These flags follow [the current version-create reference](https://yandex.cloud/en/docs/cli/cli-ref/serverless/cli-ref/function/version/create).
Choose runtime service-account permissions only when the application needs them.

Set application runtime configuration through version environment variables and
read it with `process.env`; use [Lockbox-backed secrets](https://yandex.cloud/en/docs/functions/operations/function/lockbox-secret-transmit)
for sensitive values. Set the full required configuration on each new version.
Astro client-visible build variables belong to the build and can be embedded in
the Client Artifact, so they must not contain secrets.

Use a named tag for traffic, not `$latest`. After inspecting the created version,
set a candidate tag and test through an existing test Gateway or the supported
direct procedure once available:

```sh
NEW_VERSION_ID='the-active-version-id'
yc serverless function version set-tag --id "$NEW_VERSION_ID" --tag candidate
```

Creating a version moves `$latest`; a named live tag lets you verify a candidate
without changing the live integration. Save the previous live version ID first.

### Archive and invocation limits

Check [Cloud Functions limits](https://yandex.cloud/en/docs/functions/concepts/limits)
for the selected upload method. The console ZIP limit is 3.5 MB. For packages
sourced from Object Storage, the compressed ZIP limit is 128 MB and the expanded
archive limit is 680 MB. CLI `--source-path` accepts a directory or ZIP, but a
local size report does not prove upload acceptance. For a larger package, upload
the ZIP to your existing private source bucket and replace `--source-path` with
`--package-bucket-name` and `--package-object-name`; follow [Yandex's version upload procedure](https://yandex.cloud/en/docs/functions/operations/function/version-manage).

The invocation request/response JSON limit is 3.5 MB, including event metadata
and base64 expansion of binary bodies. Through Gateway, its smaller 2.5 MB
request/response limit also applies. Check execution time, memory, concurrency,
dependency-installation limits, and folder quotas for your application. None is
proved by a successful build or a non-fatal size warning.

### Verify, update, and roll back the function

Verify through the actual intended HTTPS ingress. `yc serverless function invoke`
uses raw invocation and does not reproduce the normal HTTP event expected by the
handler. Keep HTTP transformation enabled; do not append `integration=raw` to a
Function URL. See [Yandex invocation formats](https://yandex.cloud/en/docs/functions/concepts/function-invoke).

Exercise the routes in `routes.onDemand` through concrete URLs, including dynamic
and rest parameters and non-root `base`. Check GET/POST, repeated query values,
text and binary bodies, redirects, empty responses, and errors. For Gateway
apps, also verify middleware, authenticated flows, incoming cookies, multiple
`Set-Cookie` responses, Actions, and server islands where used. Inspect the
Function logs and confirm the candidate version handled the requests.

For an update, build and package a fresh artifact, create a new version with all
environment settings, then move `candidate` and verify. Upload its Client
Artifact and update the Gateway routes/variables as needed. Promote by moving
the live tag used by your ingress:

```sh
yc serverless function version set-tag --id "$NEW_VERSION_ID" --tag live
```

For rollback, move that same tag back to the saved version:

```sh
PREVIOUS_VERSION_ID='the-saved-live-version-id'
yc serverless function version set-tag --id "$PREVIOUS_VERSION_ID" --tag live
```

Restore the matching Client Artifact and Gateway specification/variables when
they changed. Repeat the HTTPS checks and confirm the version in logs. Preserve
old versions and source archives until the rollback window ends. Tag operations
follow [Yandex's canary-release procedure](https://yandex.cloud/en/docs/functions/tutorials/canary-release).

## Route pages and endpoints through API Gateway

The handler supports **payload format `0.1` only**; formats `1.0` and `2.0` are
outside the beta contract. Gateway is required for Actions, server islands,
on-demand pages, and applications needing incoming Cookie or Authorization
headers. Runtime access to the invocation is available as
`Astro.locals.runtime.event` and `Astro.locals.runtime.context`.

The request origin uses the incoming `Host` over HTTPS, falling back to Astro
`site` when Host is absent. `X-Forwarded-Host` and `X-Forwarded-Proto` do not change
that origin. Verify the actual public host and form origin through your router.

### Template and user-supplied variables

The generated-template workflow is **pending #67**, and its cloud steps are
**unverified**. When a build emits `gatewayTemplate.path`, resolve it relative to
`yandex-cloud.json`, copy that file for deployment customization, and preserve its
complete route map. If the field is absent, this build has no generated template.
Do not deploy the illustrative excerpt below as a complete application router.

The template's declared variables are the source of truth for names. Provide your
existing bucket name, Function IDs mapped to artifact IDs, and service-account
IDs. The invocation account needs `functions.functionInvoker` on the Function;
the storage reader needs permission to read the chosen objects. The following
illustrates the [variable syntax](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/parametrization)
and [Function integration](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/cloud-functions)
for `/docs`:

```yaml
openapi: 3.0.0
info:
  title: Example page and endpoint routing
  version: 1.0.0
x-yc-apigateway:
  variables:
    bucket:
      default: INVALID_BUCKET
    storageAccount:
      default: INVALID_STORAGE_ACCOUNT_ID
    functionId:
      default: INVALID_FUNCTION_ID
    invokeAccount:
      default: INVALID_INVOKE_ACCOUNT_ID
    functionTag:
      default: candidate
paths:
  /docs/:
    get:
      x-yc-apigateway-integration:
        type: object_storage
        bucket: "${var.bucket}"
        object: docs/index.html
        service_account_id: "${var.storageAccount}"
  /docs/api/echo:
    x-yc-apigateway-any-method:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: "${var.functionId}"
        service_account_id: "${var.invokeAccount}"
        tag: "${var.functionTag}"
        payload_format_version: "0.1"
```

Prerendered pages and endpoints use exact URL-to-key mappings from the Manifest,
as in [the Object Storage integration](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/object-storage).
On-demand patterns point to their referenced Function using
`x-yc-apigateway-any-method`, leaving HTTP method handling to Astro. Preserve
parameter/rest matching, route precedence, base, and slash behavior. One shared
Function can handle many routes; do not invent separate handlers for patterns.

After #67, use the complete generated template and its actual variable names.
For an existing test Gateway, the update command has this shape:

```sh
GATEWAY_ID='your-existing-test-gateway-id'
GATEWAY_SPEC='your-customized-generated-template.yaml'
yc serverless api-gateway update --id "$GATEWAY_ID" --spec "$GATEWAY_SPEC" \
  --variables "bucket=$BUCKET,storageAccount=$STORAGE_ACCOUNT_ID,functionId=$FUNCTION_ID,invokeAccount=$INVOKE_ACCOUNT_ID,functionTag=candidate"
```

Set `STORAGE_ACCOUNT_ID` and `INVOKE_ACCOUNT_ID` to existing authorized accounts.
Adapt the assignments to the generated variable declarations. This is a
user-run update, following [the CLI reference](https://yandex.cloud/en/docs/cli/cli-ref/serverless/cli-ref/api-gateway/update),
not a resource operation performed by the adapter.

### Asset URLs, 404s, and Gateway limits

The template covers pages and endpoints, not asset delivery. Set Astro
`build.assetsPrefix` to your actual direct Object Storage/CDN asset origin before
building, and verify the generated URLs. Account for the base prefix in that
origin's object placement. This setting affects Astro-generated asset URLs,
not arbitrary `public/` references. Root-relative `/robots.txt`, public images,
and other well-known paths need your own URLs or routing arrangement. See
[Astro's assetsPrefix reference](https://docs.astro.build/en/reference/configuration-reference/#buildassetsprefix).

The recursive 404 option is **pending #68** and applies only to Object Storage
Targets with Gateway. Under the agreed contract, explicit static nested 404
pages define scopes. Unknown URLs use the nearest ancestor scope and return
404; a direct request to a nested 404 also returns 404. Matched endpoints keep
their own response, including a 404 body. An unmatched `/api/...` URL still uses
the nearest page fallback. Object Storage + Functions custom 404 pages must be
static, with required fallback assets copied into the Function Artifact. Without
an explicit custom 404, the service or Astro uses its normal fallback. Do not
expect that recursive behavior from today's recorded scopes alone.

Gateway's specification limit is **3.5 MB**, and its request/response limit is
**2.5 MB**. Check the customized template size and real payloads, including
binary encoding overhead. See [Gateway limits](https://yandex.cloud/en/docs/api-gateway/concepts/limits).

Save the previous deployed specification and all variable values before an
update. Verify exact pages, runtime endpoints, internal routes, missing pages,
and direct asset URLs through the test Gateway before changing live routing.
For rollback, restore the prior specification and variables with the same update
command, along with the matching Function live tag and Client Artifact.

## Constrained direct Function invocation

This workflow is **pending #69 and unverified in Yandex Cloud**. It supports only
stateless user-defined endpoints, including ordinary static forms posting to
those endpoints. **Astro Actions, server islands, and on-demand pages require
Gateway**, including stateless Astro Actions. Do not rely on the current build
rejecting every incompatible direct-mode application before #69 lands.

Yandex direct HTTPS invocation removes incoming **Cookie and Authorization**
headers before the application receives the event. Platform-level authorization
does not make that Authorization header visible to Astro. Arrange invocation
permissions on your existing Function according to your intended public or
private access; the adapter grants none. See [header filtering](https://yandex.cloud/en/docs/functions/concepts/function-invoke#filter).

When implemented, read the reserved parameter name from
`directInvocation.requestTargetParameter`, not from a guessed constant. Encode
the entire original `path?query` once as its value on the provider Function URL.
Include the Astro base in that path. A separate provider `tag` selects a version:

```js
// Contract example for a build that actually emits directInvocation metadata.
import { readFile } from "node:fs/promises";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";

const manifest = parseDeploymentManifest(
  JSON.parse(await readFile("dist/yandex-cloud.json", "utf8")),
);
const parameter = manifest.directInvocation?.requestTargetParameter;
if (!parameter) throw new Error("This build has no direct invocation support.");

const url = new URL("https://functions.yandexcloud.net/YOUR_FUNCTION_ID");
url.searchParams.set("tag", "candidate");
url.searchParams.set(parameter, "/docs/api/echo?message=hello&item=1&item=2");
console.log(url.href);
```

`URLSearchParams` performs the outer encoding; do not pre-encode its input. Keep
the reserved parameter for routing rather than application data. Appending
`/docs/api/echo` to the provider Function URL does not replace this mechanism.

Static form submissions require an **explicitly configured public origin** for
the direct invocation feature. The runtime must verify the incoming `Origin`
against it before constructing the URL Astro sees. Keep `security.checkOrigin`
enabled; do not disable it to work around a cross-origin form. Astro `site` alone
is not the pending validated-origin implementation. #69 will supply the actual
configuration option; none exists in today's `AdapterOptions`.

Once that feature is available, use the generated URL as an ordinary static
form's action and verify a real browser POST from the configured origin. Also
test rejection from a different origin, path/query restoration, repeated values,
text/binary responses, and the absence of incoming Cookie and Authorization.
This is a stateless endpoint form, not an Astro Action. Select a named version
tag and use the Function update/rollback procedure above.

## Limitations and support

- Runtime filesystem assets not discovered by Astro/Vite need application-owned
  packaging and verification. A Function does not become a general static-file
  server for the Client Artifact.
- Bundle builds cannot run native dependencies. `install` does not establish
  Sharp compatibility, even if a local native install succeeds.
- Multi-domain i18n is unsupported. Serverless Containers are not an implemented
  Target in this package.
- The adapter supplies no cache policy, resource handles, credentials, IAM
  configuration, deployment commands, or permission to allocate resources.
- Real Object Storage website behavior and the Function Runtime Bridge's cloud
  conformance remain release gates. No stable or supported Sharp claim follows
  from these instructions.

Use [this repository's GitHub Issues](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues)
for support. Include adapter, Astro, and build Node versions, Target, dependency
strategy, Manifest, and a minimal reproduction. Remove credentials and private
application data before sharing logs or configuration. There is no response-time
commitment.
