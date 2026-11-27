import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, posix } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import pickManifest from "npm-pick-manifest";
import semver from "semver";

import { FUNCTION_NODE_RANGE } from "./Metadata.ts";

// The lowest Node version the Function Artifact supports, for engine checks.
const FUNCTION_NODE_VERSION = semver.minVersion(
	FUNCTION_NODE_RANGE,
)!.version;

/** npm reads the `npm:` alias prefix case-insensitively. */
export function isRegistryAlias(requirement: string): boolean {
	return /^npm:/i.test(requirement);
}

/** Separates npm alias identity from its version requirement. */
export function parseRegistryRequirement(
	name: string,
	requirement: string,
): { name: string; requirement: string } {
	if (!isRegistryAlias(requirement))
		return { name, requirement };
	const target = requirement.slice(4);
	const separator = target.lastIndexOf("@");
	return separator > 0
		? {
				name: target.slice(0, separator),
				requirement: target.slice(separator + 1) || "*",
			}
		: { name: target, requirement: "*" };
}

/** Checks a provider against a dependency range, following an npm alias to its target. */
export function satisfiesRequirement(
	slot: string,
	range: string,
	provider: { name?: string; version: string },
): boolean {
	const target = parseRegistryRequirement(slot, range);
	if (
		isRegistryAlias(range) &&
		(provider.name ?? slot) !== target.name
	)
		return false;
	return (
		target.requirement === "*" ||
		semver.satisfies(provider.version, target.requirement)
	);
}

/** npm tags are non-range strings that need no URL escaping. */
export function isRegistryTag(requirement: string): boolean {
	return (
		requirement.length > 0 &&
		semver.validRange(requirement) === null &&
		encodeURIComponent(requirement) === requirement
	);
}

export function hasInstallLifecycleScripts(
	scripts: Record<string, string | undefined> | undefined,
): boolean {
	return ["preinstall", "install", "postinstall"].some((name) =>
		Boolean(scripts?.[name]),
	);
}

/** Normalizes npm's string/map/legacy-array executable declarations to portable paths. */
export function normalizePackageBin(
	packageName: string,
	bin: unknown,
): Record<string, string> | undefined {
	const entries: Array<[string, unknown]> =
		typeof bin === "string"
			? [[packageName, bin]]
			: Array.isArray(bin)
				? bin
						.filter(
							(target): target is string =>
								typeof target === "string",
						)
						.map((target) => [posix.basename(target), target])
				: bin && typeof bin === "object"
					? Object.entries(bin)
					: [];
	const normalized: Record<string, string> = {};
	for (const [name, target] of entries) {
		if (typeof target !== "string") continue;
		const command = posix
			.join("/", posix.basename(name.replace(/[\\:]/g, "/")))
			.slice(1);
		const path = posix
			.join("/", target.replace(/\\/g, "/"))
			.slice(1);
		if (command && path) normalized[command] = path;
	}
	return Object.keys(normalized).length ? normalized : undefined;
}

/** npm accepts both spellings and the all/none boolean forms. */
export function normalizeBundleDependencies(
	value: unknown,
	dependencies: Record<string, string> | undefined,
	optionalDependencies: Record<string, string> | undefined,
): string[] | undefined {
	if (value === undefined) return undefined;
	return [
		...new Set(
			value === true
				? Object.keys({
						...dependencies,
						...optionalDependencies,
					})
				: Array.isArray(value)
					? value.filter(
							(name): name is string => typeof name === "string",
						)
					: [],
		),
	].sort();
}

