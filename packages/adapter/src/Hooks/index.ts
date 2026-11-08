/**
 * @file Stateful service implementing Astro integration Hooks.
 * Hooks is a service rather than a namespace because each
 * instance owns mutable build state. Its configuration and
 * resolved routes are shared by lifecycle callbacks and isolated
 * from other integration instances.
 * @see [Hook](../../../../GLOSSARY.md#hook)
 */

import type {
	AstroConfig,
	HookParameters,
	IntegrationResolvedRoute,
} from "astro";
import * as Effect from "effect/Effect";
import { EffectifyIntegrationHookError } from "effectify/astro/integration";

import { reportArtifactSizes } from "../mandatory/ArtifactGeneration/.sizeReport.ts";
import { injectedRuntimeTypes } from "./.injectedTypes.ts";
import { runtimeConfigPlugin } from "./.runtimeConfig.ts";
import { TargetBuild } from "../TargetBuild";
import * as Options from "../Options";

type BuildState = {
	config: AstroConfig | undefined;
	routes: readonly IntegrationResolvedRoute[];
};

function hookError(
	hook:
		| "astro:config:setup"
		| "astro:config:done"
		| "astro:build:done",
) {
	return (error: Error) =>
		new EffectifyIntegrationHookError({
			hook,
			message: error.message,
			cause: error,
		});
}

export default class Hooks extends Effect.Service<Hooks>()(
	"@astro-yandex-cloud/adapter/Hooks",
	{
		effect: Effect.gen(function* () {
			const strategy = yield* TargetBuild;
			const options = yield* Options.Tag;
			const state: BuildState = {
				config: undefined,
				routes: [],
			};

			return {
				configSetup: ({
					config,
					updateConfig,
				}: HookParameters<"astro:config:setup">) =>
					Effect.gen(function* () {
						state.config = undefined;
						state.routes = [];
						const patch =
							yield* strategy.astroBuildConfig(config);
						updateConfig({
							...patch,
							vite: {
								plugins: [
									runtimeConfigPlugin(config.site, options),
								],
							},
						});
					}).pipe(
						Effect.mapError(hookError("astro:config:setup")),
					),
				routesResolved: ({
					routes,
				}: HookParameters<"astro:routes:resolved">) =>
					Effect.gen(function* () {
						state.routes = routes.filter(
							(route) =>
								route.type === "page" ||
								route.type === "endpoint",
						);
					}),
				configDone: ({
					config,
					injectTypes,
					setAdapter,
				}: HookParameters<"astro:config:done">) =>
					Effect.gen(function* () {
						state.config = config;
						const adapter = yield* strategy.astroAdapter(
							state.routes,
						);
						setAdapter(adapter);
						injectTypes({
							filename: "yandex-cloud.d.ts",
							content: injectedRuntimeTypes(),
						});
					}).pipe(
						Effect.mapError(hookError("astro:config:done")),
					),
				buildSetup: ({
					target,
					vite,
					updateConfig,
				}: HookParameters<"astro:build:setup">) =>
					Effect.gen(function* () {
						if (target === "server") {
							const patch =
								yield* strategy.serverViteConfig(vite);
							updateConfig(patch);
						}
					}),
				buildDone: ({
					pages,
					assets,
					logger,
				}: HookParameters<"astro:build:done">) =>
					Effect.gen(function* () {
						if (!state.config) {
							return yield* new Options.Errors.InvalidConfiguration(
								{
									message:
										"Astro build completed before adapter configuration was resolved.",
								},
							);
						}
						const build = {
							config: state.config,
							resolvedRoutes: state.routes,
							pages,
							emittedAssets: assets,
						};
						const manifest =
							yield* strategy.generateArtifacts(build);
						yield* Effect.tryPromise(() =>
							reportArtifactSizes(
								build.config.outDir,
								manifest,
								logger,
							),
						).pipe(
							Effect.catchAll(() =>
								Effect.sync(() =>
									logger.warn(
										"Could not read generated artifacts for the size report. The build continues.",
									),
								),
							),
						);
					}).pipe(
						Effect.mapError(hookError("astro:build:done")),
					),
			};
		}),
	},
) {}
