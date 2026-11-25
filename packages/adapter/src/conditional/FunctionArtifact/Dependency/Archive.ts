import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import pack from "libnpmpack";
import semver from "semver";
import { glob } from "tinyglobby";

import {
	getStaticString,
	isSyntaxNode,
	parseModule,
	staticLocalAssetReference,
	readIdentifierBindings,
	staticModuleReference,
	visitSyntax,
	type SyntaxNode,
} from "../../../.emittedModules.ts";
import type { PlannedFile } from "../.types.ts";
import {
	commonJsDirectoryRequest,
	commonJsExtensions,
	readRuntimeRequireBindings,
	type PackageSubpathRequests,
} from "./ImportSpecifier.ts";
import type { ResolvedRuntimeDependency } from "./Metadata.ts";
import {
	readInstalledBindingPath,
	stripJsonBom,
} from "./Source.ts";
import type { RegistryVersionMetadata } from "./Registry.ts";

/** Reads npm's gzip-compressed tar entries in memory without extracting paths. */
function packedFiles(bytes: Buffer): Map<string, Buffer> {
	const tar = gunzipSync(bytes);
	const files = new Map<string, Buffer>();
	const readString = (field: Buffer) =>
		field.toString("utf8").replace(/\0.*$/s, "");
	let nextPath: string | undefined;
	// npm applies a PAX size record to the following entry, as it does a path.
	let nextSize: number | undefined;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return files;
		const sizeField = readString(
			header.subarray(124, 136),
		).trim();
		const size =
			nextSize ??
			(/^[0-7]+$/.test(sizeField)
				? Number.parseInt(sizeField, 8)
				: NaN);
		nextSize = undefined;
		const start = offset + 512;
		if (!Number.isSafeInteger(size) || start + size > tar.length)
			throw new Error("Invalid npm tarball entry size.");
		const contents = tar.subarray(start, start + size);
		offset = start + Math.ceil(size / 512) * 512;
		const type = header[156];
		if (type === 120 || type === 88) {
			// POSIX extended path metadata
			for (let i = 0; i < contents.length;) {
				const space = contents.indexOf(32, i);
				const length =
					space > i
						? Number(contents.toString("ascii", i, space))
						: NaN;
				if (
					!Number.isSafeInteger(length) ||
					length <= space - i + 1 ||
					i + length > contents.length
				)
					throw new Error("Invalid npm tarball path metadata.");
				const field = contents.toString(
					"utf8",
					space + 1,
					i + length - 1,
				);
				if (field.startsWith("path=")) nextPath = field.slice(5);
				if (field.startsWith("size=")) {
					const value = field.slice(5);
					nextSize = /^\d+$/.test(value) ? Number(value) : NaN;
				}
				i += length;
			}
			continue;
		}
		if (type === 76) {
			// GNU long name
			nextPath = readString(contents);
			continue;
		}
		const prefix = readString(header.subarray(345, 500));
		const name =
			nextPath ??
			[prefix, readString(header.subarray(0, 100))]
				.filter(Boolean)
				.join("/");
		nextPath = undefined;
		if (
			(type === 48 || type === 0) &&
			name.startsWith("package/")
		)
			files.set(name.slice("package/".length), contents);
	}
	throw new Error("Invalid npm tarball end marker.");
}

type ArchiveLookup =
	"exact" | "import" | "commonjs" | "directory" | "asset";
type ArchiveRequest = { target: string; lookup: ArchiveLookup };
type LoaderMode = keyof typeof nodeConditions;

// The Function Artifact uses Node's default runtime loader conditions.
const nodeConditions = {
	import: new Set([
		"node",
		"node-addons",
		"module-sync",
		"import",
	]),
	require: new Set([
		"node",
		"node-addons",
		"module-sync",
		"require",
	]),
};

const unexported = Symbol("unexported package subpath");
const invalidCapture = Symbol("invalid package subpath capture");
type ExternalPackageTarget = {
	specifier: string;
	binding?: string;
	request?: ArchiveRequest;
	missing?: boolean;
};
type PackageTarget =
	| URL
	| string
	| ExternalPackageTarget
	| false
	| typeof unexported
	| typeof invalidCapture;

