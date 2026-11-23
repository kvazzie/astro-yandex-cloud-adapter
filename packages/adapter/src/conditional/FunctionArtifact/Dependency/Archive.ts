import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	posix,
	relative,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import pack from "libnpmpack";
import semver from "semver";

import {
	getStaticString,
	isSyntaxNode,
	localModuleReferences,
	parseModule,
	visitSyntax,
} from "../../../.emittedModules.ts";
import type { PlannedFile } from "../.types.ts";
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

function manifestEntrypoints(
	manifest: Record<string, unknown>,
): string[] {
	const entries = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === "string") entries.add(value);
		else if (value && typeof value === "object")
			for (const [condition, target] of Object.entries(value))
				if (condition !== "types") add(target);
	};
	if (manifest.exports === undefined)
		add(manifest.main ?? "index.js");
	add(manifest.exports);
	add(manifest.bin);
	return [...entries];
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
	const pending = manifestEntrypoints(manifest).map((file) => ({
		target: join(directory, file),
		extensionLookup: true,
	}));
	const visited = new Set<string>();
	while (pending.length) {
		const { target, extensionLookup } = pending.pop()!;
		const key = JSON.stringify([target, extensionLookup]);
		if (visited.has(key)) continue;
		visited.add(key);
		for (const candidate of [
			target,
			...(extensionLookup
				? [
						target + ".js",
						target + ".json",
						target + ".node",
						join(target, "index.js"),
					]
				: []),
		]) {
			const path = relative(directory, candidate);
			if (
				!path ||
				path === ".." ||
				path.startsWith(".." + sep) ||
				isAbsolute(path)
			)
				continue;
			const contents = files.get(path.split(sep).join("/"));
			if (contents === undefined) {
				const exists = await stat(candidate).then(
					(file) => file.isFile(),
					(error: NodeJS.ErrnoException) => {
						if (
							error.code === "ENOENT" ||
							error.code === "ENOTDIR"
						)
							return false;
						throw error;
					},
				);
				if (exists)
					throw new Error(
						`The npm archive of the local runtime package at ${directory} omits ${path}. Include this file in the package.`,
					);
				continue;
			}
			if (![".js", ".mjs", ".cjs"].includes(extname(path)))
				break;
			const source = contents.toString("utf8");
			const url = pathToFileURL(candidate);
			try {
				for (const reference of localModuleReferences(source)) {
					try {
						pending.push({
							target: fileURLToPath(new URL(reference, url)),
							extensionLookup: false,
						});
					} catch (error) {
						if (!(
							error instanceof URIError ||
							error instanceof TypeError
						))
							throw error;
					}
				}
				visitSyntax(parseModule(source), (node) => {
					if (
						node.type !== "CallExpression" ||
						!isSyntaxNode(node.callee) ||
						node.callee.name !== "require" ||
						!Array.isArray(node.arguments)
					)
						return;
					const reference = getStaticString(node.arguments[0]);
					if (
						reference?.startsWith("./") ||
						reference?.startsWith("../")
					)
						pending.push({
							target: join(dirname(candidate), reference),
							extensionLookup: true,
						});
				});
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
			}
			break;
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
