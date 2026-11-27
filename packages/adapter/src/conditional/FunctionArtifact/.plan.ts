import type { Dirent } from "node:fs";
import {
	readdir,
	readlink,
	realpath,
	stat,
} from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	join,
	parse,
	posix,
	relative,
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
				// Removing a link that the client lookup passes through also breaks the client,
				// and so does removing the target of a link inside the client output.
				const clientLookup = await lookupPaths(client);
				let links: string[];
				try {
					links = await clientLinks(client);
				} catch (cause) {
					// A partial scan could miss a client file that depends on the server output.
					throw new Errors.InvalidArtifact({
						message: `The client output ${client} could not be scanned, so the server output ${server} cannot be safely removed when the build has no Function Artifact: ${cause instanceof Error ? cause.message : String(cause)}`,
						cause,
					});
				}
				for (const link of links)
					clientLookup.push(...(await lookupPaths(link)));
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
			// Artifact files follow the 404 copies; see the wrapper ordering below.
			const pendingWrites: Mutation[] = [];
			for (const prepared of output ? [output] : []) {
				const { artifact } = prepared;
				// npm ci reads npm-shrinkwrap.json before package-lock.json, so an emitted
				// one would replace the generated graph. The application's own shrinkwrap
				// still supplies pins, because it is read from the application root.
				if (
					settings.dependencyStrategy === "install" &&
					prepared.files.some(
						(file) => file.path === "npm-shrinkwrap.json",
					)
				)
					throw new Errors.InvalidArtifact({
						message: `The server output ${fileURLToPath(artifact.directory)} contains npm-shrinkwrap.json, which npm ci would read instead of the generated package-lock.json. Remove it from the server output; the application's own npm-shrinkwrap.json still pins its dependencies.`,
					});
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
				let wrapped: string | undefined;
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
					wrapped = path;
					files.set(path, {
						path,
						contents: wrapFunctionPolicy(
							entrypoint.contents,
							policy,
							`${posix.relative(posix.dirname(path), ".") || "."}/`,
						),
					});
				}
				// The marked wrapper is written last, so a failed application leaves the
				// emitted entrypoint unwrapped and a later preparation can run again.
				const ordered = [...files.values()].sort(
					(a, b) =>
						Number(a.path === wrapped) -
						Number(b.path === wrapped),
				);
				const writes: Mutation[] = [];
				for (const file of ordered) {
					const destination = pathToFileURL(
						join(fileURLToPath(artifact.directory), file.path),
					);
					if (file.from?.href === destination.href) continue;
					const parent = pathToFileURL(
						dirname(fileURLToPath(destination)) + "/",
					);
					const root = artifact.directory;
					writes.push({ kind: "mkdir", root, path: parent });
					if (file.binaryContents !== undefined)
						writes.push({
							kind: "writeBinaryFile",
							root,
							path: destination,
							contents: file.binaryContents,
						});
					else if (file.contents !== undefined)
						writes.push({
							kind: "writeFile",
							root,
							path: destination,
							contents: file.contents,
						});
					else
						writes.push({
							kind: "copyFile",
							root,
							from: file.from,
							to: destination,
						});
				}
				pendingWrites.push(...writes);
			}
			mutations.push(...notFound.mutations);
			mutations.push(...pendingWrites);
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

/** Lists every symbolic link in the client output, including links below linked directories. */
async function clientLinks(client: string): Promise<string[]> {
	const links: string[] = [];
	// Real directories already listed; a link back to one of them is a cycle.
	const listed = new Set<string>();
	const visit = async (directory: string, root: boolean) => {
		let entries: Dirent[];
		try {
			listed.add(await realpath(directory));
			entries = await readdir(directory, {
				withFileTypes: true,
			});
		} catch (cause) {
			// A missing client output holds no files to protect.
			if (
				root &&
				["ENOENT", "ENOTDIR"].includes(
					(cause as NodeJS.ErrnoException).code ?? "",
				)
			)
				return;
			throw cause;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path, false);
			else if (entry.isSymbolicLink()) {
				links.push(path);
				let target: string;
				try {
					target = await realpath(path);
				} catch (cause) {
					// lookupPaths reports a dangling link's path and rejects a loop.
					if (
						["ENOENT", "ELOOP"].includes(
							(cause as NodeJS.ErrnoException).code ?? "",
						)
					)
						continue;
					throw cause;
				}
				// Recursive readdir lists a directory link without descending into it.
				if (
					!listed.has(target) &&
					(await stat(target)).isDirectory()
				)
					await visit(path, false);
			}
		}
	};
	await visit(client, true);
	return links;
}

/** Lists every path that resolving `path` visits, including each intermediate link. */
async function lookupPaths(path: string): Promise<string[]> {
	// Walk components in lookup order, so a link is followed before a later "..".
	const root = parse(path).root;
	// Only Windows treats a backslash as a separator; elsewhere it names a file.
	const separators = sep === "\\" ? /[\\/]+/ : /\/+/;
	const pending = path.slice(root.length).split(separators);
	const visited = [root];
	let current = root;
	// Linux follows at most 40 links in one lookup; a revisited link is not a loop.
	let links = 0;
	while (pending.length) {
		const component = pending.shift()!;
		if (component === "" || component === ".") continue;
		if (component === "..") {
			current = dirname(current);
			continue;
		}
		const next = join(current, component);
		visited.push(next);
		let target: string;
		try {
			target = await readlink(next);
		} catch (cause) {
			if (
				!["EINVAL", "ENOENT", "ENOTDIR"].includes(
					(cause as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw cause;
			current = next;
			continue;
		}
		if (++links > 40)
			throw new Errors.InvalidArtifact({
				message: `The client output path ${path} contains a symbolic link loop.`,
			});
		const targetRoot = parse(target).root;
		if (targetRoot) current = targetRoot;
		pending.unshift(
			...target.slice(targetRoot.length).split(separators),
		);
	}
	return visited;
}