async function selectedPackageTarget(
	target: unknown,
	conditions: ReadonlySet<string>,
	resolveTarget: (
		value: string,
	) => PackageTarget | Promise<PackageTarget>,
): Promise<PackageTarget | null | undefined> {
	if (target === null) return null;
	if (typeof target === "string") return resolveTarget(target);
	if (Array.isArray(target)) {
		let fallback: null | false | undefined = target.length
			? undefined
			: null;
		for (const item of target as unknown[]) {
			const selected = await selectedPackageTarget(
				item,
				conditions,
				resolveTarget,
			);
			if (
				typeof selected === "string" ||
				(selected && typeof selected === "object") ||
				typeof selected === "symbol"
			)
				return selected;
			if (selected !== undefined) fallback = selected;
		}
		return fallback;
	}
	if (!target || typeof target !== "object") return false;
	for (const [key, value] of Object.entries(target)) {
		if (key !== "default" && !conditions.has(key)) continue;
		const selected = await selectedPackageTarget(
			value,
			conditions,
			resolveTarget,
		);
		if (selected !== undefined) return selected;
	}
	return undefined;
}

function invalidPackageSegment(path: string): boolean {
	return path.split(/[/\\]/).some((segment) => {
		try {
			return /^(?:\.{1,2}|node_modules)$/i.test(
				decodeURIComponent(segment),
			);
		} catch (error) {
			if (!(error instanceof URIError)) throw error;
			return false;
		}
	});
}

function packageTarget(
	value: string,
	packageURL: URL,
	capture?: string,
	allowExternal = false,
): PackageTarget {
	if (!value.startsWith("./"))
		return allowExternal &&
			value.length > 0 &&
			!value.startsWith("../") &&
			!value.startsWith("/") &&
			!URL.canParse(value)
			? capture === undefined
				? value
				: value.replaceAll("*", () => capture)
			: false;
	if (invalidPackageSegment(value.slice(2))) return false;
	const target = new URL(value, packageURL);
	if (!target.pathname.startsWith(packageURL.pathname))
		return false;
	// Node's target arrays only catch invalid targets, not invalid subpaths.
	if (capture !== undefined && invalidPackageSegment(capture))
		return invalidCapture;
	return capture === undefined
		? target
		: new URL(target.href.replaceAll("*", () => capture));
}

function packageFilePath(url: URL): string | undefined {
	if (/%2f|%5c/i.test(url.pathname)) return undefined;
	try {
		return fileURLToPath(url);
	} catch (error) {
		if (!(
			error instanceof URIError || error instanceof TypeError
		))
			throw error;
	}
}

function packagePatterns(keys: readonly string[]) {
	return keys
		.flatMap((key) => {
			const match = /^([^*]*)\*([^*]*)$/.exec(key);
			return match
				? [{ key, prefix: match[1]!, suffix: match[2]! }]
				: [];
		})
		.sort(
			(a, b) =>
				b.prefix.length - a.prefix.length ||
				b.key.length - a.key.length,
		);
}

function patternMatches(
	subpath: string,
	{ prefix, suffix }: { prefix: string; suffix: string },
): boolean {
	return (
		subpath.startsWith(prefix) &&
		subpath.endsWith(suffix) &&
		subpath.length > prefix.length + suffix.length
	);
}

async function mappedPackageTarget(
	specifier: string,
	map: Record<string, unknown>,
	packageURL: URL,
	mode: LoaderMode,
	resolveExternal?: (target: string) => Promise<PackageTarget>,
): Promise<PackageTarget | null | undefined> {
	let key = specifier;
	let capture: string | undefined;
	if (
		key.includes("*") ||
		key.endsWith("/") ||
		!Object.hasOwn(map, key)
	) {
		const match = packagePatterns(Object.keys(map)).find(
			(pattern) => patternMatches(specifier, pattern),
		);
		if (!match) return;
		key = match.key;
		capture = specifier.slice(
			match.prefix.length,
			specifier.length - match.suffix.length,
		);
	}
	return selectedPackageTarget(
		map[key],
		nodeConditions[mode],
		(value) => {
			const target = packageTarget(
				value,
				packageURL,
				capture,
				!!resolveExternal,
			);
			return typeof target === "string" && resolveExternal
				? resolveExternal(target)
				: target;
		},
	);
}

