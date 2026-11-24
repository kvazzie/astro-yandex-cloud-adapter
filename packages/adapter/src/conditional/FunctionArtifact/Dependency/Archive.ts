import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
	staticModuleReference,
	visitSyntax,
	type SyntaxNode,
} from "../../../.emittedModules.ts";
import type { PlannedFile } from "../.types.ts";
import { readRuntimeRequireBindings } from "./ImportSpecifier.ts";
import type { ResolvedRuntimeDependency } from "./Metadata.ts";
import type { RegistryVersionMetadata } from "./Registry.ts";

/** Reads npm's gzip-compressed tar entries in memory without extracting paths. */
function packedFiles(bytes: Buffer): Map<string, Buffer> {
	const tar = gunzipSync(bytes);
	const files = new Map<string, Buffer>();
	const readString = (field: Buffer) =>
		field.toString("utf8").replace(/\0.*$/s, "");
	let nextPath: string | undefined;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return files;
		const sizeField = readString(
			header.subarray(124, 136),
		).trim();
		const size = /^[0-7]+$/.test(sizeField)
			? Number.parseInt(sizeField, 8)
			: NaN;
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
	"exact" | "commonjs" | "directory" | "asset";
type ArchiveRequest = { target: string; lookup: ArchiveLookup };

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

type PackageTarget = URL | string | false;

function selectedPackageTarget(
	target: unknown,
	conditions: ReadonlySet<string>,
	resolveTarget: (value: string) => PackageTarget,
): PackageTarget | null | undefined {
	if (target === null) return null;
	if (typeof target === "string") return resolveTarget(target);
	if (Array.isArray(target)) {
		let fallback: null | false | undefined = target.length
			? undefined
			: null;
		for (const item of target as unknown[]) {
			const selected = selectedPackageTarget(
				item,
				conditions,
				resolveTarget,
			);
			if (
				selected instanceof URL ||
				typeof selected === "string"
			)
				return selected;
			if (selected !== undefined) fallback = selected;
		}
		return fallback;
	}
	if (!target || typeof target !== "object") return false;
	for (const [key, value] of Object.entries(target)) {
		if (key !== "default" && !conditions.has(key)) continue;
		const selected = selectedPackageTarget(
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
	if (
		invalidPackageSegment(value.slice(2)) ||
		(capture !== undefined && invalidPackageSegment(capture))
	)
		return false;
	const target = new URL(value, packageURL);
	if (!target.pathname.startsWith(packageURL.pathname))
		return false;
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

function resolvePrivateImport(
	specifier: string,
	imports: unknown,
	packageURL: URL,
	mode: keyof typeof nodeConditions,
) {
	if (
		specifier === "#" ||
		specifier.startsWith("#/") ||
		specifier.endsWith("/") ||
		!imports ||
		typeof imports !== "object" ||
		Array.isArray(imports)
	)
		return;
	const map = imports as Record<string, unknown>;
	let key = specifier;
	let capture: string | undefined;
	if (key.includes("*") || !Object.hasOwn(map, key)) {
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
		(value) => packageTarget(value, packageURL, capture, true),
	);
}

async function manifestEntrypoints(
	directory: string,
	manifest: Record<string, unknown>,
): Promise<ArchiveRequest[]> {
	const entries = new Map<string, ArchiveLookup>();
	const packageURL = pathToFileURL(directory + sep);
	const exportMap =
		manifest.exports &&
		typeof manifest.exports === "object" &&
		!Array.isArray(manifest.exports) &&
		Object.keys(manifest.exports).some((key) =>
			key.startsWith("."),
		)
			? Object.entries(manifest.exports)
			: [[".", manifest.exports] as const];
	const patterns = packagePatterns(
		exportMap
			.map(([key]) => key)
			.filter((key) => key.startsWith("./")),
	);
	const exactExports = new Set(exportMap.map(([key]) => key));
	const targets: { key: string; match: RegExp; url: URL }[] = [];
	const addExport = (url: URL, key: string) => {
		const file = packageFilePath(url);
		if (!file) return;
		const subpath = url.pathname.slice(
			packageURL.pathname.length,
		);
		if (
			!patterns.some((pattern) => pattern.key === key) ||
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
		targets.push({ key, match, url });
	};
	if (
		manifest.exports === undefined ||
		manifest.exports === null
	) {
		entries.set(directory, "directory");
	} else {
		for (const [key, target] of exportMap) {
			const seen = new Set<string>();
			for (const conditions of Object.values(nodeConditions)) {
				const selected = selectedPackageTarget(
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
			for (const { key, match, url } of targets) {
				const capture = match.exec(file)?.[1];
				if (!capture) continue;
				const encoded = capture
					.split("/")
					.map(encodeURIComponent)
					.join("/");
				for (const spelling of new Set([capture, encoded])) {
					const subpath = key.replace("*", () => spelling);
					if (exactExports.has(subpath)) continue;
					const selected = patterns.find((pattern) =>
						patternMatches(subpath, pattern),
					);
					if (selected?.key !== key) continue;
					const target = new URL(
						url.href.replaceAll("*", () => spelling),
					);
					if (packageFilePath(target) === path)
						entries.set(path, "exact");
				}
			}
		}
	}
	return [...entries].map(([target, lookup]) => ({
		target,
		lookup,
	}));
}

const commonJsExtensions = [".js", ".json", ".node"];

function missingPath(error: NodeJS.ErrnoException): boolean {
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** Stops before publication filtering can turn a statically linked local runtime file into a missing one. */
async function verifyLocalRuntimeFiles(
	directory: string,
	bytes: Buffer,
): Promise<void> {
	const files = packedFiles(bytes);
	const manifest = JSON.parse(
		files.get("package.json")?.toString("utf8") ?? "{}",
	) as Record<string, unknown>;
	const pending = await manifestEntrypoints(directory, manifest);
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
			const exists = await stat(candidate).then(
				(file) => file.isFile(),
				(error: NodeJS.ErrnoException) => {
					if (missingPath(error)) return false;
					throw error;
				},
			);
			if (exists) return candidate;
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
					JSON.parse(source) as
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
				metadata = JSON.parse(packed.toString("utf8")) as Record<
					string,
					unknown
				>;
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
		target: ReturnType<typeof resolvePrivateImport>,
	) => (target instanceof URL ? target.href : (target ?? null));
	const visited = new Set<string>();
	while (pending.length) {
		const { target, lookup } = pending.pop()!;
		const key = JSON.stringify([target, lookup]);
		if (visited.has(key)) continue;
		visited.add(key);
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
			const manifestPath = join(target, "package.json");
			const main = (await installedManifest(manifestPath))?.main;
			if (typeof main === "string" && main) {
				const entry = resolve(target, main);
				candidate = await findFile([
					...fileCandidates(entry),
					...indexCandidates(entry),
				]);
				if (candidate) directoryManifest = manifestPath;
			}
			candidate ??= await findFile(indexCandidates(target));
		}
		if (!candidate) continue;
		const contents = requirePacked(candidate);
		if (lookup === "asset") continue;
		if (directoryManifest) requirePacked(directoryManifest);
		const extension = extname(candidate);
		if (!["", ".js", ".mjs", ".cjs"].includes(extension))
			continue;
		const format =
			extension === ".mjs"
				? "module"
				: extension === ".cjs"
					? "commonjs"
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
			lookup: "exact" | "asset",
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
		visitSyntax(syntax, (node) => {
			const module = staticModuleReference(node);
			if (module?.startsWith("."))
				addLocalReference(module, "exact");
			if (module?.startsWith("#"))
				privateImports.push({
					specifier: module,
					mode: "import",
				});
			const asset = staticLocalAssetReference(node);
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
					lookup: /(?:\/(?:\.{1,2})?|^\.{1,2})$/.test(reference)
						? "directory"
						: "commonjs",
				});
			}
		});
		if (privateImports.length) {
			const scope = await sourceScope(candidate);
			if (!scope) continue;
			const archived = archivedScope(candidate);
			const packageURL = pathToFileURL(
				dirname(scope.path) + sep,
			);
			const archivedURL =
				archived && pathToFileURL(dirname(archived.path) + sep);
			for (const { specifier, mode } of privateImports) {
				const selected = resolvePrivateImport(
					specifier,
					scope.metadata.imports,
					packageURL,
					mode,
				);
				const packed =
					archivedURL &&
					resolvePrivateImport(
						specifier,
						archived?.metadata.imports,
						archivedURL,
						mode,
					);
				if (targetIdentity(selected) !== targetIdentity(packed))
					requirePacked(scope.path);
				if (selected instanceof URL) {
					const path = packageFilePath(selected);
					if (path)
						pending.push({ target: path, lookup: "exact" });
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
					contents.toString("utf8"),
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
): Promise<{
	dependencies: ResolvedRuntimeDependency[];
	files: PlannedFile[];
}> {
	const files = new Map<string, PlannedFile>();
	const packed = new Map<
		string,
		{ resolved: string; integrity: string }
	>();
	const dependencies: ResolvedRuntimeDependency[] = [];
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
			await verifyLocalRuntimeFiles(
				dependency.localDirectory,
				bytes,
			);
			const path = `.yandex/dependencies/${createHash("sha256").update(bytes).digest("hex")}.tgz`;
			files.set(path, { path, binaryContents: bytes });
			archive = {
				resolved: `file:${path}`,
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
			};
			packed.set(dependency.localDirectory, archive);
		}
		dependencies.push({ ...dependency, ...archive });
	}
	return { dependencies, files: [...files.values()] };
}
