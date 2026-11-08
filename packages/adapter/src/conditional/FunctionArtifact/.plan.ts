import { dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import type { RoutePlan } from "../../mandatory/ArtifactGeneration/RouteRequirements";
import type {
	FunctionArtifactBuild,
	FunctionArtifactDescriptor,
	Mutation,
	PlannedFile,
	PreparationPlan,
	PreparationSettings,
} from "./.types.ts";
import { planPartitions, wrapFunctionPolicy } from "./Partition";
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
			const partitioned = await planPartitions(
				build,
				routePlan,
				settings.functions,
			);
			const functions = partitioned.partitions.map(
				(partition) => partition.artifact,
			);
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
						routePlan: partitioned.routePlan,
						functions,
					},
				};
			const notFound = planNotFoundArtifacts(
				build,
				partitioned.routePlan,
				functions,
				settings.recursive404,
			);
			for (const partition of partitioned.partitions) {
				const { artifact } = partition;
				let packageFiles: PlannedFile[];
				try {
					packageFiles = await planPackageFiles(
						partition.files,
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
					[...partition.files, ...packageFiles].map((file) => [
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
				if (settings.functions === "separate")
					mutations.push(
						{
							kind: "removeDirectory",
							path: artifact.directory,
						},
						{ kind: "mkdir", path: artifact.directory },
					);
				for (const file of files.values()) {
					const destination = new URL(
						file.path,
						artifact.directory,
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
			if (settings.functions === "separate") {
				mutations.push({
					kind: "removeDirectory",
					path: build.config.build.server,
				});
				mutations.push(
					...previewMutations(
						build,
						partitioned.routePlan,
						functions,
					),
				);
			}
			return {
				mutations,
				plannedOutput: {
					routePlan: partitioned.routePlan,
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

function previewMutations(
	build: FunctionArtifactBuild,
	routePlan: RoutePlan,
	functions: readonly FunctionArtifactDescriptor[],
): Mutation[] {
	const directory = build.config.build.server;
	const base = `/${build.config.base.replace(/^\/+|\/+$/g, "")}`;
	const routes = routePlan.routes
		.filter((route) => route.kind === "on-demand")
		.sort((a, b) => a.priority - b.priority)
		.map((route) => ({
			pattern: route.patternRegex,
			artifact: functions.findIndex(
				(artifact) => artifact.id === route.artifactId,
			),
		}));
	const fallback = routePlan.routes.find(
		(route) =>
			route.kind === "on-demand" && route.routeKind === "page",
	);
	const fallbackIndex =
		fallback && fallback.kind === "on-demand"
			? functions.findIndex(
					(artifact) => artifact.id === fallback.artifactId,
				)
			: 0;
	const handlers = functions.map((artifact) => {
		const path = relative(
			fileURLToPath(directory),
			fileURLToPath(new URL("index.js", artifact.directory)),
		)
			.split(sep)
			.join("/");
		return `() => import(${JSON.stringify(path.startsWith(".") ? path : `./${path}`)})`;
	});
	const contents =
		`// Local Astro preview dispatcher; deploy only Functions listed in yandex-cloud.json.\n` +
		`const handlers = [${handlers.join(",")}];\n` +
		`const routes = ${JSON.stringify(routes)}.map(route => ({...route, pattern: new RegExp(route.pattern)}));\n` +
		`const base = ${JSON.stringify(base)};\n` +
		`export async function handler(event, context, previewUrl) {\n` +
		`  let pathname = (previewUrl ?? new URL(event.url ?? event.rawPath ?? event.path ?? '/', 'https://preview.invalid')).pathname;\n` +
		`  if (base !== '/' && (pathname === base || pathname.startsWith(base + '/'))) pathname = pathname.slice(base.length) || '/';\n` +
		`  try { pathname = decodeURI(pathname); } catch {}\n` +
		`  const matched = routes.find(route => route.pattern.test(pathname));\n` +
		`  const module = await handlers[matched?.artifact ?? ${fallbackIndex}]();\n` +
		`  return module.handler(event, context, previewUrl);\n` +
		`}\n`;
	return [
		{ kind: "mkdir", path: directory },
		{
			kind: "writeFile",
			path: new URL("package.json", directory),
			contents: '{"private":true,"type":"module"}\n',
		},
		{
			kind: "writeFile",
			path: new URL("index.js", directory),
			contents,
		},
	];
}
