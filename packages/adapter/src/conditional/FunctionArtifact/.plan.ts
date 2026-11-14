import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import type { RoutePlan } from "../../mandatory/ArtifactGeneration/RouteRequirements";
import type {
	FunctionArtifactBuild,
	Mutation,
	PlannedFile,
	PreparationPlan,
	PreparationSettings,
} from "./.types.ts";
import {
	readFunctionOutput,
	wrapFunctionPolicy,
} from "./.output.ts";
import {
	planNotFoundArtifacts,
	planPackageFiles,
} from "./Prepare.ts";
import {
	npmRegistry,
	type Registry,
} from "./Dependency/Registry.ts";
import { Errors } from ".";

/** Computes a complete, inspectable mutation plan; does not modify artifact output. */
export function planPreparation(
	build: FunctionArtifactBuild,
	routePlan: RoutePlan,
	settings: PreparationSettings,
	registry: Registry = npmRegistry,
): Effect.Effect<
	PreparationPlan,
	Errors.InvalidArtifact | Errors.UnresolvedDependency
> {
	return Effect.tryPromise({
		try: async () => {
			const output = await readFunctionOutput(build, routePlan);
			const functions = output ? [output.artifact] : [];
			const mutations: Mutation[] = [];
			if (!functions.length)
				return {
					mutations: [
						{
							kind: "removeDirectory" as const,
							path: build.config.build.server,
						},
					],
					plannedOutput: {
						routePlan,
						functions,
					},
				};
			const notFound = planNotFoundArtifacts(
				build,
				routePlan,
				functions,
				settings.recursive404,
			);
			for (const prepared of output ? [output] : []) {
				const { artifact } = prepared;
				let packageFiles: PlannedFile[];
				try {
					packageFiles = await planPackageFiles(
						prepared.files,
						settings.dependencyStrategy,
						build.config.root,
						registry,
					);
				} catch (cause) {
					throw new Errors.UnresolvedDependency({
						message:
							cause instanceof Error
								? cause.message
								: String(cause),
						cause,
					});
				}
				const files = new Map(
					[...prepared.files, ...packageFiles].map((file) => [
						file.path,
						file,
					]),
				);
				const policy = notFound.policies.get(artifact.id)!;
				if (Object.keys(policy).length) {
					const entrypoint = files.get("index.js");
					if (entrypoint?.contents === undefined)
						throw new Error(
							"The emitted handler export is missing or already wrapped.",
						);
					files.set("index.js", {
						path: "index.js",
						contents: wrapFunctionPolicy(
							entrypoint.contents,
							policy,
						),
					});
				}
				for (const file of files.values()) {
					const destination = pathToFileURL(
						join(fileURLToPath(artifact.directory), file.path),
					);
					if (file.from?.href === destination.href) continue;
					const parent = pathToFileURL(
						dirname(fileURLToPath(destination)) + "/",
					);
					mutations.push({ kind: "mkdir", path: parent });
					if (file.contents !== undefined)
						mutations.push({
							kind: "writeFile",
							path: destination,
							contents: file.contents,
						});
					else
						mutations.push({
							kind: "copyFile",
							from: file.from,
							to: destination,
						});
				}
			}
			mutations.push(...notFound.mutations);
			return {
				mutations,
				plannedOutput: {
					routePlan,
					functions,
				},
			};
		},
		catch: (cause) =>
			cause instanceof Errors.InvalidArtifact ||
			cause instanceof Errors.UnresolvedDependency
				? cause
				: new Errors.InvalidArtifact({
						message:
							cause instanceof Error
								? cause.message
								: String(cause),
						cause,
					}),
	});
}
