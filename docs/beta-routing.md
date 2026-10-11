# Configure beta routing

These examples describe the implemented build contract for the first beta
candidate. They do not publish the package or deploy resources. Local builds,
generated-handler checks and installed-package tests cover these combinations;
real Yandex Cloud conformance remains unverified. Keep Sharp experimental.

## Static pages through Gateway

Both Object Storage Targets accept the API Gateway Modifier. This example emits
only a Client Artifact, a Manifest, and a Gateway template:

```js
// astro.config.mjs
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  base: "/docs",
  output: "static",
  trailingSlash: "always",
  adapter: yandexCloud({
    target: "object-storage",
    apiGateway: true,
    recursive404: true,
  }),
  build: { assetsPrefix: "https://assets.example.com" },
});
```

Use an asset origin you own and configure it for the Manifest's base placement.
The template routes pages and endpoints, including concrete prerendered dynamic
paths. It does not deliver `_astro` assets or arbitrary `public/` files.
`assetsPrefix` affects Astro-generated asset URLs; public-file references need
their own correct URLs or user-owned routing.
Astro's extension/fallback map is also accepted for `assetsPrefix`. The Manifest
preserves that map, so a Deployment Product must account for each configured
asset origin instead of assuming a single bucket URL.

With `trailingSlash: "always"`, a prerendered page's canonical `/docs/about/`
URL maps to its exact Object Storage key. The template does not redirect
`/docs/about` to it. With `"never"`, the canonical spelling has no trailing slash.
With `"ignore"`, both spellings map to the same page. The generated template
keeps `ignoreTrailingSlashes: false` so these choices remain explicit.

`recursive404` requires Gateway. A prerendered `src/pages/404.astro` defines the
root fallback, and `src/pages/help/404.astro` defines `/docs/help`. Dynamic 404
pages need `getStaticPaths`; emitted paths such as `/docs/blog/one/404` define
concrete `/docs/blog/one` scopes. An unknown URL uses the nearest ancestor scope
and returns 404. A direct custom-404 URL also returns 404. An endpoint that
matches and returns 404 keeps its own response; an unmatched `/api/...` URL can
use the page fallback. The build rejects on-demand custom 404 pages and creates
no synthetic custom 404 when none exists.

## Runtime pages with separate Functions

Use Gateway for on-demand pages, Actions, server islands, and active internal
routes. A Runtime Build can emit one shared Function or one per route:

```js
// astro.config.mjs
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  base: "/docs",
  output: "server",
  adapter: yandexCloud({
    target: "object-storage-functions",
    apiGateway: true,
    recursive404: true,
    functions: "separate",
    dependencyStrategy: "bundle",
  }),
  image: { service: passthroughImageService() },
  build: { assetsPrefix: "https://assets.example.com" },
});
```

Prerender custom 404 pages explicitly in a server-output application. The
Manifest lists actual Function Artifacts under `artifacts.functions`, with
stable IDs, portable directories, `nodejs22`, and `index.handler`. Route
references identify which artifact serves each route. Each separate artifact
contains its reachable runtime modules and its own generated package metadata.
With `install`, each has exact dependencies and a deterministic npm lockfile.

Upload each listed Function Artifact to a separate existing Function. The
`dist/function/index.js` dispatcher in a separate-functions build exists only
for local preview and is absent from `artifacts.functions`. It is not a
deployment entrypoint. Static-only Builds have an empty Functions array under
either partition choice.

Page Functions contain rendered custom-404 HTML copies. The corresponding
`routes.notFound[].functionArtifactIds` references identify those Functions.
Referenced browser assets still use the Client Artifact's Object Storage/CDN
delivery. Endpoint-only Functions do not serve arbitrary client files.

The generated Gateway template uses exact static keys and any-method Function
integrations with payload format `0.1`. Astro selects methods and produces the
runtime response. Whole-segment dynamic parameters and optional rest parameters
are supported. Compound segments such as `[id].json` fail with guidance. A
Gateway overlap that would select a different Serving Artifact than Astro also
fails. Prefer a shared Function for overlapping runtime routes, adjust the
routes, or supply a compatible user-owned router. Preserve generated parameter
names because greedy-route names may encode priority over 404 fallbacks.

## Direct stateless endpoints and forms

A build without Gateway may contain stateless user-defined on-demand endpoints
and prerendered pages. Required on-demand pages, Actions, server islands and
active internal routes fail the build with Gateway guidance.

```js
// astro.config.mjs
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  base: "/docs",
  output: "static",
  adapter: yandexCloud({
    target: "object-storage-functions",
    directOrigin: "https://www.example.com",
  }),
  image: { service: passthroughImageService() },
});
```

`directOrigin` must be an HTTP or HTTPS origin without credentials, path, query
or fragment. It is available only for the Functions Target without Gateway.
The runtime requires a matching incoming `Origin` for ordinary form submissions
and rejects missing or untrusted form origins with 403. Astro's
`security.checkOrigin` stays enabled. `site` alone does not authorize forms.

For example, this endpoint processes a stateless form without an Astro Action:

```ts
// src/pages/api/submit.ts
import type { APIRoute } from "astro";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  return Response.json({ message: form.get("message") });
};
```

