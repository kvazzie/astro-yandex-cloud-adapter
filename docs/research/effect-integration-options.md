# Effect integration options

Research date: 2026-10-12. This note describes the observed, uncommitted working-tree snapshot, including ADR 0003, rather than claiming that snapshot is committed. APIs were checked against installed `effect@3.22.2` and StudioCMS `effectify@0.3.1`. Context7 supplied leads; explicit v3 documentation and installed source determined compatibility. This is research only; production code remains unchanged.

## Keep schema decoding at the boundary

`defineIntegration` calls `Schema.decodeUnknownEither(schema)` on the supplied input, then passes the decoded value to synchronous `setup`. It runs each returned hook through its own `Effect.runPromise`; hook effects must have `R = never`. This matches the installed effectify declarations and implementation. [StudioCMS integration source](https://github.com/withstudiocms/studiocms/blob/main/packages/effectify/src/astro/integration.ts)

The adapter's schema does useful work beyond checking types. It supplies defaults, rejects excess properties, expresses target-dependent combinations, and decodes `directOrigin` from a string to a branded URL. Keep `schema: Options` and the distinction between public `AdapterOptions` input and decoded `Options`. [Adapter options](../../packages/adapter/src/integration/options.ts), [Effect 3.22.2 Schema source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/Schema.ts)

## What Config would change

Effect `Config<A>` describes loading configuration through a `ConfigProvider`; the default provider reads environment variables. It is useful when a program needs configurable external sources. It does not replace dependency injection for a value already decoded from a JavaScript function argument. [Effect v3 configuration](https://effect.website/docs/v3/configuration)

Providers can also read maps and JSON, so Config is not limited to environment variables. Nevertheless, converting these adapter arguments into a provider would add another loading contract. It would not remove the need to make configuration available to services. [Effect 3.22.2 ConfigProvider source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/ConfigProvider.ts)

Version detail matters. Installed v3 has `Schema.Config(name, schema)` for decoding a provider-loaded string, and `Schema.parseJson(Options)` can decode a JSON string. Disposable probes confirmed this combination. Installed v3 has neither `Config.schema` nor `ConfigProvider.fromUnknown`; do not adopt those from v4 examples. [Effect 3.22.2 Schema source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/Schema.ts)

My recommendation is to reserve Config for a future external-input boundary, such as explicitly supported environment settings. Keep the existing programmatic options schema.

## The tag is idiomatic; its consumers deserve another look

`IntegrationOptions` is a Context key for decoded options. `Layer.succeed(IntegrationOptions, options)` constructs the layer supplying that value. Effect's v3 layer guide itself uses a configuration Context tag and `Layer.succeed`. There is no requirement that tagged services own resources or expose methods. [Effect v3 layers](https://effect.website/docs/v3/requirements-management/layers), [Layer.succeed source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/Layer.ts)

The more questionable choice is that `TargetBuildLive` selects a strategy from options, yet every strategy operation can require options again. `ObjectStorageFunctionsBuild` repeatedly narrows the union and can fail because a separately provided option value disagrees with the selected strategy. Normal setup prevents that mismatch, but the service interface allows it. Observed WIP `packages/adapter/src/target/index.ts` and `packages/adapter/src/target/object-storage-functions.ts`.

My preferred design improvement is to capture decoded, target-specific options once during construction. Strategy methods then return `Effect<Result, BuildError>` without `IntegrationOptions` in their requirements. This follows the layer guide's advice to satisfy implementation dependencies during construction. The integration can still keep the options tag for `configSetup`, which uses options directly for the runtime config plugin. [Effect v3 layers](https://effect.website/docs/v3/requirements-management/layers). Observed WIP `packages/adapter/src/integration/hooks.ts`.

This is a design recommendation, not an established repo decision. It conflicts with the current WIP ADR 0003 statement, "constructing a strategy does not capture options." Implementing it requires revising that decision and its service signatures. [ADR 0003](../adr/0003-concentrate-target-policy-in-target-drivers.md)

## Where construction belongs

The entrypoint is a reasonable composition boundary. A nearby `integration/setup.ts` would make this entrypoint easier to scan, but moving the same layer expression does not change semantics. A minimal extraction could retain today's tag and strategy behavior:

```ts
// index.ts
export default defineIntegration<Options, AdapterOptions>({
  name: ADAPTER_NAME,
  schema: Options,
  setup: ({ options }) => createHooks(options),
});

// integration/setup.ts, inside createHooks(options)
const context = Layer.merge(BuildState.Default, TargetBuildLive).pipe(
  Layer.provideMerge(Layer.succeed(IntegrationOptions, options)),
  Layer.build,
  Effect.scoped,
  Effect.runSync,
);
// Return the five existing hooks, each provided with this context.
```

A direct factory can accept schema-narrowed options and capture them. Setup selects that factory and installs its result with `Layer.succeed(TargetBuild, strategy)`. Passing options directly to `createHooks` also covers the runtime config plugin, allowing `IntegrationOptions` to disappear when no consumers remain. This is simpler when options are the constructor's only dependency. I would retain the `TargetBuild` service seam; using `Layer.effect` to consume the options tag at construction is the conventional DI alternative. [Current setup](../../packages/adapter/src/index.ts). Observed WIP `packages/adapter/src/integration/hooks.ts`.

## Preserve the instance lifetime

Build the state once per integration instance. Providing the original layer separately to each hook constructs it repeatedly; layer identity alone does not share instances across independent runs. Disposable probes on 3.22.2 confirmed repeated construction, while providing one prebuilt Context preserved state. [Effect v3 layer memoization](https://effect.website/docs/v3/requirements-management/layer-memoization)

Today's `Layer.build` plus `Effect.scoped` plus `runSync` works because construction is synchronous and resource-free. The scope closes before the Context escapes. A scoped-resource probe confirmed its finalizer ran before return, so this pattern must not later contain services whose resources need to survive across hooks. [Layer.build source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/Layer.ts). Observed WIP `packages/adapter/src/integration/build-state.ts`.

`ManagedRuntime` can share services and provides explicit disposal. It is a less natural fit here because effectify already owns hook execution, and adopting it needs an integration lifetime and failure cleanup policy. Reconsider it when constructors acquire resources or become asynchronous, rather than introducing it for plain options. [Effect 3.22.2 ManagedRuntime source](https://github.com/Effect-TS/effect/blob/effect%403.22.2/packages/effect/src/ManagedRuntime.ts)
