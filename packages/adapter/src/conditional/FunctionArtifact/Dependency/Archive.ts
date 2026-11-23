import { createHash } from "node:crypto";

import pack from "libnpmpack";

import type { PlannedFile } from "../.types.ts";
import type { ResolvedRuntimeDependency } from "./Metadata.ts";

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
