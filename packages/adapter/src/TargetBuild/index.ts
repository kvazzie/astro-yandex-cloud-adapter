import { readPackageInfo } from "@astro-yandex-cloud/package-info";
import type { AstroAdapter } from "astro";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

import * as Options from "../Options";
import { TargetBuild } from "./.Tag.ts";
import * as ObjectStorageCloudFunctionsTargetBuild from "./ObjectStorageCloudFunctionsTargetBuild.ts";
import * as ObjectStorageTargetBuild from "./ObjectStorageTargetBuild.ts";

export { TargetBuild } from "./.Tag.ts";
export type { AstroBuildConfigPatch } from "./.Tag.ts";
export * as Errors from "./Errors.ts";

const { name } = readPackageInfo(import.meta.url);

export const TargetBuildLive = Layer.effect(
	TargetBuild,
	Effect.gen(function* () {
		const options = yield* Options.Tag;
		return Match.value(options).pipe(
			Match.when(
				Schema.is(Options.ObjectStorageTargetOptions),
				(options) => ObjectStorageTargetBuild.make(options),
			),
			Match.when(
				Schema.is(
					Options.ObjectStorageCloudFunctionsTargetOptions,
				),
				(options) =>
					ObjectStorageCloudFunctionsTargetBuild.make(options),
			),
			Match.exhaustive,
		);
	}),
);

export function buildDirectories(outDir: URL) {
	return {
		client: new URL("client/", outDir),
		server: new URL("function/", outDir),
		serverEntry: "index.js",
	};
}

export function adapter(
	hasOnDemandRoutes: boolean,
	supportedAstroFeatures: AstroAdapter["supportedAstroFeatures"],
): AstroAdapter {
	return {
		name,
		entrypointResolution: "auto",
		serverEntrypoint: new URL("./server.js", import.meta.url),
		previewEntrypoint: `${name}/preview`,
		adapterFeatures: {
			buildOutput: hasOnDemandRoutes ? "server" : "static",
			middlewareMode: "classic",
			preserveBuildClientDir: true,
			preserveBuildServerDir: true,
		},
		supportedAstroFeatures,
	};
}
