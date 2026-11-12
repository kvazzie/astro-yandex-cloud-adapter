# Share a framework-neutral [_Function Runtime Bridge_](../../GLOSSARY.md#function-runtime-bridge)

The _Function Runtime Bridge_ now lives in
`@astro-yandex-cloud/function-runtime-bridge`, a separate package
within the monorepo. This replaces the previous decision to wait
for real-cloud conformance work before extraction. It owns
translation between direct/API Gateway `0.1` Yandex Cloud
Functions invocations and Web Standards requests and responses.
The package has no Astro or workspace-package dependencies.

The [_Bare Adapter_](../../GLOSSARY.md#bare-adapter) owns the
Astro renderer, locals, build configuration, route selection, and
static 404 handling. It supplies its reserved direct request
target parameter to the _Function Runtime Bridge_, so the shared
translator does not prescribe an Astro protocol identifier.

Within the _Bare Adapter_, `.astroHandler.ts` calls the shared
translator and Astro renderer. `Hooks` owns runtime build
configuration and locals type injection. `FunctionArtifact` owns
the generated handler's policy type. Its preparation planner
queues custom 404 copies and handler policies; its mutation
executor applies them, as described in
[ADR 0003](0003-concentrate-target-policy-in-target-drivers.md).
`Scope404` owns the shared static fallback behavior.
`.runtime.ts` retains the adapter's public runtime type exports.
There is no adapter-local copy or module directory named
`FunctionRuntimeBridge`.

Keep the package private and bundle it into the _Bare Adapter_
for now. Its own package manifest, build, and root export allow
later independent publication and repository extraction. That
move, separate release automation, and broader context modeling
are deferred. Translation is in-process computation and needs no
I/O abstraction.

Real Yandex Cloud compatibility is still unverified. The
_Function Runtime Bridge_ will own the cloud harness and
conformance matrix when that work begins. Focused translation
tests exercise its root export alongside the generated-handler
and installed-package checks described in
[ADR 0002](0002-use-astros-build-pipeline-for-runtime-artifacts.md).
