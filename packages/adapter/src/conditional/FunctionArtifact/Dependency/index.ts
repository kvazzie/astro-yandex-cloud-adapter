import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import semver from "semver";

import {
	compareNames,
	exactDependencyVersion,
	type ResolvedRuntimeDependency,
} from "./Metadata.ts";
import {
	parseRegistryRequirement,
	type Registry,
	type RegistryVersionMetadata,
} from "./Registry.ts";

interface DependencySource {
	registryName?: string;
	version: string;
	directory?: string;
	lockLocation?: string;
	metadata?: RegistryVersionMetadata;
}

interface InstalledPackage extends DependencySource {
	directory: string;
}

/** Pins installed contexts, retaining absent optional packages for other platforms. */
export async function resolvePinnedRuntimeDependencies(
	appRoot: URL,
	directDependencyNames: Set<string>,
	registry: Registry,
): Promise<ResolvedRuntimeDependency[]> {
	const appDirectory = fileURLToPath(appRoot);
	const appManifestPath = join(appDirectory, "package.json");
	const lock = await readLocalLock(appDirectory);
	const nodes = new Map<
		string,
		{
			source: DependencySource;
			dependency: ResolvedRuntimeDependency;
			edges: Array<{ location: string; optional: boolean }>;
			ancestry: string[];
		}
	>();
	const pending: string[] = [];
	const roots: string[] = [];
	type Child = {
		name: string;
		source: DependencySource;
		optional: boolean;
	};
	// Peer checks must not depend on whether their child nodes have been queued yet.
	const resolvedSources = new Map<
		string,
		Promise<{
			metadata: RegistryVersionMetadata;
			children: Child[];
		}>
	>();
	const identity = (name: string, source: DependencySource) =>
		source.directory ??
		source.lockLocation ??
		`${source.registryName ?? name}@${source.version}`;
	const resolveSource = (
		packageName: string,
		source: DependencySource,
	) => {
		const key = identity(packageName, source);
		let result = resolvedSources.get(key);
		if (!result) {
			result = (async () => {
				const local = source.directory
					? await readJsonFile<PackageJson>(
							join(source.directory, "package.json"),
						)
					: undefined;
				const entry =
					source.directory && lock
						? lock.packages?.[
								relative(lock.directory, source.directory)
									.split("\\")
									.join("/")
							]
						: undefined;
				const selected =
					source.metadata ??
					(entry?.version === source.version
						? entry
						: await registry.resolve(
								source.registryName ?? packageName,
								source.version,
							));
				const metadata = {
					...selected,
					...Object.fromEntries(
						[
							"dependencies",
							"optionalDependencies",
							"peerDependencies",
							"peerDependenciesMeta",
						].flatMap((field) =>
							local?.[field] === undefined
								? []
								: [[field, local[field]]],
						),
					),
				};
				const children: Child[] = [];
				const ranges = new Map<
					string,
					{ range: string; optional: boolean; peer: boolean }
				>();
				for (const [name, range] of Object.entries(
					metadata.peerDependencies ?? {},
				))
					ranges.set(name, {
						range,
						optional:
							metadata.peerDependenciesMeta?.[name]?.optional ===
							true,
						peer: true,
					});
				for (const [name, range] of Object.entries(
					metadata.dependencies ?? {},
				))
					ranges.set(name, {
						range,
						optional: false,
						peer: false,
					});
				for (const [name, range] of Object.entries(
					metadata.optionalDependencies ?? {},
				))
					ranges.set(name, {
						range,
						optional: true,
						peer: false,
					});
				for (const [name, { range, optional, peer }] of [
					...ranges,
				].sort(([a], [b]) => compareNames(a, b))) {
					const requirement = parseRegistryRequirement(
						name,
						range,
					);
					let locked =
						!source.directory && source.lockLocation && lock
							? findLockedPackage(
									lock,
									source.lockLocation,
									name,
								)
							: undefined;
					let child: DependencySource | undefined = locked
						? {
								version: locked.metadata.version!,
								...(locked.metadata.name &&
								locked.metadata.name !== name
									? { registryName: locked.metadata.name }
									: {}),
								metadata: locked.metadata,
								lockLocation: locked.location,
							}
						: await findInstalledPackage(
								join(
									source.directory ??
										source.lockLocation ??
										appDirectory,
									"package.json",
								),
								name,
							);
					if (
						child &&
						(!semver.satisfies(
							child.version,
							requirement.requirement,
						) ||
							(requirement.name !== name &&
								(child.registryName ?? name) !==
									requirement.name))
					)
						throw unresolved(name, packageName, range);
					if (!child) {
						if (peer && optional) continue;
						if (source.directory && !optional)
							throw unresolved(name, packageName, range, peer);
						locked = lock
							? findLockedPackage(
									lock,
									source.directory ??
										source.lockLocation ??
										appDirectory,
									name,
								)
							: undefined;
						const childMetadata =
							locked?.metadata ??
							(await registry.resolve(
								requirement.name,
								requirement.requirement,
							));
						const version =
							childMetadata.version ??
							semver.valid(requirement.requirement);
						if (!version)
							throw new Error(
								`The "install" dependency strategy cannot pin ${name}@${range} to an exact version.`,
							);
						if (
							!semver.satisfies(version, requirement.requirement)
						)
							throw unresolved(name, packageName, range);
						child = {
							version,
							...((childMetadata.name ?? requirement.name) !==
							name
								? {
										registryName:
											childMetadata.name ?? requirement.name,
									}
								: {}),
							metadata: childMetadata,
							...(locked
								? { lockLocation: locked.location }
								: {}),
						};
					}
					children.push({ name, source: child, optional });
				}
				return { metadata, children };
			})();
			resolvedSources.set(key, result);
		}
		return result;
	};
	const packageLocation = (scope: string, name: string) =>
		`${scope ? `${scope}/` : ""}node_modules/${name}`;
	// Installed bindings constrain peers even before their output nodes are emitted.
	const contexts = new Map<string, string | undefined>();
	const installedSources = new Map<
		string,
		Promise<DependencySource | undefined>
	>();
	const sourceAt = (scope: string, name: string) => {
		const location = packageLocation(scope, name);
		let result = installedSources.get(location);
		if (!result) {
			result = (async () => {
				const owner = nodes.get(scope)?.source;
				const locked =
					!owner?.directory && owner?.lockLocation && lock
						? findLockedPackage(lock, owner.lockLocation, name)
						: undefined;
				if (locked)
					return {
						version: locked.metadata.version!,
						...(locked.metadata.name &&
						locked.metadata.name !== name
							? { registryName: locked.metadata.name }
							: {}),
						metadata: locked.metadata,
						lockLocation: locked.location,
					};
				return findInstalledPackage(
					scope
						? join(
								owner?.directory ??
									owner?.lockLocation ??
									appDirectory,
								"package.json",
							)
						: appManifestPath,
					name,
				);
			})();
			installedSources.set(location, result);
		}
		return result;
	};
	const contextIdentity = async (
		scope: string,
		name: string,
	) => {
		const location = packageLocation(scope, name);
		if (!contexts.has(location)) {
			const installed = await sourceAt(scope, name);
			if (installed)
				contexts.set(location, identity(name, installed));
		}
		return contexts.get(location);
	};
	const place = async (
		name: string,
		source: DependencySource,
		parent = "",
	): Promise<string> => {
		const key = identity(name, source);
		const { metadata, children } = await resolveSource(
			name,
			source,
		);
		const peers = Object.keys(
			metadata.peerDependencies ?? {},
		).map((peer) => {
			const child = children.find(({ name }) => name === peer);
			return [
				peer,
				child ? identity(peer, child.source) : undefined,
			] as const;
		});
		let ancestor = parent;
		const available: string[] = [];
		let reused: string | undefined;
		while (true) {
			const location = packageLocation(ancestor, name);
			const actual = await contextIdentity(ancestor, name);
			if (contexts.has(location) && actual !== key) break;
			let peersMatch = true;
			for (const [peer, expected] of peers) {
				const actual = await contextIdentity(ancestor, peer);
				if (
					contexts.has(packageLocation(ancestor, peer)) &&
					actual !== expected
				)
					peersMatch = false;
			}
			if (!peersMatch) break;
			available.push(ancestor);
			if (nodes.has(location)) {
				reused = location;
				break;
			}
			if (!ancestor) break;
			ancestor = parentLocation(ancestor);
		}
		const location =
			reused ??
			packageLocation(available.at(-1) ?? parent, name);
		const ancestry = nodes.get(parent)?.ancestry ?? [];
		if (!reused && ancestry.includes(key))
			throw new Error(
				`The "install" dependency strategy cannot preserve the installed dependency cycle at ${name}@${source.version}: a different installed context shadows the earlier instance. Artifact generation stopped before expanding another copy. Use "bundle" where supported or change the installed layout; no dependency versions were reselected.`,
			);
		contexts.set(location, key);
		// Children must not shadow this package's own peers, including optional absence.
		for (const [peer, expected] of peers)
			contexts.set(packageLocation(location, peer), expected);
		// Protect the whole lookup path, including when reusing an existing node.
		for (const scope of available) {
			contexts.set(packageLocation(scope, name), key);
			for (const [peer, expected] of peers)
				contexts.set(packageLocation(scope, peer), expected);
		}
		if (reused) return reused;
		nodes.set(location, {
			source,
			dependency: {
				name,
				location,
				version: source.version,
				...(source.registryName
					? { registryName: source.registryName }
					: {}),
			},
			edges: [],
			ancestry: [...ancestry, key],
		});
		pending.push(location);
		return location;
	};
	for (const name of [...directDependencyNames].sort(
		compareNames,
	)) {
		const source = await sourceAt("", name);
		if (!source) throw unresolved(name);
		roots.push(await place(name, source));
	}
	while (pending.length) {
		const location = pending.shift()!;
		const node = nodes.get(location)!;
		const { source, dependency } = node;
		const { metadata, children } = await resolveSource(
			dependency.name,
			source,
		);
		for (const field of [
			"resolved",
			"integrity",
			"license",
			"engines",
			"os",
			"cpu",
			"libc",
			"peerDependenciesMeta",
		] as const) {
			if (metadata[field] !== undefined)
				Object.assign(dependency, { [field]: metadata[field] });
		}
		const dependencies: Record<string, string> = {};
		const optionalDependencies: Record<string, string> = {};
		const peerDependencies = { ...metadata.peerDependencies };
		for (const { name, source: child, optional } of children) {
			const childLocation = await place(name, child, location);
			node.edges.push({ location: childLocation, optional });
			(optional ? optionalDependencies : dependencies)[name] =
				exactDependencyVersion(child);
			if (metadata.peerDependencies?.[name] !== undefined)
				peerDependencies[name] = exactDependencyVersion(child);
		}
		if (Object.keys(dependencies).length)
			dependency.dependencies = dependencies;
		if (Object.keys(optionalDependencies).length)
			dependency.optionalDependencies = optionalDependencies;
		if (Object.keys(peerDependencies).length)
			dependency.peerDependencies = peerDependencies;
	}
	// Required reachability is per location: an optional discovery cannot demote a required edge.
	const required = new Set<string>();
	const requiredPending = [...roots];
	while (requiredPending.length) {
		const location = requiredPending.shift()!;
		if (required.has(location)) continue;
		required.add(location);
		requiredPending.push(
			...nodes
				.get(location)!
				.edges.filter((edge) => !edge.optional)
				.map((edge) => edge.location),
		);
	}
	return [...nodes].map(([location, { dependency }]) =>
		required.has(location)
			? dependency
			: { ...dependency, optional: true },
	);
}