export interface RegistryVersionMetadata {
	bundleDependencies?: string[];
	bin?: Record<string, string>;
	hasInstallScript?: boolean;
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	resolved?: string;
	integrity?: string;
	license?: string;
	engines?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

export interface Registry {
	/** `appRoot` selects the application's npm configuration, such as its registry and tag. */
	resolve(
		packageName: string,
		version: string,
		appRoot?: URL,
	): Promise<RegistryVersionMetadata>;
}

export const npmRegistry = {
	resolve: fetchRegistryMetadata,
} satisfies Registry;

const runCommand = promisify(execFile);

function runNpm(args: string[], appRoot?: URL) {
	const npmCli = process.env.npm_execpath;
	const windowsCli =
		npmCli && basename(npmCli) === "npm-cli.js"
			? npmCli
			: join(
					dirname(process.execPath),
					"node_modules",
					"npm",
					"bin",
					"npm-cli.js",
				);
	return runCommand(
		process.platform === "win32" ? process.execPath : "npm",
		process.platform === "win32" ? [windowsCli, ...args] : args,
		{
			cwd: appRoot ?? process.cwd(),
			timeout: 30_000,
			maxBuffer: 10 * 1024 * 1024,
			encoding: "utf8",
		},
	);
}

/** Gets the exact optional owner archive with the application's npm registry configuration. */
export async function readRegistryTarball(
	specifier: string,
	appRoot: URL,
): Promise<Buffer> {
	const directory = await mkdtemp(
		join(tmpdir(), "astro-yandex-tarball-"),
	);
	try {
		const { stdout } = await runNpm(
			[
				"pack",
				"--ignore-scripts",
				"--json",
				"--pack-destination",
				directory,
				"--",
				specifier,
			],
			appRoot,
		);
		const [packed] = JSON.parse(stdout) as {
			filename?: string;
		}[];
		if (
			!packed?.filename ||
			basename(packed.filename) !== packed.filename
		)
			throw new Error("Missing npm tarball filename.");
		return await readFile(join(directory, packed.filename));
	} catch {
		// npm diagnostics may include private configuration.
		throw new Error(
			"The install dependency strategy could not inspect a bundled registry tarball.",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Selects a version as npm install does, preferring a compatible, current latest tag. */
function npmSelection(
	packageName: string,
	requirement: string,
	versions: readonly PublishedVersion[],
	defaultTag: string,
): string | undefined {
	const manifests = versions.filter(
		(entry): entry is PublishedVersion & { version: string } =>
			typeof entry.version === "string",
	);
	try {
		return pickManifest(
			{
				name: packageName,
				"dist-tags": manifests.find(
					(entry) => entry["dist-tags"],
				)?.["dist-tags"],
				versions: Object.fromEntries(
					manifests.map((entry) => [entry.version, entry]),
				),
			},
			requirement,
			// Engines are checked against the function runtime, not the build host.
			{ defaultTag, nodeVersion: FUNCTION_NODE_VERSION },
		)?.version;
	} catch {
		return undefined;
	}
}

interface PublishedVersion {
	"dist-tags"?: Record<string, string>;
	deprecated?: string;
	bundleDependencies?: boolean | string[];
	bundledDependencies?: boolean | string[];
	bin?: unknown;
	hasInstallScript?: boolean;
	scripts?: Record<string, string | undefined>;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	dist?: { tarball?: string; integrity?: string };
	license?: unknown;
	engines?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

// npm view repeats packument-wide fields in every row, so range reads keep only these.
const SELECTION_FIELDS = [
	"version",
	"dist-tags",
	"deprecated",
	"engines",
] as const;

/** Resolves exact versions and ranges needed by uninstalled optional packages. */
async function fetchRegistryMetadata(
	packageName: string,
	requirement: string,
	appRoot?: URL,
): Promise<RegistryVersionMetadata> {
	const exact = semver.valid(requirement);
	let version = exact ?? undefined;
	let metadata: PublishedVersion | undefined;
	if (exact) {
		const published = await requestMetadata<
			PublishedVersion | PublishedVersion[]
		>(packageName, requirement, appRoot);
		metadata = [published]
			.flat()
			.find(
				(entry) => !entry.version || entry.version === exact,
			);
	} else {
		version = await selectRegistryVersion(
			packageName,
			requirement,
			appRoot,
		);
		if (version) {
			const published = await requestMetadata<
				PublishedVersion | PublishedVersion[]
			>(packageName, version, appRoot);
			metadata = [published]
				.flat()
				.find((entry) => entry.version === version);
		}
	}
	if (!version || !metadata)
		throw new Error(
			`The "install" dependency strategy cannot resolve ${packageName}@${requirement} to an exact registry version.`,
		);

	return {
		version,
		bin: normalizePackageBin(packageName, metadata.bin),
		bundleDependencies: normalizeBundleDependencies(
			metadata.bundleDependencies ??
				metadata.bundledDependencies,
			metadata.dependencies,
			metadata.optionalDependencies,
		),
		hasInstallScript: hasInstallLifecycleScripts(
			metadata.scripts,
		)
			? true
			: metadata.hasInstallScript,
		dependencies: metadata.dependencies,
		optionalDependencies: metadata.optionalDependencies,
		peerDependencies: metadata.peerDependencies,
		peerDependenciesMeta: metadata.peerDependenciesMeta,
		resolved: metadata.dist?.tarball,
		integrity: metadata.dist?.integrity,
		license: extractLicenseIdentifier(metadata.license),
		engines: metadata.engines,
		os: metadata.os,
		cpu: metadata.cpu,
		libc: metadata.libc,
	};
}

/** Selects a range or tag from selection fields only. */
async function selectRegistryVersion(
	packageName: string,
	requirement: string,
	appRoot?: URL,
): Promise<string | undefined> {
	const read = (request: string) =>
		requestMetadata<unknown>(
			packageName,
			request,
			appRoot,
			SELECTION_FIELDS,
		).then(selectionRows);
	let viewFailure: Error | undefined;
	// npm view name@* fails when the configured tag does not exist; the stable
	// versions read below still give npm's selection.
	let versions = await read(requirement).catch(
		(cause: unknown) => {
			if (requirement !== "*") throw cause;
			viewFailure =
				cause instanceof Error
					? cause
					: new Error(String(cause));
			return [];
		},
	);
	const tag = await configuredTag(appRoot);
	// npm view name@* returns only the configured tag; npm install falls back to the
	// other stable versions when that tag is deprecated or unusable.
	if (requirement === "*") {
		const head = versions.find((entry) => entry["dist-tags"])?.[
			"dist-tags"
		]?.[tag];
		// npm view omits prereleases from >=0.0.0, so a prerelease tag target is
		// requested beside the stable rows; semver collapses ">=0.0.0 || x" to "*".
		const stable = await read(
			head && semver.prerelease(head)
				? `>=0.0.0-0 || ${head}`
				: ">=0.0.0",
		).catch(() => undefined);
		if (stable) {
			// Tags and manifests come from this read alone, never merged with the first.
			const tagged = stable.find(
				(entry) => entry["dist-tags"],
			)?.["dist-tags"]?.[tag];
			if (
				tagged !== undefined &&
				!stable.some((entry) => entry.version === tagged)
			)
				throw new Error(
					`The npm registry changed while the "install" dependency strategy resolved ${packageName}@*. Run the build again.`,
				);
			versions = stable;
		} else if (viewFailure) throw viewFailure;
	}
	return npmSelection(packageName, requirement, versions, tag);
}

/** npm view --json unwraps rows to a bare value when the first row has one field. */
function selectionRows(value: unknown): PublishedVersion[] {
	return [value]
		.flat()
		.map((entry) =>
			typeof entry === "string"
				? { version: entry }
				: (entry as PublishedVersion),
		);
}

/** Reads npm's configured default tag, which npm install prefers for ranges. */
async function configuredTag(appRoot?: URL): Promise<string> {
	try {
		const { stdout } = await runNpm(
			["config", "get", "tag"],
			appRoot,
		);
		return stdout.trim() || "latest";
	} catch {
		return "latest";
	}
}

async function requestMetadata<T>(
	packageName: string,
	requirement: string,
	appRoot?: URL,
	fields: readonly string[] = [],
): Promise<T> {
	try {
		const { stdout } = await runNpm(
			[
				"view",
				"--json",
				"--",
				`${packageName}@${requirement}`,
				...fields,
			],
			appRoot,
		);
		return JSON.parse(stdout) as T;
	} catch {
		// npm's diagnostics may include private configuration; keep credentials out of build errors.
		throw new Error(
			`The "install" dependency strategy cannot resolve the runtime package "${packageName}@${requirement}" from the configured npm registry. Check npm configuration and network access and try again.`,
		);
	}
}

function extractLicenseIdentifier(
	license: unknown,
): string | undefined {
	if (typeof license === "string") return license;
	if (Array.isArray(license)) {
		const types = license
			.map((entry) =>
				typeof entry === "string"
					? entry
					: typeof entry === "object" &&
						  entry !== null &&
						  "type" in entry
						? (entry as { type?: unknown }).type
						: undefined,
			)
			.filter(
				(entry): entry is string => typeof entry === "string",
			);
		return types.length ? types.join(" OR ") : undefined;
	}
	if (
		typeof license === "object" &&
		license !== null &&
		"type" in license
	) {
		const type = (license as { type?: unknown }).type;
		return typeof type === "string" ? type : undefined;
	}
	return undefined;
}
