# Astro adapter for Yandex Cloud

Both the Object Storage Target and Object Storage + Cloud Functions Target are beta.
Cloud Functions compatibility has not yet been verified in Yandex Cloud. The supported
application build environment is Astro `^7.1.0` on Node.js `>=22.12.0`.

`@astro-yandex-cloud/adapter` turns Astro builds into deploy-ready Object Storage and
Cloud Functions artifacts. It does not provision cloud resources.

```js
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
});
```

See [`packages/adapter/README.md`](packages/adapter/README.md) for runtime behavior and
deployment limitations.

Project terminology is defined in [`CONTEXT.md`](CONTEXT.md). Architectural decisions
and design constraints live in [`docs/adr`](docs/adr).

See [`docs/release-readiness.md`](docs/release-readiness.md) for beta and stable release
gates, and [`ROADMAP.md`](ROADMAP.md) for planned deployment products and shared packages.