function packageExportMap(
	exports: unknown,
): Record<string, unknown> {
	if (
		exports &&
		typeof exports === "object" &&
		!Array.isArray(exports) &&
		Object.keys(exports).some((key) => key.startsWith("."))
	)
		return exports as Record<string, unknown>;
	return { ".": exports };
}

type PackageScope = {
	path: string;
	metadata: Record<string, unknown>;
};

function barePackageName(specifier: string): string | undefined {
	return /^(@[^/\\%]+\/[^/\\%]+|[^@./\\%][^/\\%]*)(?=\/|$)/.exec(
		specifier,
	)?.[1];
}

function commonJsLookup(
	request: string,
): "commonjs" | "directory" {
	return commonJsDirectoryRequest(request)
		? "directory"
		: "commonjs";
}

const ordinaryRequire = Symbol("ordinary CommonJS lookup");

async function resolvePrivateImport(
	specifier: string,
	scope: PackageScope,
	mode: LoaderMode,
	resolveExternal: (
		target: string,
		scope: PackageScope,
		mode: LoaderMode,
	) => Promise<PackageTarget>,
) {
	const { imports, exports, name } = scope.metadata;
	// Without an imports map, require("#name") falls back to ordinary module lookup.
	if (mode === "require" && imports == null)
		return ordinaryRequire;
	if (
		specifier === "#" ||
		specifier.startsWith("#/") ||
		specifier.endsWith("/") ||
		!imports ||
		typeof imports !== "object" ||
		Array.isArray(imports)
	)
		return;
	const packageURL = pathToFileURL(dirname(scope.path) + sep);
	return mappedPackageTarget(
		specifier,
		imports as Record<string, unknown>,
		packageURL,
		mode,
		async (target) => {
			if (isBuiltin(target)) return target;
			if (
				exports == null ||
				typeof name !== "string" ||
				barePackageName(target) !== name
			)
				return resolveExternal(target, scope, mode);
			// Only an invalid self-export lets an enclosing target array try its next item.
			return (
				(await mappedPackageTarget(
					"." + target.slice(name.length),
					packageExportMap(exports),
					packageURL,
					mode,
				)) ?? unexported
			);
		},
	);
}