After building, use the Manifest's reserved parameter to construct the form
action or endpoint URL. Set a provider Function ID for the artifact referenced
by this endpoint, and choose a named version tag:

```js
// direct-url.mjs
import { readFile } from "node:fs/promises";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";

const manifest = parseDeploymentManifest(
  JSON.parse(await readFile("dist/yandex-cloud.json", "utf8")),
);
const parameter = manifest.directInvocation?.requestTargetParameter;
if (!parameter) throw new Error("This build does not support direct invocation.");

const url = new URL("https://functions.yandexcloud.net/YOUR_FUNCTION_ID");
url.searchParams.set("tag", "candidate");
url.searchParams.set(parameter, "/docs/api/submit?item=one&item=two");
console.log(url.href);
```

The current reserved parameter is `__astro_path`. Read it from the Manifest so
the URL matches the installed candidate. Encode the complete original
`path?query` once through `URLSearchParams`, including the Astro base. Provider
parameters such as `tag` remain outside the application query. The runtime
rejects missing, repeated or invalid request targets with 400.

Use the printed URL as the action of an ordinary static `method="post"` form
served from `directOrigin`; escape `&` as `&amp;` when inserting it into literal
HTML. A real browser supplies the form's `Origin`. Do not disable Astro's origin
check. Test the accepted origin and rejection from another origin through the
actual Function URL before directing users to it.

Yandex direct HTTPS invocation filters incoming Cookie and Authorization headers.
These endpoints cannot rely on either header. The adapter does not grant public
invocation permissions, supply sessions, or bypass platform access controls.

## Consume the template in a deployment program

An existing Pulumi or SST program can use the generated OpenAPI file and the
Manifest without adopting a second Astro adapter. Resource creation and the
final Gateway update belong to that program. A dedicated SST component remains
future work.

First inspect the actual variable declarations and their artifact descriptions:

```js
import { readFile } from "node:fs/promises";
const template = JSON.parse(
  await readFile("dist/yandex-api-gateway.json", "utf8"),
);
console.log(template["x-yc-apigateway"].variables);
```

Static routes declare `bucket` and `storage_service_account_id`. Function routes
declare a hashed `function_...` variable and its `_service_account_id` partner
for each artifact; the descriptions identify the Manifest artifact. Bind these
actual names to your program's existing resource outputs. Resolve Pulumi or SST
outputs to strings in your program before calling this consumer:

```js
// gateway-specification.mjs
import { readFile, writeFile } from "node:fs/promises";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";

export async function writeGatewaySpecification(resourceVariables, functionTag) {
  if (!functionTag || functionTag === "$latest") {
    throw new Error("Choose a named Function version tag.");
  }
  const manifestFile = new URL("./dist/yandex-cloud.json", import.meta.url);
  const manifest = parseDeploymentManifest(
    JSON.parse(await readFile(manifestFile, "utf8")),
  );
  if (!manifest.gatewayTemplate)
    throw new Error("Enable apiGateway before building.");
  const templateFile = new URL(manifest.gatewayTemplate.path, manifestFile);
  const template = JSON.parse(await readFile(templateFile, "utf8"));
  const declared = template["x-yc-apigateway"].variables;
  for (const [name, declaration] of Object.entries(declared)) {
    const value = resourceVariables[name];
    if (typeof value !== "string" || !value || value.startsWith("REPLACE_ME_")) {
      throw new Error(`Supply ${name}: ${declaration.description}`);
    }
    declaration.default = value;
  }
  for (const path of Object.values(template.paths)) {
    for (const operation of Object.values(path)) {
      const integration = operation["x-yc-apigateway-integration"];
      if (integration?.type === "cloud_functions") integration.tag = functionTag;
    }
  }
  const result = new URL(
    "./dist/yandex-api-gateway.deployment.json",
    import.meta.url,
  );
  await writeFile(result, `${JSON.stringify(template, null, 2)}\n`);
  return result;
}
```

Pass an object whose keys are the generated variable names and whose values are
your resolved bucket, Function and service-account identifiers. This consumer
fills defaults in a deployment copy and selects a named tag for each Function
integration. It performs no resource operation and adds no Pulumi or SST
dependency to the adapter. Keep the original build template for comparison,
review the copied file, and preserve the complete route map and payload format.

For a Static-only Build, a resolved output map has this shape:

```json
{
  "bucket": "your-existing-bucket",
  "storage_service_account_id": "your-existing-storage-reader-account-id"
}
```

A Runtime Build also needs each actual `function_...` variable and its account
partner. Save the resolved map as `gateway-variables.json`, or pass the same
object directly inside your deployment program. To write the deployment copy
from saved outputs:

```sh
node --input-type=module <<'JS'
import { readFile } from "node:fs/promises";
import { writeGatewaySpecification } from "./gateway-specification.mjs";
const variables = JSON.parse(await readFile("gateway-variables.json", "utf8"));
console.log(await writeGatewaySpecification(variables, "candidate"));
JS
```

The template has invalid resource defaults until filled. Check its final size
against Gateway's 3.5 MB specification limit and requests/responses against the
2.5 MB limit. Yandex permission checks, actual routing precedence, website
semantics and invocation limits still require real-cloud verification. See the
[manual deployment guide](../packages/adapter/README.md) for application-owned
uploads, test Gateway updates and rollback.