function unresolved(
	name: string,
	parent?: string,
	range?: string,
	peer = false,
): Error {
	return new Error(
		`The "install" dependency strategy cannot resolve ${peer ? "the required runtime peer" : "the runtime package"} "${name}"${parent ? ` (required by "${parent}" as "${range}")` : " imported by the Function Artifact"}. Install a matching application dependency so its exact version can be written to the Function Artifact.`,
	);
}

function parentLocation(location: string): string {
	const index = location.lastIndexOf("/node_modules/");
	return index === -1 ? "" : location.slice(0, index);
}

/** Search package directories, not exported entrypoints or CommonJS conditions. */
async function findInstalledPackage(
	base: string,
	name: string,
): Promise<InstalledPackage | undefined> {
	for (const modules of createRequire(base).resolve.paths(
		`${name}/package.json`,
	) ?? []) {
		const directory = join(modules, name);
		const manifest = await readJsonFile<PackageJson>(
			join(directory, "package.json"),
		);
		if (manifest !== undefined) {
			if (!manifest.version || !semver.valid(manifest.version))
				throw new Error(
					`Cannot read an exact dependency version at ${directory}.`,
				);
			return {
				version: manifest.version,
				...(manifest.name && manifest.name !== name
					? { registryName: manifest.name }
					: {}),
				directory: await realpath(directory),
			};
		}
	}
	return undefined;
}

async function readJsonFile<T>(
	filePath: string,
): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (
			["ENOENT", "ENOTDIR"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			return undefined;
		throw new Error(
			`Cannot read dependency metadata at ${filePath}.`,
			{ cause: error },
		);
	}
}

interface LocalLock {
	directory: string;
	packages?: Record<string, RegistryVersionMetadata>;
}

function findLockedPackage(
	lock: LocalLock,
	directory: string,
	name: string,
):
	| { location: string; metadata: RegistryVersionMetadata }
	| undefined {
	for (const modules of createRequire(
		join(directory, "package.json"),
	).resolve.paths(`${name}/package.json`) ?? []) {
		const location = join(modules, name);
		const metadata =
			lock.packages?.[
				relative(lock.directory, location).split("\\").join("/")
			];
		if (metadata?.version) return { location, metadata };
	}
	return undefined;
}

async function readLocalLock(
	fromDirectory: string,
): Promise<LocalLock | undefined> {
	let directory = fromDirectory;
	while (true) {
		const lock = await readJsonFile<LocalLock>(
			join(directory, "package-lock.json"),
		);
		if (lock) return { ...lock, directory };
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}
