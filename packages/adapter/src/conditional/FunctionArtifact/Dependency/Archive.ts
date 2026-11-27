import { createHash } from "node:crypto";
import { isAbsolute, posix, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import pack from "libnpmpack";
import ssri from "ssri";

import type { PlannedFile } from "../.types.ts";
import type { ResolvedRuntimeDependency } from "./Metadata.ts";
import type { RuntimeTrace } from "./Trace.ts";
import { stripJsonBom } from "./Source.ts";
import {
	satisfiesRequirement,
	type RegistryVersionMetadata,
} from "./Registry.ts";

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
		// npm extracts regular ("0", NUL) and contiguous ("7") files; links are not contents.
		if (
			(type === 48 || type === 0 || type === 55) &&
			name.startsWith("package/")
		)
			files.set(name.slice("package/".length), contents);
	}
	throw new Error("Invalid npm tarball end marker.");
}

/** Lists required peers of the bundled tree that its tarball does not provide. */
export function externalBundledPeers(
	bytes: Buffer,
	integrity?: string,
) {
	// npm checks only the strongest listed algorithm, so a weaker match is not enough.
	if (integrity && !ssri.checkData(bytes, integrity))
		throw new Error(
			"Integrity mismatch inspecting the bundled npm tarball.",
		);
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
			let provider: RegistryVersionMetadata | undefined;
			while (true) {
				provider = manifests.get(
					posix.join(scope, "node_modules", name),
				);
				if (provider?.version || scope === ".") break;
				scope = posix.dirname(scope);
			}
			const version = provider?.version;
			if (
				version &&
				!satisfiesRequirement(name, range, {
					name: (provider as { name?: string }).name,
					version,
				})
			)
				throw new Error(
					`Bundled ${child} requires ${name}@${range}, but its archive supplies ${(provider as { name?: string }).name ?? name}@${version}.`,
				);
			if (!version) required.push({ child, name, range });
		}
	return required;
}

/** Packs exact local package files without lifecycle scripts or artifact writes. */
export async function planLocalArchives(
	graph: ResolvedRuntimeDependency[],
	trace: Pick<RuntimeTrace, "files" | "parents">,
): Promise<{
	dependencies: ResolvedRuntimeDependency[];
	files: PlannedFile[];
}> {
	const files = new Map<string, PlannedFile>();
	const packed = new Map<
		string,
		{ resolved: string; integrity: string; bytes: Buffer }
	>();
	const dependencies: ResolvedRuntimeDependency[] = [];
	// Files of other artifact packages are delivered and verified with their own package.
	const packageDirectories = graph.flatMap(
		({ localDirectory, installedDirectory }) =>
			[localDirectory, installedDirectory].filter(
				(directory): directory is string =>
					directory !== undefined,
			),
	);
	for (const dependency of graph) {
		const directory = dependency.localDirectory;
		if (!directory) {
			dependencies.push(dependency);
			continue;
		}
		let archive = packed.get(directory);
		if (!archive) {
			const bytes = await pack(directory, {
				ignoreScripts: true,
			});
			const path = `.yandex/dependencies/${createHash("sha256").update(bytes).digest("hex")}.tgz`;
			files.set(path, { path, binaryContents: bytes });
			archive = {
				resolved: `file:${path}`,
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
				bytes,
			};
			packed.set(directory, archive);
			await verifyTracedFilesArePacked(
				directory,
				bytes,
				trace,
				packageDirectories,
			);
		}
		const { resolved, integrity } = archive;
		dependencies.push({ ...dependency, resolved, integrity });
	}
	return { dependencies, files: [...files.values()] };
}

/** Every file the trace reached inside a local package must be in its npm archive. */
async function verifyTracedFilesArePacked(
	directory: string,
	bytes: Buffer,
	{ files, parents }: Pick<RuntimeTrace, "files" | "parents">,
	packageDirectories: readonly string[],
): Promise<void> {
	const archived = packedFiles(bytes);
	const within = (root: string, file: string) => {
		const path = relative(root, file);
		return (
			path !== "" &&
			path !== ".." &&
			!path.startsWith(`..${sep}`) &&
			!isAbsolute(path)
		);
	};
	const inside = (file: string) => within(directory, file);
	for (const file of files) {
		const path = relative(directory, file);
		if (!inside(file)) {
			// The archive cannot supply a file the package loads from outside itself.
			if (
				!file.split(sep).includes("node_modules") &&
				!packageDirectories.some((root) => within(root, file)) &&
				(parents.get(file) ?? []).some(inside)
			)
				throw new Error(
					`The local runtime package at ${directory} loads ${file}, which is outside the package and absent from its npm archive. Move the file into the package or depend on its own package.`,
				);
			continue;
		}
		// A nested graph package, including one under node_modules, is delivered with its
		// own package; anything else must be in this archive, as bundled files are.
		// A traced dependency link is delivered with the package it points to.
		const real = await realpath(file).catch(() => file);
		const owner = [directory, ...packageDirectories]
			.filter(
				(root) =>
					root === directory ||
					within(root, file) ||
					root === real ||
					within(root, real),
			)
			.sort((a, b) => b.length - a.length)[0];
		if (owner !== directory) continue;
		const archivedPath = path.split(sep).join("/");
		if (!archived.has(archivedPath))
			throw new Error(
				`The npm archive of the local runtime package at ${directory} omits ${archivedPath}. Include this file in the package.`,
			);
	}
}
