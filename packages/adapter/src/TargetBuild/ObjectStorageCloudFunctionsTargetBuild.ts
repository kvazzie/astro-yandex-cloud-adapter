import { TargetBuild } from "./.Tag.ts";

import * as Effect from "effect/Effect";

import * as Routes from "../mandatory/ArtifactGeneration/RouteRequirements";
import * as FunctionArtifact from "../conditional/FunctionArtifact";
import * as Options from "../Options";
import { completeBuild } from "../mandatory/ArtifactGeneration";
import {
	assertUserExternals,
	configureServerBuild,
	sharpImageService,
} from "../conditional/FunctionArtifact/BuildConfiguration.ts";
import { adapter, buildDirectories } from ".";

export const make = (
	options: typeof Options.ObjectStorageCloudFunctionsTargetOptions.Type,
) =>
	TargetBuild.of({
		target: options.target,
		astroBuildConfig(config) {
			return Effect.try({
				try: () => {
					assertUserExternals(
						config,
						options.dependencyStrategy,
					);
					return { build: buildDirectories(config.outDir) };
				},
				catch: (cause) =>
					new Options.Errors.InvalidConfiguration({
						message:
							cause instanceof Error
								? cause.message
								: String(cause),
						cause,
					}),
			});
		},
		astroAdapter() {
			return Effect.sync(() =>
				// Runtime capability must be available before Astro discovers deferred islands.
				// The completed build decides whether a Function Artifact is actually required.
				adapter(true, {
					staticOutput: "stable",
					hybridOutput: "stable",
					serverOutput: "stable",
					sharpImageService: sharpImageService(
						options.dependencyStrategy,
					),
					envGetSecret: "stable",
					i18nDomains: "unsupported",
				}),
			);
		},
		serverViteConfig(vite) {
			return Effect.sync(() =>
				configureServerBuild(vite, options.dependencyStrategy),
			);
		},
		generateArtifacts(build) {
			return completeBuild(build, {
				target: options.target,
				dependencyStrategy: options.dependencyStrategy,
				apiGateway: options.apiGateway,
				recursive404: options.recursive404,
				functionPartition: options.functions,
				prepareArtifacts: (build, routePlan) =>
					Effect.gen(function* () {
						const incompatible = routePlan.routes.filter(
							(route) =>
								route.kind === "on-demand" &&
								(route.routeKind === "page" ||
									route.origin === "internal"),
						);
						if (!options.apiGateway && incompatible.length) {
							return yield* new Routes.Errors.UnsupportedRoute({
								message: `Direct Function URLs support only stateless user-defined endpoints. These required routes need apiGateway: true: ${incompatible.map((route) => route.pattern).join(", ")}.`,
							});
						}
						const dynamic404 = routePlan.routes.find(
							(route) =>
								route.kind === "on-demand" &&
								route.routeKind === "page" &&
								/\/404\/?$/.test(route.pattern),
						);
						if (dynamic404) {
							return yield* new Routes.Errors.UnsupportedRoute({
								message: `Custom 404 page ${dynamic404.pattern} must be prerendered. Add export const prerender = true.`,
							});
						}
						const plan = yield* FunctionArtifact.planPreparation(
							build,
							routePlan,
							{
								dependencyStrategy: options.dependencyStrategy,
								recursive404: options.recursive404,
							},
						);
						return yield* FunctionArtifact.applyPreparation(
							plan,
						);
					}),
			});
		},
	});
