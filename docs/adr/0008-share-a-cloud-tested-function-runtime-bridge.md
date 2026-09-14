# Share a cloud-tested function runtime bridge

A future framework-neutral Function Runtime Bridge package owns translation between direct/API Gateway 0.1 Yandex Cloud Functions invocations and Web Standards requests and responses. It contains no Astro-specific build behavior, earns compatibility through real Yandex Cloud deployments, and is consumed by the Bare Adapter so platform translation and its evidence remain concentrated in one place.

Until real-cloud conformance work begins, keep invocation translation together inside the Bare Adapter. Translation is in-process computation and needs no I/O abstraction. Focused translation tests cover edge cases alongside the generated-handler tests described in [ADR 0002](0002-use-astros-build-pipeline-for-runtime-artifacts.md).