async function manifestEntrypoints(
	directory: string,
	manifest: Record<string, unknown>,
	requests: ReturnType<PackageSubpathRequests["get"]>,
): Promise<ArchiveRequest[]> {
	const entries = new Map<string, ArchiveLookup>();
	const retained: ArchiveRequest[] = [];
	const packageURL = pathToFileURL(directory + sep);
	const exportMap = packageExportMap(manifest.exports);
	const targets: { match: RegExp; url: URL }[] = [];
	const addExport = (url: URL, key: string) => {
		const file = packageFilePath(url);
		if (!file) return;
		const subpath = url.pathname.slice(
			packageURL.pathname.length,
		);
		if (
			!key.startsWith("./") ||
			key.indexOf("*") === -1 ||
			key.indexOf("*") !== key.lastIndexOf("*") ||
			!subpath.includes("*")
		) {
			entries.set(file, "exact");
			return;
		}
		const parts = subpath
			.split("*")
			.map((part) =>
				decodeURIComponent(part).replace(
					/[.*+?^{}$()|[\]\\]/g,
					"\\$&",
				),
			);
		// All target stars substitute the same (possibly nested) subpath.
		const match = new RegExp(
			"^" +
				parts[0] +
				"([\\s\\S]+?)" +
				parts.slice(1).join("(?:\\1)") +
				"$",
		);
		targets.push({ match, url });
	};
	// Resolve emitted requests directly even if URL normalization hides them from the filename scan.
	for (const [request, modes] of requests ?? []) {
		if (manifest.exports == null && request === ".") continue;
		for (const requestMode of modes) {
			const mode =
				requestMode === "resolveImport" ? "import" : requestMode;
			if (manifest.exports == null && mode === "require") {
				retained.push({
					target: resolve(directory, request),
					lookup: commonJsLookup(request),
				});
				continue;
			}
			const target =
				manifest.exports == null
					? new URL(request, packageURL)
					: await mappedPackageTarget(
							request,
							exportMap,
							packageURL,
							mode,
						);
			const path =
				target instanceof URL && packageFilePath(target);
			// import.meta.resolve returns a URL without loading or reading the file.
			if (path && requestMode !== "resolveImport")
				retained.push({
					target: path,
					lookup: requestMode === "import" ? "import" : "exact",
				});
		}
	}
	if (manifest.exports == null) {
		entries.set(directory, "directory");
	} else {
		for (const [key, target] of Object.entries(exportMap)) {
			const seen = new Set<string>();
			for (const conditions of Object.values(nodeConditions)) {
				const selected = await selectedPackageTarget(
					target,
					conditions,
					(value) => packageTarget(value, packageURL),
				);
				if (
					selected instanceof URL &&
					!seen.has(selected.href)
				) {
					seen.add(selected.href);
					addExport(selected, key);
				}
			}
		}
	}
	const bins =
		typeof manifest.bin === "object" && manifest.bin !== null
			? (Object.values(manifest.bin) as unknown[])
			: [manifest.bin];
	for (const bin of bins)
		if (typeof bin === "string")
			entries.set(join(directory, bin), "commonjs");

	if (targets.length) {
		for (const file of await glob("**/*", {
			cwd: directory,
			dot: true,
			followSymbolicLinks: false,
			ignore: ["**/node_modules/**"],
		})) {
			const path = join(directory, file);
			for (const { match, url } of targets) {
				const capture = match.exec(file)?.[1];
				if (!capture) continue;
				const spelling = capture
					.split("/")
					.map(encodeURIComponent)
					.join("/");
				// Exact and narrower exports only block individual request spellings.
				// URL parsing can normalize other spellings to the same wildcard file.
				const target = new URL(
					url.href.replaceAll("*", () => spelling),
				);
				if (packageFilePath(target) === path)
					entries.set(path, "exact");
			}
		}
	}
	return retained.concat(
		[...entries].map(([target, lookup]) => ({
			target,
			lookup,
		})),
	);
}

function missingPath(error: NodeJS.ErrnoException): boolean {
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function statInstalledPath(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if (!missingPath(error as NodeJS.ErrnoException))
			throw error;
	}
}

type ArchiveVerification = {
	directory: string;
	bytes: Buffer;
	subpaths: ReturnType<PackageSubpathRequests["get"]>;
	pending: ArchiveRequest[];
	visited: Set<string>;
};

