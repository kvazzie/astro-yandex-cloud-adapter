import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	basename,
	dirname,
	join,
	relative,
	isAbsolute,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { PackageJson } from "pkg-types";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import {
	type ApplicationOverrides,
	applicationDependencyRequirement,
} from "./.overrides.ts";
import {
	isRegistryAlias,
	normalizeBundleDependencies,
	parseRegistryRequirement,
} from "./Registry.ts";

export interface InstalledSource {
	version: string;
	registryName?: string;
	directory: string;
	location: string;
	local: boolean;
	manifest: PackageJson;
}

export function stripJsonBom(source: string): string {
	return source.replace(/^\uFEFF/, "");
}

const catalogFields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

/** Reads the catalog maps of the nearest pnpm-workspace.yaml above a directory. */
async function readPnpmCatalogs(
	start: string,
): Promise<Map<string, Map<string, string>> | undefined> {
	for (let directory = start; ; directory = dirname(directory)) {
		let source: string | undefined;
		try {
			source = await readFile(
				join(directory, "pnpm-workspace.yaml"),
				"utf8",
			);
		} catch (cause) {
			if (
				!["ENOENT", "ENOTDIR"].includes(
					(cause as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw cause;
		}
		if (source !== undefined) {
			let workspace: unknown;
			try {
				workspace = parseYaml(source);
			} catch (cause) {
				throw new Error(
					`${join(directory, "pnpm-workspace.yaml")} is not valid YAML.`,
					{ cause },
				);
			}
			const record = (value: unknown) =>
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
					? (value as Record<string, unknown>)
					: {};
			// pnpm requires string versions; other entries cannot resolve a requirement.
			const entries = (value: unknown) =>
				new Map(
					Object.entries(record(value)).flatMap(
						([name, version]) =>
							typeof version === "string"
								? [[name, version] as const]
								: [],
					),
				);
			const catalogs = new Map<string, Map<string, string>>();
			const root = record(workspace);
			for (const [name, catalog] of Object.entries(
				record(root.catalogs),
			))
				catalogs.set(name, entries(catalog));
			if (root.catalog !== undefined)
				catalogs.set("default", entries(root.catalog));
			return catalogs;
		}
		if (dirname(directory) === directory) return undefined;
	}
}

/** pnpm replaces catalog: requirements with their workspace catalog entry. */
export async function resolvePnpmCatalogs(
	manifest: PackageJson | undefined,
	path: string,
): Promise<PackageJson | undefined> {
	if (
		!manifest ||
		!catalogFields.some((field) =>
			Object.values(manifest[field] ?? {}).some(
				(value) =>
					typeof value === "string" &&
					value.startsWith("catalog:"),
			),
		)
	)
		return manifest;
	const catalogs = await readPnpmCatalogs(dirname(path));
	if (!catalogs) return manifest;
	const resolved: PackageJson = { ...manifest };
	for (const field of catalogFields) {
		const requirements = manifest[field];
		if (!requirements) continue;
		resolved[field] = Object.fromEntries(
			Object.entries(requirements).map(([name, value]) => [
				name,
				typeof value === "string" && value.startsWith("catalog:")
					? (catalogs
							.get(value.slice("catalog:".length) || "default")
							?.get(name) ?? value)
					: value,
			]),
		);
	}
	return resolved;
}

async function readManifest(
	path: string,
): Promise<PackageJson | undefined> {
	try {
		return await resolvePnpmCatalogs(
			JSON.parse(
				stripJsonBom(await readFile(path, "utf8")),
			) as PackageJson,
			path,
		);
	} catch (cause) {
		if (
			["ENOENT", "ENOTDIR"].includes(
				(cause as NodeJS.ErrnoException).code ?? "",
			)
		)
			return undefined;
		throw new Error(
			`Cannot read dependency metadata at ${path}.`,
			{ cause },
		);
	}
}

/** Inspects a placement constraint without selecting or validating runtime package contents. */
export async function readInstalledBindingPath(
	base: URL | string,
	name: string,
): Promise<string | undefined> {
	for (const modules of createRequire(base).resolve.paths(
		`${name}/package.json`,
	) ?? []) {
		try {
			const candidate = await realpath(join(modules, name));
			if ((await stat(candidate)).isDirectory())
				return candidate;
		} catch (cause) {
			if (
				!["ENOENT", "ENOTDIR"].includes(
					(cause as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw cause;
		}
	}
	return undefined;
}

/** Prefer the nearest installation's metadata over the manifest's package manager hint. */
export async function readRootRequirementPrecedence(
	appManifestPath: string,
): Promise<(installedLocation: string) => boolean> {
	const inherited = new Map<string, boolean>();
	for (const modules of createRequire(
		appManifestPath,
	).resolve.paths("package.json") ?? []) {
		for (const [marker, developmentFirst] of [
			[".modules.yaml", false],
			[".package-lock.json", true],
		] as const) {
			try {
				if (!(await stat(join(modules, marker))).isFile())
					continue;
				inherited.set(modules, developmentFirst);
				break;
			} catch (cause) {
				if (
					!["ENOENT", "ENOTDIR"].includes(
						(cause as NodeJS.ErrnoException).code ?? "",
					)
				)
					throw cause;
			}
		}
	}
	return (installedLocation) => {
		for (const [modules, developmentFirst] of inherited) {
			const path = relative(modules, installedLocation);
			if (
				path &&
				path !== ".." &&
				!path.startsWith("../") &&
				!path.startsWith("..\\") &&
				!isAbsolute(path)
			)
				return developmentFirst;
		}
		return true;
	};
}

async function findInstalledManifest(
	base: URL | string,
	name: string,
) {
	for (const modules of createRequire(base).resolve.paths(
		`${name}/package.json`,
	) ?? []) {
		const location = join(modules, name);
		const manifest = await readManifest(
			join(location, "package.json"),
		);
		if (manifest)
			return {
				location,
				manifest,
				directory: await realpath(location),
			};
	}
	return undefined;
}

interface BindingProvenance {
	local: boolean;
	rootRequirements: Record<string, string>;
}

/** Reads installed ownership evidence only; version selection and placement stay in the resolver. */
export async function readInstalledProvenance(
	applicationRoot: URL,
	developmentFirst: (installedLocation: string) => boolean,
	overrides: ApplicationOverrides,
): Promise<ReadonlyMap<string, BindingProvenance>> {
	const applicationDirectory = fileURLToPath(applicationRoot);
	const bindings = new Map<string, BindingProvenance>();
	const visited = new Set<string>();
	const manifests = new Map<
		string,
		Promise<PackageJson | undefined>
	>();
	const visit = async (
		directory: string,
		context: ApplicationOverrides,
		inBundle = false,
		bundleRoot?: string,
		root = false,
	): Promise<void> => {
		const key = JSON.stringify([
			directory,
			context.identity,
			inBundle,
			bundleRoot,
			root,
		]);
		if (visited.has(key)) return;
		visited.add(key);
		let promise = manifests.get(directory);
		if (!promise) {
			promise = readManifest(join(directory, "package.json"));
			manifests.set(directory, promise);
		}
		const manifest = await promise;
		if (!manifest) return;
		const ranges = new Map<
			string,
			{ requested: string; peer: boolean }
		>();
		for (const [name, requested] of Object.entries(
			manifest.peerDependencies ?? {},
		))
			ranges.set(name, { requested, peer: true });
		if (root)
			for (const [name, requested] of Object.entries(
				manifest.devDependencies ?? {},
			))
				ranges.set(name, { requested, peer: false });
		for (const [name, requested] of Object.entries(
			manifest.dependencies ?? {},
		))
			ranges.set(name, { requested, peer: false });
		for (const [name, requested] of Object.entries(
			manifest.optionalDependencies ?? {},
		))
			ranges.set(name, { requested, peer: false });
		const bundled = normalizeBundleDependencies(
			manifest.bundleDependencies ??
				manifest.bundledDependencies,
			manifest.dependencies,
			manifest.optionalDependencies,
		);
		for (const [name, edge] of ranges) {
			if (typeof edge.requested !== "string") continue;
			const installed = await findInstalledManifest(
				join(directory, "package.json"),
				name,
			);
			if (!installed) continue;
			const selected = installed.directory;
			const requested = root
				? applicationDependencyRequirement(
						manifest,
						name,
						developmentFirst(installed.location),
					)
				: edge.requested;
			if (typeof requested !== "string") continue;
			const { peer } = edge;
			const selectedRelative = bundleRoot
				? relative(bundleRoot, selected)
				: undefined;
			const insideBundle =
				selectedRelative !== undefined &&
				!isAbsolute(selectedRelative) &&
				selectedRelative !== ".." &&
				!selectedRelative.startsWith("../") &&
				!selectedRelative.startsWith("..\\");
			const childInBundle =
				!root &&
				!peer &&
				(bundled?.includes(name) === true ||
					(inBundle && insideBundle));
			const override = context.forDependency(name, requested);
			const requirement = childInBundle
				? requested
				: override.spec;
			if (!childInBundle && (!peer || root)) {
				const provenance = bindings.get(selected) ?? {
					local: false,
					rootRequirements: Object.create(null) as Record<
						string,
						string
					>,
				};
				provenance.local ||= parseRuntimeRequirement(
					name,
					requirement,
				).local;
				if (root)
					provenance.rootRequirements[name] = requirement;
				bindings.set(selected, provenance);
			}
			await visit(
				selected,
				override.context,
				childInBundle,
				childInBundle ? (bundleRoot ?? directory) : undefined,
			);
		}
	};
	await visit(
		applicationDirectory,
		overrides,
		false,
		undefined,
		true,
	);
	return bindings;
}

/** Reads installation identity without loading package code or resolving exports. */
export async function inspectInstalledSource(
	base: URL | string,
	name: string,
	runtimeRequirement?: string,
	provenance?: ReadonlyMap<string, BindingProvenance>,
	applicationRoot?: URL,
): Promise<
	| (Omit<InstalledSource, "version"> & { version?: string })
	| undefined
> {
	const ownerPath =
		base instanceof URL ? fileURLToPath(base) : base;
	const owner = await readManifest(ownerPath);
	const isApplication =
		applicationRoot !== undefined &&
		ownerPath ===
			fileURLToPath(new URL("package.json", applicationRoot));
	const requirement =
		owner?.optionalDependencies?.[name] ??
		owner?.dependencies?.[name] ??
		owner?.devDependencies?.[name] ??
		owner?.peerDependencies?.[name];
	const installed = await findInstalledManifest(base, name);
	if (!installed) return undefined;
	const { location, manifest, directory } = installed;

	const binding = provenance?.get(directory);
	const effectiveRequirement =
		runtimeRequirement ??
		(isApplication
			? binding?.rootRequirements[name]
			: undefined) ??
		requirement;
	const parent = dirname(directory);
	const container = basename(parent).startsWith("@")
		? dirname(parent)
		: parent;
	// Registry-managed virtual stores still end in node_modules/name (or @scope/name).
	const local =
		basename(container) !== "node_modules" ||
		(typeof effectiveRequirement === "string" &&
			parseRuntimeRequirement(name, effectiveRequirement)
				.local) ||
		binding?.local === true;
	return {
		version:
			typeof manifest.version === "string" &&
			semver.valid(manifest.version)
				? manifest.version
				: undefined,
		...(manifest.name && manifest.name !== name
			? { registryName: manifest.name }
			: {}),
		directory,
		location,
		local,
		manifest,
	};
}

/** Selects runtime contents only after enforcing exact versions and the local-source boundary. */
export async function readInstalledSource(
	base: URL | string,
	name: string,
	includeLocal = false,
	runtimeRequirement?: string,
	provenance?: ReadonlyMap<string, BindingProvenance>,
	applicationRoot?: URL,
): Promise<InstalledSource | undefined> {
	const source = await inspectInstalledSource(
		base,
		name,
		runtimeRequirement,
		provenance,
		applicationRoot,
	);
	if (!source) return undefined;
	if (!source.version)
		throw new Error(
			`Cannot read an exact version for runtime package "${name}".`,
		);
	if (source.local && !includeLocal)
		throw new Error(
			`The "install" dependency strategy cannot pin the linked local runtime package "${name}" to registry code. Enable includeLocal to deliver its local contents, or install a registry dependency.`,
		);
	return { ...source, version: source.version };
}

/** Local protocols select installed content, never registry versions. */
export function parseRuntimeRequirement(
	name: string,
	value: string,
): { name: string } & (
	| { requirement?: string; local: true }
	| { requirement: string; local: false }
) {
	if (/^(file|link):/.test(value)) return { name, local: true };
	if (value.startsWith("workspace:")) {
		const reference = value.slice("workspace:".length);
		if (["*", "^", "~"].includes(reference))
			return { name, local: true };
		if (semver.validRange(reference))
			return { name, requirement: reference, local: true };
		if (reference.startsWith(".")) return { name, local: true };
		const separator = reference.lastIndexOf("@");
		if (
			separator > 0 &&
			semver.validRange(reference.slice(separator + 1))
		)
			return {
				name: reference.slice(0, separator),
				requirement: reference.slice(separator + 1),
				local: true,
			};
		throw new Error(
			`Unsupported workspace requirement for runtime package "${name}": ${value}`,
		);
	}
	if (
		!isRegistryAlias(value) &&
		(/[\\/:]/.test(value) || /\.(?:tgz|tar\.gz)$/i.test(value))
	)
		return { name, local: true };
	return {
		...parseRegistryRequirement(name, value),
		local: false,
	};
}
