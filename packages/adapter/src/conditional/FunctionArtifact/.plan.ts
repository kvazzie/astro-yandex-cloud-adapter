import { readlink, realpath } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
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
	registry: Registry = {
		resolve: (name, version) =>
			npmRegistry.resolve(name, version, build.config.root),
	},
): Effect.Effect<
	PreparationPlan,
	Errors.InvalidArtifact | Errors.UnresolvedDependency
> {
	return Effect.tryPromise({
		try: async () => {
			const output = await readFunctionOutput(build, routePlan);
			const functions = output ? [output.artifact] : [];
			const mutations: Mutation[] = [];
			if (!functions.length) {
				const server = fileURLToPath(build.config.build.server);
				const client = fileURLToPath(build.config.build.client);
				const within = (child: string, parent: string) => {
					const path = relative(parent, child);
					return (
						path !== ".." &&
						!path.startsWith(`..${sep}`) &&
						!isAbsolute(path)
					);
				};
				// Symlinks can make lexically separate outputs share real directories.
				const real = async (path: string) => {
					try {
						return await realpath(path);
					} catch (cause) {
						if (
							(cause as NodeJS.ErrnoException).code === "ENOENT"
						)
							return path;
						throw cause;
					}
				};
				const [realServer, realClient] = await Promise.all([
					real(server),
					real(client),
				]);
				// Removing a link that the client lookup passes through also breaks the client.
				const clientLookup = await lookupPaths(client);
				if (
					within(server, client) ||
					within(client, server) ||
					within(realServer, realClient) ||
					within(realClient, realServer) ||
					clientLookup.some(
						(path) =>
							within(path, server) || within(path, realServer),
					)
				)
					throw new Errors.InvalidArtifact({
						message: `The server output ${server} overlaps the client output ${client}, so it cannot be removed when the build has no Function Artifact. Use separate build.server and build.client directories.`,
					});
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
			}
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
						build.config.build.server,
						settings.includeLocal ?? false,
						settings.includeDependencies ?? [],
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
					// Node loads a linked entrypoint from its target, so wrap the target there.
					const server = await realpath(
						fileURLToPath(artifact.directory),
					);
					const target = relative(
						server,
						await realpath(
							join(
								fileURLToPath(artifact.directory),
								"index.js",
							),
						),
					);
					if (
						target === "" ||
						target === ".." ||
						target.startsWith(`..${sep}`) ||
						isAbsolute(target)
					)
						throw new Errors.InvalidArtifact({
							message: `The Function Artifact entrypoint index.js links outside the server output, so the 404 policy cannot be added to it. Emit index.js inside ${fileURLToPath(artifact.directory)}.`,
						});
					const path = target.split(sep).join("/");
					const entrypoint = files.get(path);
					if (entrypoint?.contents === undefined)
						throw new Error(
							"The emitted handler export is missing or already wrapped.",
						);
					files.set(path, {
						path,
						contents: wrapFunctionPolicy(
							entrypoint.contents,
							policy,
							`${posix.relative(posix.dirname(path), ".") || "."}/`,
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
					if (file.binaryContents !== undefined)
						mutations.push({
							kind: "writeBinaryFile",
							path: destination,
							contents: file.binaryContents,
						});
					else if (file.contents !== undefined)
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

/** Lists every path that resolving `path` visits, including each intermediate link. */
async function lookupPaths(
	path: string,
	// Links whose expansion is in progress; a completed link may be passed again.
	links = new Set<string>(),
): Promise<string[]> {
	const parent = dirname(path);
	if (parent === path) return [path];
	const visited = await lookupPaths(parent, links);
	const current = join(visited.at(-1)!, basename(path));
	let target: string;
	try {
		target = await readlink(current);
	} catch (cause) {
		if (
			["EINVAL", "ENOENT", "ENOTDIR"].includes(
				(cause as NodeJS.ErrnoException).code ?? "",
			)
		)
			return [...visited, current];
		throw cause;
	}
	if (links.has(current))
		throw new Errors.InvalidArtifact({
			message: `The client output path ${path} contains a symbolic link loop.`,
		});
	links.add(current);
	try {
		return [
			...visited,
			current,
			...(await lookupPaths(
				resolve(dirname(current), target),
				links,
			)),
		];
	} finally {
		links.delete(current);
	}
}
