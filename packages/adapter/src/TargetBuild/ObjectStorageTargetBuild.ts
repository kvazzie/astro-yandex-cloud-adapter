import { TargetBuild } from "./.Tag.ts";
import * as Effect from "effect/Effect";

import * as Routes from "../mandatory/ArtifactGeneration/RouteRequirements";
import * as Options from "../Options";
import { completeBuild } from "../mandatory/ArtifactGeneration";
import {
	assertUserExternals,
	configureServerBuild,
} from "../conditional/FunctionArtifact/BuildConfiguration.ts";
import { Errors, adapter, buildDirectories } from ".";

export const make = (
	options: typeof Options.ObjectStorageTargetOptions.Type,
) =>
	TargetBuild.of({
		target: options.target,
		astroBuildConfig(config) {
			return Effect.try({
				try: () => {
					assertUserExternals(config, "bundle");
					return { build: buildDirectories(config.outDir) };
				},
				catch: (cause) =>
					new Options.Errors.InvalidConfiguration({
						message: String(cause),
						cause,
					}),
			});
		},
		astroAdapter(routes) {
			const [firstRoute, ...otherRoutes] =
				Routes.registeredOnDemandRoutes(routes);
			if (firstRoute) {
				return Effect.fail(
					new Errors.UnsupportedTargetRouteError({
						target: options.target,
						routePatterns: [
							firstRoute.pattern,
							...otherRoutes.map((route) => route.pattern),
						],
					}),
				);
			}
			return Effect.succeed(
				adapter(false, {
					staticOutput: "stable",
					hybridOutput: "unsupported",
					serverOutput: "unsupported",
					sharpImageService: "stable",
					envGetSecret: "stable",
					i18nDomains: "unsupported",
				}),
			);
		},
		serverViteConfig(vite) {
			return Effect.sync(() =>
				configureServerBuild(vite, "bundle"),
			);
		},
		generateArtifacts(build) {
			return completeBuild<
				| Errors.UnsupportedTargetRouteError
				| Routes.Errors.UnsupportedRoute
			>(build, {
				target: options.target,
				apiGateway: options.apiGateway,
				recursive404: options.recursive404,
				prepareArtifacts: (_build, routePlan, hasFunction) => {
					const [firstRoute, ...otherRoutes] =
						Routes.manifestRoutes(routePlan).onDemand;
					if (firstRoute)
						return Effect.fail(
							new Errors.UnsupportedTargetRouteError({
								target: options.target,
								routePatterns: [
									firstRoute.pattern,
									...otherRoutes.map((route) => route.pattern),
								],
							}),
						);
					if (hasFunction)
						return Effect.fail(
							new Routes.Errors.UnsupportedRoute({
								message:
									'The object-storage target cannot produce a Function Artifact. Use target "object-storage-functions".',
							}),
						);
					return Effect.succeed({ routePlan, functions: [] });
				},
			});
		},
	});
