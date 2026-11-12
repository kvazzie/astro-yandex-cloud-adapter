import type {
	AstroAdapter,
	AstroConfig,
	IntegrationResolvedRoute,
} from "astro";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { InlineConfig } from "vite";

import type * as ArtifactGeneration from "../mandatory/ArtifactGeneration";
import type * as RouteRequirements from "../mandatory/ArtifactGeneration/RouteRequirements";
import type { DeploymentManifestV1 } from "../mandatory/DeploymentManifest/Schema.ts";
import type * as FunctionArtifact from "../conditional/FunctionArtifact";
import type * as Options from "../Options";
import type { Errors } from ".";

export interface AstroBuildConfigPatch {
	build: { client: URL; server: URL; serverEntry: string };
}

export class TargetBuild extends Context.Tag(
	"@astro-yandex-cloud/adapter/TargetBuild",
)<
	TargetBuild,
	{
		readonly target: Options.Target;
		astroBuildConfig(
			config: AstroConfig,
		): Effect.Effect<
			AstroBuildConfigPatch,
			Options.Errors.InvalidConfiguration
		>;
		astroAdapter(
			routes: readonly IntegrationResolvedRoute[],
		): Effect.Effect<
			AstroAdapter,
			Errors.UnsupportedTargetRouteError
		>;
		serverViteConfig(
			vite: InlineConfig,
		): Effect.Effect<InlineConfig>;
		generateArtifacts(
			build: ArtifactGeneration.CompletedBuild,
		): Effect.Effect<
			DeploymentManifestV1,
			| Errors.UnsupportedTargetRouteError
			| RouteRequirements.Errors.UnsupportedRoute
			| FunctionArtifact.Errors.InvalidArtifact
			| FunctionArtifact.Errors.UnresolvedDependency
			| ArtifactGeneration.Errors.InvalidManifest
		>;
	}
>() {}
