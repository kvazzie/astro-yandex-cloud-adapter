import { readPackageInfo } from "@astro-yandex-cloud/package-info";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { defineIntegration, runHook } from "./.integration.ts";

import Hooks from "./Hooks";
import * as Options from "./Options";
import { TargetBuildLive } from "./TargetBuild";

export {
	defineDeploymentManifest,
	encodeDeploymentManifest,
	parseDeploymentManifest,
} from "./mandatory/DeploymentManifest";
export type EncodedOptions = typeof Options.Schema.Encoded;
export type {
	DependencyStrategy,
	FunctionPartition,
	Target,
} from "./Options";
export type {
	DeploymentManifestV1,
	EncodedDeploymentManifestV1,
	OnDemandRouteRequirement,
	PrerenderedRouteRequirement,
	YandexCloudManifestV1,
} from "./mandatory/DeploymentManifest/Schema.ts";
export type {
	YandexCloudRuntime,
	YandexCloudHttpEvent,
	YandexCloudInvocationContext,
	YandexCloudHttpResult,
} from "@astro-yandex-cloud/function-runtime-bridge";

const { name } = readPackageInfo(import.meta.url);

/** Creates the Bare Adapter integration for the selected Yandex Cloud Target. */
export default defineIntegration({
	name,
	schema: Options.Schema,
	setup: ({ options }) => {
		const optionsLayer = Layer.succeed(Options.Tag, options);

		const hooksLayer = Hooks.Default.pipe(
			Layer.provide(TargetBuildLive),
			Layer.provide(optionsLayer),
		);

		// Create one Hooks instance so its callbacks share the same build state.
		const hooks = Hooks.pipe(
			Effect.provide(hooksLayer),
			Effect.runSync,
		);

		return {
			"astro:config:setup": runHook(
				name,
				"astro:config:setup",
				hooks.configSetup,
			),
			"astro:routes:resolved": runHook(
				name,
				"astro:routes:resolved",
				hooks.routesResolved,
			),
			"astro:config:done": runHook(
				name,
				"astro:config:done",
				hooks.configDone,
			),
			"astro:build:setup": runHook(
				name,
				"astro:build:setup",
				hooks.buildSetup,
			),
			"astro:build:ssr": runHook(
				name,
				"astro:build:ssr",
				hooks.buildSsr,
			),
			"astro:build:done": runHook(
				name,
				"astro:build:done",
				hooks.buildDone,
			),
		};
	},
});
