# Astro adapter for Yandex Cloud

Both the Object Storage Target and Object Storage + Cloud Functions Target are beta.
Cloud Functions compatibility has not yet been verified in Yandex Cloud. The supported
application build environment is Astro `^7.1.0` on Node.js `>=22.12.0`.
Sharp and runtime image transformation remain experimental with `install` and
unsupported with `bundle`.

`@astro-yandex-cloud/adapter` turns Astro builds into deploy-ready Object Storage and
Cloud Functions artifacts. Deployment, Request Routing, and Provisioning remain
user-owned.

Function Artifacts bundle ordinary JavaScript dependencies through Astro's Vite and Rolldown
pipeline by default, so they run without installing application packages.

```js
import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
});
```

Read the [beta installation and manual deployment guide](packages/adapter/README.md)
for installation, configuration, artifacts, Object Storage and Cloud Functions
deployment, verification, updates, and rollback. It also covers Gateway payload
`0.1` and the pending Gateway/direct-invocation features. The package is not yet
published; the guide explains checked-tarball installation and the future `beta`
dist-tag. Cloud procedures are documented but unverified in Yandex Cloud.

Project terminology is defined in [`CONTEXT.md`](CONTEXT.md). Architectural decisions
and design constraints live in [`docs/adr`](docs/adr).

See [`docs/release-readiness.md`](docs/release-readiness.md) for beta and stable release
gates, and [`ROADMAP.md`](ROADMAP.md) for planned deployment products and shared packages.

Run `devenv test` for the [local S3 upload and update checks](docs/local-s3-testing.md).
The CI job retains their logs and JUnit report for release review.

Run `pnpm pack:check` for the [clean application package check](docs/package-check.md).
CI retains the checked tarball and its SHA-512 validation report.
