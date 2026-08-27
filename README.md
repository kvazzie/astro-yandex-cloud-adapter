# Astro adapter for Yandex Cloud

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

Project terminology and module design are documented in [`CONTEXT.md`](CONTEXT.md) and
[`docs/architecture.md`](docs/architecture.md). Architectural decisions live in
[`docs/adr`](docs/adr).

See [`docs/release-readiness.md`](docs/release-readiness.md) for beta and stable release
gates, and [`ROADMAP.md`](ROADMAP.md) for planned deployment products and shared packages.
