# `@astro-yandex-cloud/adapter`

Both the Object Storage Target and Object Storage + Cloud Functions Target are beta.
Cloud Functions compatibility has not yet been verified in Yandex Cloud. Use Astro
`^7.1.0` and Node.js `>=22.12.0` to install the adapter and build the application.

Build Astro applications for Yandex Cloud Object Storage, optionally with a Node.js 22
Cloud Function for on-demand routes.

```js
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
});
```

The default target is `object-storage`. It accepts only prerendered routes. The
`object-storage-functions` target emits `dist/client`, and emits `dist/function` when the
site contains on-demand routes. Routes added by integrations and active Astro features such as
server islands and the image endpoint count as on-demand routes. This means an Astro
`output: "static"` project can still require a Function Artifact. `dist/yandex-cloud.json`
describes all deployable artifacts.

## Function Artifact dependencies

`dependencyStrategy` selects one strategy for the whole Function Artifact. It defaults to
`bundle`, which uses Astro's Vite and Rolldown application build pipeline to include ordinary
JavaScript dependencies. Node builtins remain runtime imports. The generated artifact has no
application packages to install and its `package.json` contains no runtime dependencies.

```js
yandexCloud({
  target: "object-storage-functions",
  dependencyStrategy: "bundle",
});
```

Bundle builds reject custom package externals, unresolved runtime package imports, and native
runtime code. Native dependencies such as Sharp require the artifact-wide `install` strategy.

```js
yandexCloud({
  target: "object-storage-functions",
  dependencyStrategy: "install",
});
```

Install builds keep runtime package imports external while application bundling stays in Astro's
Vite and Rolldown pipeline. Finalization writes exact dependency versions to the Function
Artifact `package.json` and a deterministic npm `package-lock.json` (lockfileVersion 3) covering
the unresolved runtime packages found in the build. The same resolved inputs produce
byte-identical metadata and lockfiles with no version ranges. Install the artifact the way Yandex
Cloud does with `npm ci --production`; only `dependencies` are installed. Sharp support through
`install` is experimental. `tsdown` builds this adapter package only; it does not rebuild
application code or Function Artifacts.

## Deployment Manifest

The schema version 1 Deployment Manifest records the selected Target, the application base,
artifact paths, every Client Artifact file, canonical Object Storage keys, and the complete
Prerendered and On-demand Route requirements. Client file entries include their public URL so a
deployment product does not need to reproduce Astro's base or trailing-slash behavior.

Deployment products can validate untrusted manifest data through the package interface:

```js
import { readFile } from "node:fs/promises";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";

const value = JSON.parse(await readFile("dist/yandex-cloud.json", "utf8"));
const manifest = parseDeploymentManifest(value);
```

The JSON Schema is exported as
`@astro-yandex-cloud/adapter/deployment-manifest.schema.json`. Version 1 consumers must ignore
unknown additive fields. A change that removes a field, changes a field's meaning, or tightens an
existing invariant requires a new schema version.

Upload and provisioning are intentionally outside this package. Configure the Yandex function
with runtime `nodejs22` and entrypoint `index.handler`, then deploy the complete `function`
directory because Astro may emit code-split chunks. `nodejs22` is the Yandex Cloud Function
Artifact runtime identifier. It does not select or promise the Node.js patch version used to
build the application.

## Runtime

The handler supports direct HTTPS invocation and API Gateway payload format `0.1`. API Gateway
payload formats `1.0` and `2.0` are not supported. It translates supported events to Web Requests,
and the original invocation is available as `Astro.locals.runtime`:

```ts
const { event, context } = Astro.locals.runtime;
```

The incoming `Host` header sets the request origin with the HTTPS protocol. If `Host` is absent,
the handler uses the origin from Astro's `site` configuration. `X-Forwarded-Host` and
`X-Forwarded-Proto` do not change the origin.

### Astro Actions

Use API Gateway payload format `0.1` for Astro Action RPC calls and form actions. Action requests
run application middleware, can read `Astro.locals`, preserve request cookies, return multiple
`Set-Cookie` headers, and redirect callers.

Direct HTTPS invocation supports stateless form actions that do not require an incoming `Cookie`
or `Authorization` header. This is the only documented direct-invocation Action flow. Use API
Gateway payload format `0.1` for authenticated actions and any other action that needs those
request headers.

Direct Cloud Functions HTTPS invocation strips incoming `Cookie` and `Authorization` headers
before the handler receives the event. Use API Gateway when the application needs those request
headers. Use `process.env` for secrets.

## V1 limitations

- Bundle builds do not support native dependencies, including Sharp. Configure Astro's
  passthrough image service when a Runtime Build does not need image transformation.
- Explicit package externals, unresolved runtime packages, and runtime filesystem assets not
  discovered by Astro/Vite are rejected or unsupported.
- The adapter emits no cache policy, routing topology, SST links, resource handles, credentials,
  deployment commands, provisioning permission, API Gateway, Terraform, IAM, bucket, CDN, or
  domain configuration.
