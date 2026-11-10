import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import type { RoutePlan } from "../../mandatory/ArtifactGeneration/RouteRequirements";
import type {
	FunctionArtifactBuild,
	FunctionArtifactDescriptor,
	FunctionArtifactPolicy,
	PlannedFile,
} from "./.types.ts";
import {
	isSyntaxNode,
	parseModule,
	visitSyntax,
} from "./.emittedModules.ts";

/** Keeps the complete native App; per-route pruning was retired in ADR 0013. */
export async function readFunctionOutput(
	build: FunctionArtifactBuild,
	routePlan: RoutePlan,
): Promise<
	| {
			artifact: FunctionArtifactDescriptor;
			files: PlannedFile[];
	  }
	| undefined
> {
	if (
		!routePlan.routes.some((route) => route.kind === "on-demand")
	)
		return undefined;
	const directory = build.config.build.server;
	const files: PlannedFile[] = [];
	for (const path of await glob(["**/*"], {
		cwd: fileURLToPath(directory),
		dot: true,
		onlyFiles: true,
	})) {
		const from = new URL(path, directory);
		files.push(
			/\.m?js$/.test(path)
				? { path, from, contents: await readFile(from, "utf8") }
				: { path, from },
		);
	}
	if (!files.some((file) => file.path === "index.js"))
		throw new Error(
			"Astro did not emit the expected Function Artifact entrypoint index.js.",
		);
	return {
		artifact: {
			id: "function:shared",
			path: relative(
				fileURLToPath(build.config.outDir),
				fileURLToPath(directory),
			)
				.split(sep)
				.join("/"),
			directory,
			runtime: "nodejs22",
			entrypoint: "index.handler",
		},
		files,
	};
}

/** Computes a wrapped handler without changing the emitted file. */
export function wrapFunctionPolicy(
	source: string,
	policy: Omit<FunctionArtifactPolicy, "artifactDirectory">,
): string {
	let handlerName: string | undefined;
	const edits: Array<{
		start: number;
		end: number;
		value: string;
	}> = [];
	visitSyntax(parseModule(source), (node) => {
		if (
			node.type !== "ExportNamedDeclaration" ||
			!Array.isArray(node.specifiers)
		)
			return;
		for (const specifier of node.specifiers as unknown[]) {
			if (
				isSyntaxNode(specifier) &&
				isSyntaxNode(specifier.exported) &&
				specifier.exported.name === "handler" &&
				isSyntaxNode(specifier.local) &&
				typeof specifier.local.name === "string"
			) {
				handlerName = specifier.local.name;
				edits.push({
					start: specifier.start,
					end: specifier.end,
					value: "__yandexArtifactHandler as handler",
				});
			}
		}
	});
	if (!handlerName || handlerName === "__yandexArtifactHandler")
		throw new Error(
			"The emitted handler export is missing or already wrapped.",
		);
	const serialized = JSON.stringify(policy);
	const wrapper =
		`\nconst __yandexArtifactHandler = (event, context, previewUrl) => ` +
		`${handlerName}(event, context, previewUrl, {...${serialized}, artifactDirectory: new URL('./', import.meta.url)});\n`;
	return applyEdits(source, edits) + wrapper;
}

/** Applies non-overlapping AST edits from the end to preserve original offsets. */
function applyEdits(
	source: string,
	edits: Array<{ start: number; end: number; value: string }>,
): string {
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		source =
			source.slice(0, edit.start) +
			edit.value +
			source.slice(edit.end);
	}
	return source;
}
