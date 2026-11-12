import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import semver from "semver";

import {
	compareNames,
	type ResolvedRuntimeDependency,
} from "./Metadata.ts";
import type {
	Registry,
	RegistryVersionMetadata,
} from "./Registry.ts";

interface DependencySource {
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
		}
	>();
	const pending: string[] = [];
	const roots: string[] = [];
	const metadataCache = new Map<
		string,
		Promise<RegistryVersionMetadata>
	>();
	const identity = (name: string, source: DependencySource) =>
		source.directory ??
		source.lockLocation ??
		`${name}@${source.version}`;
	const place = (
		name: string,
		source: DependencySource,
		parent = "",
	): string => {
		let ancestor = parent;
		while (true) {
			const location = `${ancestor ? `${ancestor}/` : ""}node_modules/${name}`;
			const existing = nodes.get(location);
			if (existing) {
				if (
					identity(name, existing.source) ===
					identity(name, source)
				)
					return location;
				break;
			}
			if (!ancestor) break;
			ancestor = parentLocation(ancestor);
		}
		const root = `node_modules/${name}`;
		const location = nodes.has(root)
			? `${parent}/node_modules/${name}`
			: root;
		nodes.set(location, {
			source,
			dependency: { name, location, version: source.version },
			edges: [],
		});
		pending.push(location);
		return location;
	};
	for (const name of [...directDependencyNames].sort(
		compareNames,
	)) {
		const source = await findInstalledPackage(
			appManifestPath,
			name,
		);
		if (!source) throw unresolved(name);
		roots.push(place(name, source));
	}
	while (pending.length) {
		const location = pending.shift()!;
		const node = nodes.get(location)!;
		const { source, dependency } = node;
		const key = identity(dependency.name, source);
		let metadataPromise = metadataCache.get(key);
		if (!metadataPromise) {
			metadataPromise = (async () => {
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
				const metadata =
					source.metadata ??
					(entry?.version === source.version
						? entry
						: await registry.resolve(
								dependency.name,
								source.version,
							));
				return {
					...metadata,
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
			})();
			metadataCache.set(key, metadataPromise);
		}
		const metadata = await metadataPromise;
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
			ranges.set(name, { range, optional: false, peer: false });
		for (const [name, range] of Object.entries(
			metadata.optionalDependencies ?? {},
		))
			ranges.set(name, { range, optional: true, peer: false });
		for (const [name, { range, optional, peer }] of [
			...ranges,
		].sort(([a], [b]) => compareNames(a, b))) {
			let child: DependencySource | undefined =
				await findInstalledPackage(
					join(
						source.directory ??
							source.lockLocation ??
							appDirectory,
						"package.json",
					),
					name,
				);
			if (child && !semver.satisfies(child.version, range))
				throw unresolved(name, dependency.name, range);
			if (!child) {
				if (peer && optional) continue;
				if (source.directory && !optional)
					throw unresolved(name, dependency.name, range);
				const locked = lock
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
					(await registry.resolve(name, range));
				const version =
					childMetadata.version ?? semver.valid(range);
				if (!version)
					throw new Error(
						`The "install" dependency strategy cannot pin ${name}@${range} to an exact version.`,
					);
				if (!semver.satisfies(version, range))
					throw unresolved(name, dependency.name, range);
				child = {
					version,
					metadata: childMetadata,
					...(locked ? { lockLocation: locked.location } : {}),
				};
			}
			const childLocation = place(name, child, location);
			node.edges.push({ location: childLocation, optional });
			(optional ? optionalDependencies : dependencies)[name] =
				child.version;
			if (metadata.peerDependencies?.[name] !== undefined)
				peerDependencies[name] = child.version;
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
): Error {
	return new Error(
		`The "install" dependency strategy cannot resolve the runtime package "${name}"${parent ? ` (required by "${parent}" as "${range}")` : " imported by the Function Artifact"}. Install a matching application dependency so its exact version can be written to the Function Artifact.`,
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
		name,
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
	).resolve.paths(name) ?? []) {
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
