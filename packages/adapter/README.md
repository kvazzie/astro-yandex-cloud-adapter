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
site contains on-demand routes. `dist/yandex-cloud.json` describes all deployable artifacts.

Upload and provisioning are intentionally outside this package. Configure the Yandex function
with runtime `nodejs22` and entrypoint `index.handler`, then deploy the complete `function`
directory because Astro may emit code-split chunks. `nodejs22` is the Yandex Cloud Function
Artifact runtime identifier. It does not select or promise the Node.js patch version used to
build the application.

## Runtime

The handler translates Yandex HTTPS events to Web Requests. The original invocation is available
as `Astro.locals.runtime`:

```ts
const { event, context } = Astro.locals.runtime;
```

Use `process.env` for secrets. Forwarded host/protocol headers are trusted because they are
expected to be supplied by Yandex's ingress; do not expose the function directly through an
untrusted proxy that rewrites them.

## V1 limitations

- Sharp is the only supported external/native dependency and has limited support. Test image
  transformations in the deployed Node.js 22 runtime.
- Explicit package externals, other native packages, and runtime filesystem assets not discovered
  by Astro/Vite are rejected or unsupported.
- The adapter emits no API Gateway, Terraform, IAM, bucket, CDN, or domain configuration.
