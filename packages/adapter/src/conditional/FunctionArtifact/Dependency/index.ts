import { createRequire } from "node:module";
import {
	dirname,
	join,
	relative,
	isAbsolute,
	posix,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, realpath } from "node:fs/promises";

import type { PackageJson } from "pkg-types";
import npa from "npm-package-arg";
import semver from "semver";
import { externalBundledPeers } from "./Archive.ts";
import {
	readInstalledSource,
	readInstalledProvenance,
	readInstallationManagers,
	inspectInstalledSource,
	readInstalledBindingPath,
	resolvePnpmCatalogs,
	stripJsonBom,
	parseRuntimeRequirement,
	type InstalledSource,
} from "./Source.ts";

import {
	compareNames,
	exactDependencyVersion,
	type ResolvedRuntimeDependency,
} from "./Metadata.ts";
import {
	isRegistryTag,
	readRegistryTarball,
	hasInstallLifecycleScripts,
	normalizePackageBin,
	normalizeBundleDependencies,
	satisfiesRequirement,
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
	if (directDependencyNames.size === 0) return [];
	const appDirectory = await realpath(fileURLToPath(root));
	const appRoot = pathToFileURL(appDirectory + sep);
	const appManifestPath = join(appDirectory, "package.json");
	const lock = await readLocalLock(appDirectory);
	const application = await resolvePnpmCatalogs(
		await readJsonFile<PackageJson>(appManifestPath),
		appManifestPath,
	);
	const overrideOwner = await readWorkspaceOverrideManifest(
		lock,
		appDirectory,
		application?.name,
	);
	const overrides = new ApplicationOverrides(
		overrideOwner?.manifest ?? application ?? {},
	);
	const overrideDirectory =
		overrideOwner?.directory ?? appDirectory;
	const installationManager =
		await readInstallationManagers(appManifestPath);
	// Prefer the nearest installation's metadata over the manifest's package manager hint.
	const developmentFirst = (location: string) =>
		installationManager(location) !== "pnpm";
	const shrinkwraps = new Map<string, Promise<boolean>>();
	// npm's Node.inShrinkwrap: a tree parent owns or is inside a published shrinkwrap.
	const inPublishedShrinkwrap = async (
		directory: string,
	): Promise<boolean> => {
		const modules = `${sep}node_modules${sep}`;
		const index = directory.lastIndexOf(modules);
		const parent =
			index === -1 ? undefined : directory.slice(0, index);
		if (
			!parent ||
			parent === appDirectory ||
			!parent.includes(modules)
		)
			return false;
		let result = shrinkwraps.get(parent);
		if (!result) {
			result = (async () =>
				(await existingRealPath(
					join(parent, "npm-shrinkwrap.json"),
				)) !== undefined || inPublishedShrinkwrap(parent))();
			shrinkwraps.set(parent, result);
		}
		return result;
	};
	// pnpm never reads package-lock.json, so an npm lock beside its installation is stale.
	const activeLockEntry = (location: string) =>
		lock && installationManager(location) !== "pnpm"
			? lock.packages?.[lockKey(lock, location)]
			: undefined;
	const provenance = await readInstalledProvenance(
		appRoot,
		developmentFirst,
		overrides,
		inPublishedShrinkwrap,
	);
	const findInstalledPackage = async (
		base: string,
		name: string,
		runtimeRequirement?: string,
		compatible?: (candidate: InstalledSource) => boolean,
	) => {
		const installed = await readInstalledSource(
			base,
			name,
			includeLocal,
			runtimeRequirement,
			provenance,
			appRoot,
			compatible,
		);
		if (!installed || installed.local || !lock) return installed;
		const entry = activeLockEntry(installed.location);
		if (
			!entry ||
			!hasLocalLockOrigin(entry) ||
			!(await matchesLockedInstallation(lock, entry, installed))
		)
			return installed;
		if (!includeLocal && (compatible?.(installed) ?? true))
			throw localRuntimeSourceRequired(name);
		return { ...installed, local: true };
	};
	const lockedInstallation = async (
		locked: LockedSelection,
		base: string,
		name: string,
	): Promise<InstalledSource | undefined> => {
		if (!lock || !hasLocalLockOrigin(locked.metadata))
			return undefined;
		const installed = await inspectInstalledSource(
			base,
			name,
			undefined,
			provenance,
			appRoot,
		);
		if (
			!installed?.version ||
			installed.location !== locked.location
		)
			return undefined;
		const source = {
			...installed,
			version: installed.version,
			local: true,
		};
		return (await matchesLockedInstallation(
			lock,
			locked.metadata,
			source,
		))
			? source
			: undefined;
	};
	const selectLockedChild = async (
		locked: LockedSelection,
		childBase: string,
		name: string,
	): Promise<DependencySource> => {
		const { location, metadata } = locked;
		if (hasLocalLockOrigin(metadata)) {
			if (!includeLocal) throw localRuntimeSourceRequired(name);
			const installed = await lockedInstallation(
				locked,
				childBase,
				name,
			);
			if (!installed) throw localRuntimeSourceRequired(name);
			return installed;
		}
		// An installed lock slot is one binding, whichever edge discovers it first.
		const installed = await inspectInstalledSource(
			childBase,
			name,
			undefined,
			provenance,
			appRoot,
		);
		if (
			installed?.version &&
			!installed.local &&
			installed.location === location &&
			installed.version === metadata.version &&
			(installed.registryName ?? name) ===
				(metadata.name ?? name)
		)
			return { ...installed, version: installed.version };
		return {
			version: metadata.version,
			...(metadata.name && metadata.name !== name
				? { registryName: metadata.name }
				: {}),
			metadata,
			lockLocation: location,
		};
	};
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
	const bundlePeers = new Map<
		string,
		Promise<ReturnType<typeof externalBundledPeers>>
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
				// Use the same catalog-aware manifest as source discovery.
				const local = source.directory
					? await resolvePnpmCatalogs(
							await readJsonFile<PackageJson>(
								join(source.directory, "package.json"),
							),
							join(source.directory, "package.json"),
						)
					: undefined;
				const entry = source.directory
					? activeLockEntry(source.directory)
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
								appRoot,
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
									// The repeated lookup below applies the local-source gate once
									// this edge's compatibility is known.
									() => false,
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
					// Like a bundle, npm checks a shrinkwrapped binding against the raw range.
					const shrinkwrapped =
						!inBundle &&
						installed !== undefined &&
						(await inPublishedShrinkwrap(installed.directory));
					const requirement = parseRuntimeRequirement(
						name,
						inBundle || shrinkwrapped ? range : override.spec,
					);
					const compatible = (candidate: {
						version: string;
						registryName?: string;
					}) =>
						(requirement.requirement === undefined ||
							requirement.requirement === "*" ||
							isRegistryTag(requirement.requirement) ||
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
							shrinkwrapped ? range : override.spec,
							compatible,
						);

					if (!inBundle && requirement.local) {
						const selected = await findInstalledPackage(
							childBase,
							name,
							override.spec,
						);
						if (
							!source.directory &&
							selected &&
							!(await ownsLockOnlyLocalChild(
								lock,
								override.useOverrideBase
									? overrideDirectory
									: localDependencyBase(
											lock,
											source,
											packageName,
										),
								name,
								override.spec,
								selected,
							))
						)
							throw unresolved(name, packageName, range, peer);
						installed = selected;
					}
					// An entry that cannot satisfy this edge is not its binding, local or not.
					if (
						locked &&
						!compatible({
							version: locked.metadata.version,
							registryName: locked.metadata.name,
						})
					)
						locked = undefined;
					let child: DependencySource | undefined =
						locked && !requirement.local
							? await selectLockedChild(locked, childBase, name)
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
						throw localRuntimeSourceRequired(name);
					if (child && !compatible(child)) {
						// An installed parent's optional registry edge can still have a
						// contextual lock pin that npm skipped on this platform.
						if (
							(source.directory && !optional) ||
							requirement.local ||
							child.local
						)
							throw unresolved(name, packageName, range);
						child = undefined;
					}
					if (!child) {
						if (peer && optional) continue;
						if (
							requirement.local ||
							(source.directory && !optional)
						)
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
								version: locked.metadata.version,
								registryName: locked.metadata.name,
							})
						)
							locked = undefined;
						if (locked)
							child = await selectLockedChild(
								locked,
								childBase,
								name,
							);
						// npm ci rejects a lock whose package lacks a regular dependency; only
						// optional and peer edges may be absent from a valid lock.
						else if (source.lockLocation && !optional && !peer)
							throw unresolved(name, packageName, range);
						else {
							const childMetadata = await registry.resolve(
								requirement.name,
								requirement.requirement,
								appRoot,
							);
							const version =
								childMetadata.version ??
								semver.valid(requirement.requirement);
							if (!version)
								throw new Error(
									`The "install" dependency strategy cannot pin ${name}@${range} to an exact version.`,
								);
							if (
								!compatible({
									version,
									registryName:
										childMetadata.name ?? requirement.name,
								})
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
							};
						}
					}
					children.push({
						name,
						source: { ...child, overrides: override.context },
						optional,
						peer,
					});
				}
				if (
					!source.directory &&
					metadata.bundleDependencies?.length
				) {
					const specifier =
						metadata.resolved ??
						`${source.registryName ?? packageName}@${source.version}`;
					const key = JSON.stringify([
						specifier,
						metadata.integrity,
					]);
					let required = bundlePeers.get(key);
					if (!required) {
						required = readRegistryTarball(
							specifier,
							appRoot,
						).then((bytes) =>
							externalBundledPeers(bytes, metadata.integrity),
						);
						bundlePeers.set(key, required);
					}
					for (const { child, name, range } of await required) {
						// Node resolves a bundled child's peer to the enclosing owner when the
						// owner is installed under that peer's name.
						if (
							name === packageName &&
							satisfiesRequirement(name, range, {
								name: source.registryName ?? packageName,
								version: source.version,
							})
						)
							continue;
						const provider = children.find(
							(edge) => edge.name === name && !edge.optional,
						);
						if (
							!provider ||
							!satisfiesRequirement(name, range, {
								name: provider.source.registryName ?? name,
								version: provider.source.version,
							})
						)
							throw new Error(
								`The install dependency strategy cannot pin ${packageName}: bundled ${child} needs external peer ${name}@${range}. Declare that peer on the bundle owner or install the owner before building.`,
							);
					}
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
				const base = scope
					? join(
							owner?.directory ??
								owner?.lockLocation ??
								appDirectory,
							"package.json",
						)
					: appManifestPath;
				if (locked) {
					const installed = await lockedInstallation(
						locked,
						base,
						name,
					);
					return installed?.directory ?? locked.location;
				}
				return readInstalledBindingPath(base, name);
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
		// npm's ordinary edge replaces a peer edge of the same name.
		const peers = Object.keys(metadata.peerDependencies ?? {})
			.filter(
				(peer) =>
					metadata.dependencies?.[peer] === undefined &&
					metadata.optionalDependencies?.[peer] === undefined,
			)
			.map((peer) => {
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
				...(includeLocal && source.directory
					? { installedDirectory: source.directory }
					: {}),
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
						developmentFirst(source.location),
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
					metadata.dependencies?.[name] === undefined ||
					metadata.optionalDependencies?.[name] !== undefined
						? []
						: [[name, metadata.dependencies[name]]],
				),
			);
		const optionalDependencies: Record<string, string> =
			Object.fromEntries(
				(metadata.bundleDependencies ?? []).flatMap((name) =>
					metadata.optionalDependencies?.[name] === undefined
						? []
						: [[name, metadata.optionalDependencies[name]]],
				),
			);
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
			if (peer)
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
		return JSON.parse(
			stripJsonBom(await readFile(filePath, "utf8")),
		) as T;
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

type LockedPackage = RegistryVersionMetadata & {
	link?: boolean;
};

interface LocalLock {
	directory: string;
	packages?: Record<string, LockedPackage>;
}

function lockKey(lock: LocalLock, location: string): string {
	return relative(lock.directory, location).replaceAll(
		"\\",
		"/",
	);
}

async function readWorkspaceOverrideManifest(
	lock: LocalLock | undefined,
	applicationDirectory: string,
	name: string | undefined,
): Promise<
	{ manifest: PackageJson; directory: string } | undefined
> {
	if (
		!lock?.packages ||
		!name ||
		lock.directory === applicationDirectory
	)
		return undefined;
	const member = lockKey(lock, applicationDirectory);
	const entry = lock.packages[member];
	const link = lock.packages[`node_modules/${name}`];
	if (
		!entry ||
		(entry.name && entry.name !== name) ||
		!link?.link ||
		link.resolved !== member
	)
		return undefined;
	const owner = await readJsonFile<PackageJson>(
		join(lock.directory, "package.json"),
	);
	const workspaces = owner?.workspaces;
	const patterns = Array.isArray(workspaces)
		? workspaces
		: workspaces?.packages;
	const included: string[] = [];
	let excluded: string[] = [];
	for (const raw of patterns ?? []) {
		if (typeof raw !== "string") continue;
		const negation = raw.match(/^!+/)?.[0].length ?? 0;
		const pattern = raw
			.slice(negation)
			.replaceAll("\\", "/")
			.replace(/^\.?\/+|\/+$/g, "");
		if (!pattern) continue;
		if (negation % 2 === 1) excluded.push(pattern);
		else {
			// npm restores a whole earlier exclusion when a later include matches it.
			excluded = excluded.filter(
				(negative) => !posix.matchesGlob(pattern, negative),
			);
			included.push(pattern);
		}
	}
	const matches =
		!excluded.some((pattern) =>
			posix.matchesGlob(member, pattern),
		) &&
		included.some(
			(pattern) =>
				posix.matchesGlob(member, pattern) &&
				!excluded.some((negative) =>
					posix.matchesGlob(pattern, negative),
				),
		);
	return matches && owner
		? { manifest: owner, directory: lock.directory }
		: undefined;
}

function localRequestPath(
	name: string,
	value: string,
	base: string,
) {
	const spec = /^(link:|workspace:(?=\.))/.test(value)
		? value.replace(/^(link|workspace):/, "file:")
		: value;
	try {
		const request = npa.resolve(name, spec, base);
		if (
			(request.type === "file" ||
				request.type === "directory") &&
			typeof request.fetchSpec === "string"
		)
			return { path: request.fetchSpec, type: request.type };
	} catch {
		// Unrecognized local protocols cannot prove file or directory identity.
	}
	return undefined;
}

async function existingRealPath(
	path: string,
): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch (error) {
		if (
			!["ENOENT", "ENOTDIR"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw error;
		return undefined;
	}
}

function localDependencyBase(
	lock: LocalLock | undefined,
	source: DependencySource,
	name: string,
): string | undefined {
	const located =
		lock && source.metadata?.resolved
			? localRequestPath(
					name,
					source.metadata.resolved,
					lock.directory,
				)
			: undefined;
	return located?.type === "file"
		? dirname(located.path)
		: source.lockLocation;
}

/** Non-registry lock origins, including Git locators, need installed local contents. */
function hasLocalLockOrigin(entry: LockedPackage): boolean {
	return (
		entry.link === true ||
		/^(?:file|link|workspace|git(?:\+[a-z]+)?|github|gitlab|bitbucket|gist):/.test(
			entry.resolved ?? "",
		)
	);
}

function localRuntimeSourceRequired(name: string): Error {
	return new Error(
		`Local runtime package "${name}" requires includeLocal and an installed local source.`,
	);
}

function lockedLinkTarget(
	lock: LocalLock,
	entry: LockedPackage,
) {
	if (!entry.link || !entry.resolved) return undefined;
	const location = resolve(lock.directory, entry.resolved);
	const metadata = lock.packages?.[lockKey(lock, location)];
	if (metadata?.version)
		return { location, metadata, version: metadata.version };
	return undefined;
}

async function matchesLockedInstallation(
	lock: LocalLock,
	entry: LockedPackage,
	installed: InstalledSource,
): Promise<boolean> {
	if (entry.link) {
		const target = lockedLinkTarget(lock, entry);
		return Boolean(
			target &&
			target.version === installed.version &&
			(await existingRealPath(target.location)) ===
				installed.directory &&
			(!target.metadata.name ||
				target.metadata.name === installed.manifest.name),
		);
	}
	return (
		entry.version === installed.version &&
		(!entry.name || entry.name === installed.manifest.name)
	);
}

async function ownsLockOnlyLocalChild(
	lock: LocalLock | undefined,
	specBase: string | undefined,
	name: string,
	requirement: string,
	installed: InstalledSource,
): Promise<boolean> {
	if (!lock) return false;
	const entry =
		lock.packages?.[lockKey(lock, installed.location)];
	if (
		!entry?.resolved ||
		!(await matchesLockedInstallation(lock, entry, installed))
	)
		return false;
	const requested =
		specBase && localRequestPath(name, requirement, specBase);
	if (entry.link)
		return requested
			? requested.type === "directory" &&
					(await existingRealPath(requested.path)) ===
						installed.directory
			: requirement.startsWith("workspace:");
	if (requested)
		return (
			requested.path ===
			localRequestPath(name, entry.resolved, lock.directory)
				?.path
		);
	const git = gitRequest(name, requirement);
	if (git)
		return satisfiesGitRequest(
			git,
			entry.resolved,
			installed.version,
		);
	return (
		!/^(file|link|workspace):/.test(requirement) &&
		entry.resolved === requirement
	);
}

function gitRequest(
	name: string,
	spec: string,
): npa.Result | undefined {
	try {
		const request = npa.resolve(name, spec);
		return request.type === "git" ? request : undefined;
	} catch {
		return undefined;
	}
}

// @types/npm-package-arg omits hosted-git-info's URL builders.
type HostedRepository = {
	ssh(options: { noCommittish: boolean }): string | undefined;
};

/** npm's dep-valid Git check: one repository, the requested commit if exact, and its semver range. */
function satisfiesGitRequest(
	request: npa.Result,
	resolved: string,
	version: string,
): boolean {
	let locked: npa.Result;
	try {
		locked = npa(resolved);
	} catch {
		return false;
	}
	const options = {
		noCommittish: !/^[a-fA-F0-9]{40}$/.test(
			request.gitCommittish ?? "",
		),
	};
	const lockedHost = locked.hosted as
		HostedRepository | undefined;
	const requestedHost = request.hosted as
		HostedRepository | undefined;
	const sameRepository = lockedHost
		? requestedHost?.ssh(options) === lockedHost.ssh(options)
		: locked.fetchSpec === request.fetchSpec;
	return (
		sameRepository &&
		(!request.gitRange ||
			semver.satisfies(version, request.gitRange, {
				loose: true,
			}))
	);
}

interface LockedSelection {
	location: string;
	metadata: LockedPackage & { version: string };
}

function findLockedPackage(
	lock: LocalLock,
	directory: string,
	name: string,
): LockedSelection | undefined {
	for (const modules of createRequire(
		join(directory, "package.json"),
	).resolve.paths(`${name}/package.json`) ?? []) {
		const location = join(modules, name);
		const metadata = lock.packages?.[lockKey(lock, location)];
		if (metadata?.version)
			return {
				location,
				metadata: { ...metadata, version: metadata.version },
			};
		const target = metadata && lockedLinkTarget(lock, metadata);
		if (target)
			return {
				location,
				metadata: {
					...target.metadata,
					...metadata,
					version: target.version,
				},
			};
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