/** Stops before publication filtering can turn a statically linked local runtime file into a missing one. */
async function verifyLocalRuntimeFiles(
	{
		directory,
		bytes,
		subpaths,
		pending,
		visited,
	}: ArchiveVerification,
	location: string,
	bindings: ReadonlyMap<string, ResolvedRuntimeDependency>,
	queueDependencyFile: (
		location: string,
		request: ArchiveRequest,
	) => void,
): Promise<void> {
	const files = packedFiles(bytes);
	if (!visited.size) {
		const manifest = JSON.parse(
			stripJsonBom(
				files.get("package.json")?.toString("utf8") ?? "{}",
			),
		) as Record<string, unknown>;
		for (const request of await manifestEntrypoints(
			directory,
			manifest,
			subpaths,
		))
			pending.push(request);
	}
	const archivePath = (
		candidate: string,
	): string | undefined => {
		const path = relative(directory, candidate);
		if (
			!path ||
			path === ".." ||
			path.startsWith(".." + sep) ||
			isAbsolute(path)
		)
			return undefined;
		return path.split(sep).join("/");
	};
	const requirePacked = (candidate: string) => {
		const path = archivePath(candidate)!;
		const contents = files.get(path);
		if (contents === undefined)
			throw new Error(
				`The npm archive of the local runtime package at ${directory} omits ${path}. Include this file in the package.`,
			);
		return contents;
	};
	const findFile = async (candidates: readonly string[]) => {
		for (const candidate of candidates) {
			const path = archivePath(candidate);
			if (!path) continue;
			if (files.has(path)) return candidate;
			if ((await statInstalledPath(candidate))?.isFile())
				return candidate;
		}
	};
	const fileCandidates = (base: string) => [
		base,
		...commonJsExtensions.map((extension) => base + extension),
	];
	const indexCandidates = (base: string) =>
		commonJsExtensions.map((extension) =>
			join(base, "index" + extension),
		);
	const installedManifests = new Map<
		string,
		Promise<Record<string, unknown> | undefined>
	>();
	const installedManifest = (location: string) => {
		let loaded = installedManifests.get(location);
		if (!loaded) {
			loaded = readFile(location, "utf8").then(
				(source) =>
					JSON.parse(stripJsonBom(source)) as
						Record<string, unknown> | undefined,
				(error: NodeJS.ErrnoException) => {
					if (!missingPath(error)) throw error;
					return undefined;
				},
			);
			installedManifests.set(location, loaded);
		}
		return loaded;
	};
	const findDirectoryEntry = async (
		target: string,
		find: (
			candidates: readonly string[],
		) => Promise<string | undefined>,
	) => {
		const manifestPath = join(target, "package.json");
		const main = (await installedManifest(manifestPath))?.main;
		if (typeof main === "string" && main) {
			const entry = resolve(target, main);
			const candidate = await find([
				...fileCandidates(entry),
				...indexCandidates(entry),
			]);
			if (candidate) return { candidate, manifestPath };
		}
		return { candidate: await find(indexCandidates(target)) };
	};
	const resolveExternal = async (
		specifier: string,
		scope: PackageScope,
		mode: LoaderMode,
	): Promise<PackageTarget> => {
		const name = barePackageName(specifier);
		if (!name) return { specifier };
		const binding = await readInstalledBindingPath(
			scope.path,
			name,
		);
		if (!binding) return { specifier };
		const manifest = await installedManifest(
			join(binding, "package.json"),
		);
		const subpath = "." + specifier.slice(name.length);
		const packageURL = pathToFileURL(binding + sep);
		if (manifest?.exports == null && subpath === ".") {
			const { candidate } = await findDirectoryEntry(
				binding,
				async (candidates) => {
					for (const path of candidates)
						if ((await statInstalledPath(path))?.isFile())
							return path;
				},
			);
			return {
				specifier,
				binding,
				missing: candidate === undefined,
				request: candidate
					? { target: binding, lookup: "directory" }
					: undefined,
			};
		}
		// Node resolves private targets using package resolution even in require mode.
		const selected =
			manifest?.exports == null
				? new URL(subpath, packageURL)
				: await mappedPackageTarget(
						subpath,
						packageExportMap(manifest.exports),
						packageURL,
						mode,
					);
		if (!(selected instanceof URL))
			return selected === false || selected === invalidCapture
				? selected
				: unexported;
		const target = packageFilePath(selected);
		const stats =
			target === undefined
				? undefined
				: await statInstalledPath(target);
		// ESM reports a directory-specific error, whereas require reports a missing module.
		const missing =
			target !== undefined &&
			!stats?.isFile() &&
			!(mode === "import" && stats?.isDirectory());
		return {
			specifier,
			binding,
			missing,
			request:
				target && !missing
					? {
							target,
							lookup: mode === "import" ? "import" : "exact",
						}
					: undefined,
		};
	};
	const plannedBinding = (scope: PackageScope, name: string) => {
		// Search the emitted placement tree from the package scope that will survive.
		let owner = posix.join(
			location,
			posix.dirname(archivePath(scope.path)!),
		);
		while (true) {
			const slot = posix.join(owner, "node_modules", name);
			if (bindings.has(slot) || owner === ".")
				return bindings.get(slot);
			owner = posix.dirname(owner);
		}
	};
	function* scopeManifests(candidate: string) {
		for (
			let scope = dirname(candidate);
			scope === directory || archivePath(scope);
			scope = dirname(scope)
		) {
			if (
				scope !== directory &&
				basename(scope) === "node_modules"
			)
				break;
			yield join(scope, "package.json");
			if (scope === directory) break;
		}
	}
	const sourceScope = async (candidate: string) => {
		for (const path of scopeManifests(candidate)) {
			const metadata = await installedManifest(path);
			if (metadata) return { path, metadata };
		}
	};
	const archivedManifests = new Map<
		string,
		Record<string, unknown>
	>();
	const archivedScope = (candidate: string) => {
		for (const path of scopeManifests(candidate)) {
			const packed = files.get(archivePath(path)!);
			if (!packed) continue;
			let metadata = archivedManifests.get(path);
			if (!metadata) {
				metadata = JSON.parse(
					stripJsonBom(packed.toString("utf8")),
				) as Record<string, unknown>;
				archivedManifests.set(path, metadata);
			}
			return { path, metadata };
		}
	};
	const moduleType = (metadata?: Record<string, unknown>) =>
		metadata?.type === "module" || metadata?.type === "commonjs"
			? metadata.type
			: undefined;
	const selectedModuleType = async (candidate: string) => {
		const installed = await sourceScope(candidate);
		const type = moduleType(installed?.metadata);
		if (
			installed &&
			type !== moduleType(archivedScope(candidate)?.metadata)
		)
			requirePacked(installed.path);
		return type;
	};
	const targetIdentity = (
		target: Awaited<ReturnType<typeof resolvePrivateImport>>,
	) => {
		if (target instanceof URL) return target.href;
		if (target && typeof target === "object")
			return JSON.stringify(target);
		return target ?? null;
	};
	while (pending.length) {
		const { target, lookup } = pending.pop()!;
		const key = JSON.stringify([target, lookup]);
		if (visited.has(key)) continue;
		visited.add(key);
		if (
			(lookup === "import" ||
				lookup === "exact" ||
				lookup === "commonjs") &&
			target !== directory &&
			!archivePath(target) &&
			!target.split(sep).includes("node_modules")
		) {
			for (const outside of lookup === "commonjs"
				? fileCandidates(target)
				: [target])
				if ((await statInstalledPath(outside))?.isFile())
					throw new Error(
						`The local runtime package at ${directory} loads ${outside}, which is outside the package and absent from its npm archive. Move the file into the package or depend on its own package.`,
					);
			continue;
		}
		let candidate =
			lookup === "directory"
				? undefined
				: await findFile(
						lookup === "commonjs"
							? fileCandidates(target)
							: [target],
					);
		let directoryManifest: string | undefined;
		if (
			!candidate &&
			(lookup === "commonjs" || lookup === "directory") &&
			(target === directory || archivePath(target))
		) {
			const entry = await findDirectoryEntry(target, findFile);
			candidate = entry.candidate;
			directoryManifest = entry.manifestPath;
		}
		if (!candidate) {
			if (
				lookup === "import" &&
				(await statInstalledPath(target))?.isDirectory() &&
				resolve(target) !== resolve(directory)
			) {
				const relativeTarget = archivePath(target);
				if (
					!relativeTarget ||
					![...files.keys()].some((path) =>
						path.startsWith(relativeTarget + "/"),
					)
				)
					throw new Error(
						`The npm archive of the local runtime package at ${directory} omits directory ${relativeTarget ?? target}. Include a file in this directory to preserve Node's directory import error.`,
					);
			}
			continue;
		}
		const contents = requirePacked(candidate);
		if (lookup === "asset") continue;
		if (directoryManifest) requirePacked(directoryManifest);
		const extension = extname(candidate);
		// The CommonJS loader runs a file with an unregistered extension as JavaScript.
		const unregistered =
			lookup === "commonjs" &&
			![".js", ".mjs", ".cjs", ".json", ".node", ""].includes(
				extension,
			);
		if (
			!unregistered &&
			!["", ".js", ".mjs", ".cjs"].includes(extension)
		)
			continue;
		const format =
			extension === ".mjs"
				? "module"
				: extension === ".cjs"
					? "commonjs"
					: // The CommonJS loader applies a package type only to .js files.
						unregistered ||
						  (lookup === "commonjs" && extension === "")
						? undefined
						: await selectedModuleType(candidate);
		const source = contents.toString("utf8");
		let syntax: SyntaxNode;
		try {
			try {
				syntax = parseModule(source, format ?? "commonjs");
			} catch (error) {
				if (format || !(error instanceof SyntaxError))
					throw error;
				syntax = parseModule(source);
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			continue;
		}
		const url = pathToFileURL(candidate);
		const addLocalReference = (
			reference: string,
			lookup: "import" | "asset",
		) => {
			try {
				const path = packageFilePath(new URL(reference, url));
				if (path) pending.push({ target: path, lookup });
			} catch (error) {
				if (!(
					error instanceof URIError || error instanceof TypeError
				))
					throw error;
			}
		};
		const privateImports: {
			specifier: string;
			mode: keyof typeof nodeConditions;
		}[] = [];
		let isRuntimeRequire:
			ReturnType<typeof readRuntimeRequireBindings> | undefined;
		let bindingOf:
			ReturnType<typeof readIdentifierBindings> | undefined;
		visitSyntax(syntax, (node) => {
			const module = staticModuleReference(node);
			if (module?.startsWith("."))
				addLocalReference(module, "import");
			if (module?.startsWith("#"))
				privateImports.push({
					specifier: module,
					mode: "import",
				});
			bindingOf ??= readIdentifierBindings(syntax);
			const asset = staticLocalAssetReference(node, bindingOf);
			if (asset !== undefined) addLocalReference(asset, "asset");
			if (
				node.type !== "CallExpression" ||
				!isSyntaxNode(node.callee) ||
				node.callee.name !== "require" ||
				!Array.isArray(node.arguments)
			)
				return;
			const reference = getStaticString(node.arguments[0]);
			if (
				reference === undefined ||
				!(reference.startsWith(".") || reference.startsWith("#"))
			)
				return;
			isRuntimeRequire ??= readRuntimeRequireBindings(
				syntax,
				syntax.sourceType === "script",
			);
			if (!isRuntimeRequire(node.callee)) return;
			if (reference.startsWith("#")) {
				privateImports.push({
					specifier: reference,
					mode: "require",
				});
			} else if (
				reference === "." ||
				reference === ".." ||
				reference.startsWith("./") ||
				reference.startsWith("../")
			) {
				pending.push({
					target: resolve(dirname(candidate), reference),
					lookup: commonJsLookup(reference),
				});
			}
		});
		if (privateImports.length) {
			const scope = await sourceScope(candidate);
			if (!scope) continue;
			const archived = archivedScope(candidate);
			for (const { specifier, mode } of privateImports) {
				const selected = await resolvePrivateImport(
					specifier,
					scope,
					mode,
					resolveExternal,
				);
				const packed =
					archived &&
					(await resolvePrivateImport(
						specifier,
						archived,
						mode,
						resolveExternal,
					));
				if (targetIdentity(selected) !== targetIdentity(packed))
					requirePacked(scope.path);
				if (selected instanceof URL) {
					const path = packageFilePath(selected);
					if (path)
						pending.push({
							target: path,
							lookup: mode === "import" ? "import" : "exact",
						});
				} else if (selected && typeof selected === "object") {
					const {
						specifier: target,
						binding,
						request,
					} = selected;
					const name = barePackageName(target);
					if (!name)
						throw new Error(
							`Cannot verify private dependency ${target} in ${scope.path}.`,
						);
					const planned = plannedBinding(
						archived ?? scope,
						name,
					);
					if (selected.missing && !planned) continue;
					const bundledManifest =
						binding &&
						archivePath(join(binding, "package.json"));
					const bundled =
						!!bundledManifest && files.has(bundledManifest);
					if (
						binding
							? planned?.installedDirectory !== binding &&
								!bundled
							: archived?.path !== scope.path
					)
						throw new Error(
							`The Function Artifact cannot preserve private dependency "${name}" from ${scope.path}. Declare it as a runtime dependency.`,
						);
					if (
						request &&
						planned?.localDirectory &&
						planned.localDirectory === binding
					)
						queueDependencyFile(planned.location, request);
					else if (request && bundled) pending.push(request);
				}
			}
		}
	}
}

/** Lists required peers of the bundled tree that its tarball does not provide. */
export function externalBundledPeers(
	bytes: Buffer,
	integrity?: string,
) {
	if (integrity) {
		const expected = integrity.split(/\s+/).some((token) => {
			const match =
				/^(sha1|sha256|sha384|sha512)-([^?]+)(?:\?.*)?$/.exec(
					token,
				);
			return (
				match &&
				createHash(match[1]!).update(bytes).digest("base64") ===
					match[2]
			);
		});
		if (!expected)
			throw new Error(
				"Integrity mismatch inspecting the bundled npm tarball.",
			);
	}
	const manifests = new Map<string, RegistryVersionMetadata>();
	for (const [name, contents] of packedFiles(bytes))
		if (
			/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(
				name,
			)
		)
			manifests.set(
				posix.dirname(name),
				JSON.parse(
					stripJsonBom(contents.toString("utf8")),
				) as RegistryVersionMetadata,
			);
	const required: {
		child: string;
		name: string;
		range: string;
	}[] = [];
	for (const [child, metadata] of manifests)
		for (const [name, range] of Object.entries(
			metadata.peerDependencies ?? {},
		)) {
			if (metadata.peerDependenciesMeta?.[name]?.optional)
				continue;
			let scope = child;
			let version: string | undefined;
			while (true) {
				version = manifests.get(
					posix.join(scope, "node_modules", name),
				)?.version;
				if (version || scope === ".") break;
				scope = posix.dirname(scope);
			}
			if (
				version &&
				range !== "*" &&
				!semver.satisfies(version, range)
			)
				throw new Error(
					`Bundled ${child} requires ${name}@${range}, but its archive supplies ${version}.`,
				);
			if (!version) required.push({ child, name, range });
		}
	return required;
}

/** Packs exact local package files without lifecycle scripts or artifact writes. */
export async function planLocalArchives(
	graph: ResolvedRuntimeDependency[],
	requests: PackageSubpathRequests,
): Promise<{
	dependencies: ResolvedRuntimeDependency[];
	files: PlannedFile[];
}> {
	const files = new Map<string, PlannedFile>();
	const packed = new Map<
		string,
		{
			resolved: string;
			integrity: string;
			bytes: Buffer;
		}
	>();
	const verification = new Map<string, ArchiveVerification>();
	const dependencies: ResolvedRuntimeDependency[] = [];
	const bindings = new Map(
		graph.map((dependency) => [dependency.location, dependency]),
	);
	for (const dependency of graph) {
		if (!dependency.localDirectory) {
			dependencies.push(dependency);
			continue;
		}
		let archive = packed.get(dependency.localDirectory);
		if (!archive) {
			const bytes = await pack(dependency.localDirectory, {
				ignoreScripts: true,
			});
			const path = `.yandex/dependencies/${createHash("sha256").update(bytes).digest("hex")}.tgz`;
			files.set(path, { path, binaryContents: bytes });
			archive = {
				resolved: `file:${path}`,
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
				bytes,
			};
			packed.set(dependency.localDirectory, archive);
		}
		const { bytes, resolved, integrity } = archive;
		dependencies.push({ ...dependency, resolved, integrity });
		verification.set(dependency.location, {
			directory: dependency.localDirectory,
			bytes,
			subpaths:
				dependency.location === `node_modules/${dependency.name}`
					? requests.get(dependency.name)
					: undefined,
			pending: [],
			visited: new Set(),
		});
	}
	const work = new Set(verification.keys());
	const queueDependencyFile = (
		location: string,
		request: ArchiveRequest,
	) => {
		const archive = verification.get(location)!;
		archive.pending.push(request);
		work.add(location);
	};
	// Private targets can add requests to an archive already visited in graph order.
	for (const location of work) {
		work.delete(location);
		await verifyLocalRuntimeFiles(
			verification.get(location)!,
			location,
			bindings,
			queueDependencyFile,
		);
	}
	return { dependencies, files: [...files.values()] };
}
