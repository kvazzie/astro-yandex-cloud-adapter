import { createRequire } from "node:module";
import {
	dirname,
	join,
	relative,
	isAbsolute,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, realpath } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import semver from "semver";
import {
	readInstalledSource,
	readInstalledProvenance,
	readRootRequirementPrecedence,
	inspectInstalledSource,
	readInstalledBindingPath,
	parseRuntimeRequirement,
} from "./Source.ts";

import {
	compareNames,
	exactDependencyVersion,
	type ResolvedRuntimeDependency,
} from "./Metadata.ts";
import {
	isRegistryTag,
	hasInstallLifecycleScripts,
	normalizePackageBin,
	normalizeBundleDependencies,
	type Registry,
	type RegistryVersionMetadata,
} from "./Registry.ts";

import {
	ApplicationOverrides,
	applicationDependencyRequirement,
} from "./.overrides.ts";

interface DependencySource {
	inBundle?: boolean;
	bundleRoot?: string;
	overrides?: ApplicationOverrides;
	registryName?: string;
	version: string;
	directory?: string;
	lockLocation?: string;
	metadata?: RegistryVersionMetadata;
	local?: boolean;
}

/** Pins installed contexts, retaining absent optional packages for other platforms. */
export async function resolvePinnedRuntimeDependencies(
	root: URL,
	directDependencyNames: Set<string>,
	registry: Registry,
	includeLocal = false,
): Promise<ResolvedRuntimeDependency[]> {
	const appDirectory = await realpath(fileURLToPath(root));
	const appRoot = pathToFileURL(appDirectory + sep);
	const appManifestPath = join(appDirectory, "package.json");
	const developmentFirst =
		await readRootRequirementPrecedence(appManifestPath);
	const provenance = await readInstalledProvenance(
		appRoot,
		developmentFirst,
	);
	const findInstalledPackage = (
		base: string,
		name: string,
		runtimeRequirement?: string,
	) =>
		readInstalledSource(
			base,
			name,
			includeLocal,
			runtimeRequirement,
			provenance,
			appRoot,
		);
	const lock = await readLocalLock(appDirectory);
	const application =
		await readJsonFile<PackageJson>(appManifestPath);
	const overrides = new ApplicationOverrides(application ?? {});
	const nodes = new Map<
		string,
		{
			source: DependencySource;
			dependency: ResolvedRuntimeDependency;
			edges: Array<{ location: string; optional: boolean }>;
			ancestry: string[];
		}
	>();
	const emittedBindings = new Map<string, string>();
	const pending: string[] = [];
	const roots: string[] = [];
	type Child = {
		peer: boolean;
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
		`${source.registryName ?? name}@${source.version}${source.overrides?.identity ?? ""}`;
	// A lock reference can name a binding whose installed contents were already selected.
	const reconcileSource = (
		name: string,
		source: DependencySource,
	): DependencySource => {
		if (source.directory || !source.lockLocation) return source;
		const installed = nodes.get(
			emittedBindings.get(source.lockLocation) ?? "",
		)?.source;
		if (
			!installed?.directory ||
			installed.version !== source.version ||
			(installed.registryName ?? name) !==
				(source.registryName ?? name)
		)
			return source;
		return { ...installed, overrides: source.overrides };
	};

	const resolveSource = (
		packageName: string,
		source: DependencySource,
	) => {
		source = reconcileSource(packageName, source);
		const key = JSON.stringify([
			identity(packageName, source),
			source.directory,
			source.overrides?.identity,
		]);
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
					(source.local || source.inBundle
						? (local as RegistryVersionMetadata)
						: undefined) ??
					source.metadata ??
					(entry?.version === source.version &&
					(entry.name ?? packageName) ===
						(source.registryName ?? packageName)
						? entry
						: await registry.resolve(
								source.registryName ?? packageName,
								source.version,
							));
				const metadata = {
					...selected,
					bin: normalizePackageBin(
						source.registryName ?? packageName,
						local?.bin === undefined ? selected.bin : local.bin,
					),
					...(hasInstallLifecycleScripts(local?.scripts)
						? { hasInstallScript: true }
						: {}),
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
				metadata.bundleDependencies =
					normalizeBundleDependencies(
						local?.bundleDependencies ??
							local?.bundledDependencies ??
							selected.bundleDependencies,
						metadata.dependencies,
						metadata.optionalDependencies,
					);

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
					const override = (
						source.overrides ?? overrides
					).forDependency(name, range);
					let locked =
						!source.directory && source.lockLocation && lock
							? findLockedPackage(
									lock,
									source.lockLocation,
									name,
								)
							: undefined;
					const bundleMember =
						!peer && metadata.bundleDependencies?.includes(name);
					if (bundleMember && !source.directory) continue;

					const childBase = join(
						source.directory ??
							source.lockLocation ??
							appDirectory,
						"package.json",
					);
					let installed = locked
						? undefined
						: source.directory &&
							  !bundleMember &&
							  !source.inBundle
							? await findInstalledPackage(
									childBase,
									name,
									bundleMember || source.inBundle
										? range
										: override.spec,
								)
							: await inspectInstalledSource(
									childBase,
									name,
									range,
									provenance,
									appRoot,
								);
					const inBundle = Boolean(
						installed &&
						!peer &&
						(bundleMember ||
							(source.inBundle &&
								source.bundleRoot &&
								bundleRelativePath(
									source.bundleRoot,
									installed.directory,
								) !== undefined)),
					);
					const requirement = parseRuntimeRequirement(
						name,
						inBundle ? range : override.spec,
					);
					const compatible = (candidate: {
						version: string;
						registryName?: string;
					}) =>
						(isRegistryTag(requirement.requirement) ||
							semver.satisfies(
								candidate.version,
								requirement.requirement,
							)) &&
						(requirement.name === name ||
							(candidate.registryName ?? name) ===
								requirement.name);
					if (installed && source.directory && !inBundle)
						installed = await findInstalledPackage(
							childBase,
							name,
							override.spec,
						);

					if (!inBundle && requirement.local)
						installed = await findInstalledPackage(
							childBase,
							name,
							override.spec,
						);
					let child: DependencySource | undefined =
						locked && !requirement.local
							? {
									version: locked.metadata.version!,
									...(locked.metadata.name &&
									locked.metadata.name !== name
										? { registryName: locked.metadata.name }
										: {}),
									metadata: locked.metadata,
									lockLocation: locked.location,
								}
							: installed?.version &&
								  (!installed.local || includeLocal || inBundle)
								? { ...installed, version: installed.version }
								: undefined;
					if (child && inBundle)
						child = {
							...child,
							local: false,
							inBundle: true,
							bundleRoot: source.bundleRoot ?? source.directory,
						};

					if (!child && peer && optional) continue;
					if (
						!inBundle &&
						requirement.local &&
						(!includeLocal || !child)
					)
						throw new Error(
							`Local runtime package "${name}" requires includeLocal and an installed local source.`,
						);
					if (child && !compatible(child)) {
						if (source.directory || requirement.local)
							throw unresolved(name, packageName, range);
						child = undefined;
					}
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
						if (
							locked &&
							!compatible({
								version: locked.metadata.version!,
								registryName: locked.metadata.name,
							})
						)
							locked = undefined;
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
							!isRegistryTag(requirement.requirement) &&
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
					children.push({
						name,
						source: { ...child, overrides: override.context },
						optional,
						peer,
					});
				}
				return { metadata, children };
			})();
			resolvedSources.set(key, result);
		}
		return result;
	};
	// Reusing one installed binding must retain every caller's effective children.
	const sameDependencyContext = async (
		name: string,
		left: DependencySource,
		right: DependencySource,
		seen = new Set<string>(),
	): Promise<boolean> => {
		left = reconcileSource(name, left);
		right = reconcileSource(name, right);
		const binding = (source: DependencySource) => [
			source.directory,
			source.lockLocation,
			source.registryName ?? name,
			source.version,
			source.local ?? false,
			source.inBundle ?? false,
			source.bundleRoot,
		];
		const leftBinding = JSON.stringify(binding(left));
		const rightBinding = JSON.stringify(binding(right));
		if (leftBinding !== rightBinding) return false;
		if (left.overrides?.identity === right.overrides?.identity)
			return true;
		const pair = JSON.stringify([
			leftBinding,
			left.overrides?.identity,
			right.overrides?.identity,
		]);
		if (seen.has(pair)) return true;
		seen.add(pair);
		const [a, b] = await Promise.all([
			resolveSource(name, left),
			resolveSource(name, right),
		]);
		if (a.children.length !== b.children.length) return false;
		for (const [index, child] of a.children.entries()) {
			const other = b.children[index]!;
			if (
				child.name !== other.name ||
				child.optional !== other.optional ||
				child.peer !== other.peer ||
				!(await sameDependencyContext(
					child.name,
					child.source,
					other.source,
					seen,
				))
			)
				return false;
		}
		return true;
	};

	const packageLocation = (scope: string, name: string) =>
		`${scope ? `${scope}/` : ""}node_modules/${name}`;
	// Installed bindings constrain peers even before their output nodes are emitted.
	const contexts = new Map<string, string | undefined>();
	const reservations = new Set<string>();
	const reserve = (
		location: string,
		key: string | undefined,
	) => {
		contexts.set(location, key);
		reservations.add(location);
	};
	const installedBindings = new Map<
		string,
		Promise<string | undefined>
	>();
	const bindingAt = (scope: string, name: string) => {
		const location = packageLocation(scope, name);
		let result = installedBindings.get(location);
		if (!result) {
			result = (async () => {
				const owner = nodes.get(scope)?.source;
				const locked =
					!owner?.directory && owner?.lockLocation && lock
						? findLockedPackage(lock, owner.lockLocation, name)
						: undefined;
				if (locked) return locked.location;
				return readInstalledBindingPath(
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
			installedBindings.set(location, result);
		}
		return result;
	};
	const contextIdentity = async (
		scope: string,
		name: string,
	) => {
		const location = packageLocation(scope, name);
		if (!contexts.has(location)) {
			const installed = await bindingAt(scope, name);
			if (installed) contexts.set(location, installed);
		}
		return contexts.get(location);
	};
	const place = async (
		name: string,
		source: DependencySource,
		parent = "",
	): Promise<string> => {
		source = reconcileSource(name, source);
		// The parent tarball, rather than hoisting, owns these filesystem locations.
		if (
			source.inBundle &&
			source.bundleRoot &&
			source.directory
		) {
			const bundledPath = bundleRelativePath(
				source.bundleRoot,
				source.directory,
			);
			let owner = parent;
			while (
				owner &&
				nodes.get(owner)?.source.directory !== source.bundleRoot
			)
				owner = parentLocation(owner);
			if (owner && bundledPath !== undefined)
				parent = parentLocation(
					`${owner}/${bundledPath.split("\\").join("/")}`,
				);
		}

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
			const existing = nodes.get(location);
			if (existing) {
				if (
					!(await sameDependencyContext(
						name,
						existing.source,
						source,
					))
				)
					throw unresolved(name);
				reused = location;
				break;
			}
			if (!ancestor || source.inBundle) break;
			ancestor = parentLocation(ancestor);
		}
		const location =
			reused ??
			packageLocation(available.at(-1) ?? parent, name);
		if (
			reservations.has(location) &&
			contexts.get(location) !== key
		)
			throw unresolved(name);
		const ancestry = nodes.get(parent)?.ancestry ?? [];
		if (!reused && ancestry.includes(key))
			throw new Error(
				`The "install" dependency strategy cannot preserve the installed dependency cycle at ${name}@${source.version}: a different installed context shadows the earlier instance. Artifact generation stopped before expanding another copy. Use "bundle" where supported or change the installed layout; no dependency versions were reselected.`,
			);
		if (!reused && nodes.has(location)) throw unresolved(name);
		if (source.directory) {
			const emitted = emittedBindings.get(source.directory);
			if (emitted && emitted !== location)
				throw unresolved(name);
			emittedBindings.set(source.directory, location);
		}
		reserve(location, key);
		// An absent peer must stay absent even past this package's hoist barrier.
		for (const [peer, expected] of peers) {
			if (expected !== undefined) {
				reserve(packageLocation(location, peer), expected);
				continue;
			}
			let scope = location;
			while (true) {
				const slot = packageLocation(scope, peer);
				if (
					reservations.has(slot) &&
					contexts.get(slot) !== undefined
				)
					throw unresolved(
						peer,
						name,
						metadata.peerDependencies?.[peer],
					);
				reserve(slot, undefined);
				if (!scope) break;
				scope = parentLocation(scope);
			}
		}
		// Protect the whole lookup path, including when reusing an existing node.
		for (const scope of available) {
			reserve(packageLocation(scope, name), key);
			for (const [peer, expected] of peers)
				reserve(packageLocation(scope, peer), expected);
		}
		if (reused) return reused;
		nodes.set(location, {
			source,
			dependency: {
				name,
				...(source.inBundle ? { inBundle: true } : {}),
				...(source.local
					? { localDirectory: source.directory }
					: {}),
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
		const source = await findInstalledPackage(
			appManifestPath,
			name,
		);
		if (!source) throw unresolved(name);
		roots.push(
			await place(name, {
				...source,
				overrides: overrides.forDependency(
					name,
					applicationDependencyRequirement(
						application,
						name,
						developmentFirst(source.directory),
					) ?? source.version,
				).context,
			}),
		);
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
			"hasInstallScript",
			"bin",
			"bundleDependencies",
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
		const dependencies: Record<string, string> =
			Object.fromEntries(
				(metadata.bundleDependencies ?? []).flatMap((name) =>
					metadata.dependencies?.[name] === undefined
						? []
						: [[name, metadata.dependencies[name]]],
				),
			);
		const optionalDependencies: Record<string, string> = {};
		const peerDependencies = { ...metadata.peerDependencies };
		for (const {
			name,
			source: child,
			optional,
			peer,
		} of children) {
			const childLocation = await place(
				name,
				child,
				peer && !source.directory
					? parentLocation(location)
					: location,
			);
			node.edges.push({ location: childLocation, optional });
			if (!peer || source.directory)
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

/** Only real descendants can retain a location owned by the containing tarball. */
function bundleRelativePath(
	root: string,
	directory: string,
): string | undefined {
	const path = relative(root, directory);
	return path &&
		path !== ".." &&
		!path.startsWith(`..${sep}`) &&
		!isAbsolute(path)
		? path
		: undefined;
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
		for (const filename of [
			"npm-shrinkwrap.json",
			"package-lock.json",
		]) {
			const lock = await readJsonFile<LocalLock>(
				join(directory, filename),
			);
			if (lock) return { ...lock, directory };
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}
