# Keep Yandex Cloud Astro products in one monorepo

The bare adapter, future SST integration, GitHub deployment Action, and shared packages live in one pnpm monorepo because they are tightly coupled through the deployment manifest, artifact formats, and conformance fixtures. They remain separate publishable products with distinct responsibilities, while repository-level changes can evolve their shared contract atomically.
