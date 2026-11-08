import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";

import type { RoutePlan } from "../../../mandatory/ArtifactGeneration/RouteRequirements";
import type {
	FunctionArtifactBuild,
	FunctionArtifactDescriptor,
	FunctionArtifactPolicy,
	PlannedFile,
} from "../.types.ts";
import {
	isSyntaxNode,
	localModuleReferences,
	parseModule,
	type SyntaxNode,
	visitSyntax,
} from "../.emittedModules.ts";
import { Errors } from "..";

export interface PlannedPartition {
	artifact: FunctionArtifactDescriptor;
	files: PlannedFile[];
}

/** Reads emitted output and computes partitions without modifying any artifact. */
export async function planPartitions(
	build: FunctionArtifactBuild,
	routePlan: RoutePlan,
	mode: "shared" | "separate",
): Promise<{
	routePlan: RoutePlan;
	partitions: PlannedPartition[];
}> {
	const routes = routePlan.routes.filter(
		(route) => route.kind === "on-demand",
	);
	if (!routes.length) return { routePlan, partitions: [] };
	const { config } = build;
	if (mode === "shared") {
		const files: PlannedFile[] = [];
		for (const path of await glob(["**/*"], {
			cwd: fileURLToPath(config.build.server),
			dot: true,
			onlyFiles: true,
		})) {
			const from = new URL(path, config.build.server);
			files.push(
				/\.m?js$/.test(path)
					? {
							path,
							from,
							contents: await readFile(from, "utf8"),
						}
					: { path, from },
			);
		}
		if (!files.some((file) => file.path === "index.js"))
			throw new Error(
				"Astro did not emit the expected Function Artifact entrypoint index.js.",
			);
		return {
			routePlan,
			partitions: [
				{
					artifact: artifact(
						config.outDir,
						config.build.server,
						"function:shared",
					),
					files,
				},
			],
		};
	}
	const partitions: PlannedPartition[] = [];
	const assignments = new Map<string, string>();
	const index = await readFile(
		new URL("index.js", config.build.server),
		"utf8",
	);
	for (const route of routes) {
		const identity = `${route.routeKind}:${route.pattern}`;
		const suffix = createHash("sha256")
			.update(identity)
			.digest("hex")
			.slice(0, 16);
		const id = `function:${suffix}`;
		const directory = new URL(
			`functions/${suffix}/`,
			config.outDir,
		);
		const originalPattern = withoutBase(
			route.pattern,
			config.base,
		);
		const resolved = build.resolvedRoutes.find(
			(candidate) => candidate.pattern === originalPattern,
		);
		if (!resolved)
			throw new Errors.InvalidArtifact({
				message: `Cannot identify Astro's emitted entrypoint for ${route.pattern}.`,
			});
		const keepServerIslands =
			route.origin === "internal" &&
			originalPattern.startsWith("/_server-islands/");
		const components = new Set(
			keepServerIslands
				? []
				: [
						build.routeComponents.get(originalPattern) ??
							resolved.entrypoint,
					],
		);
		const selected = prunePageModules(index, components);
		const source = keepServerIslands
			? (selected ?? index)
			: pruneServerIslandLoaders(selected ?? index);
		const files = await planEmittedGraph(
			config.build.server,
			source,
			keepServerIslands,
			components,
			selected !== undefined,
		);
		assignments.set(identity, id);
		partitions.push({
			artifact: {
				...artifact(config.outDir, directory, id),
				allowedRoutes: [originalPattern],
			},
			files,
		});
	}
	return {
		partitions,
		routePlan: {
			...routePlan,
			routes: routePlan.routes.map((route) =>
				route.kind === "on-demand"
					? {
							...route,
							artifactId: assignments.get(
								`${route.routeKind}:${route.pattern}`,
							)! as typeof route.artifactId,
						}
					: route,
			),
		},
	};
}

function artifact(
	outDir: URL,
	directory: URL,
	id: string,
): FunctionArtifactDescriptor {
	return {
		id,
		path: relative(
			fileURLToPath(outDir),
			fileURLToPath(directory),
		)
			.split(sep)
			.join("/"),
		directory,
		runtime: "nodejs22",
		entrypoint: "index.handler",
	};
}
function withoutBase(pattern: string, base: string): string {
	const normalized = `/${base.replace(/^\/+|\/+$/g, "")}`;
	return normalized === "/"
		? pattern
		: pattern.slice(normalized.length) || "/";
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
		`${handlerName}(event, context, previewUrl, {...${serialized}, artifactDirectory: new URL('./index.ts', import.meta.url)});\n`;
	return applyEdits(source, edits) + wrapper;
}

/** Removes other page loaders while retaining all route metadata for precedence. */
function prunePageModules(
	source: string,
	components: Set<string>,
): string | undefined {
	const declarations = new Map<string, SyntaxNode>();
	const edits: Array<{
		start: number;
		end: number;
		value: string;
	}> = [];
	visitSyntax(parseModule(source), (node) => {
		if (
			node.type === "VariableDeclarator" &&
			isSyntaxNode(node.id) &&
			typeof node.id.name === "string"
		) {
			declarations.set(node.id.name, node);
		}
	});
	const pageMap = [...declarations.entries()].find(([name]) =>
		/^pageMap(?:\$\d+)?$/.test(name),
	)?.[1];
	if (!pageMap) return undefined;
	const init = pageMap?.init;
	if (!isSyntaxNode(init) || !Array.isArray(init.arguments))
		throw new Error(
			"Astro did not emit the expected route module map for separate Functions.",
		);
	const entries = (init.arguments as unknown[])[0];
	if (!isSyntaxNode(entries) || !Array.isArray(entries.elements))
		throw new Error(
			"Astro's emitted route module map has an unsupported shape.",
		);
	const retained: string[] = [];
	for (const entry of entries.elements as unknown[]) {
		if (!isSyntaxNode(entry) || !Array.isArray(entry.elements))
			throw new Error(
				"Astro's emitted route module map contains an invalid entry.",
			);
		const [component, loader] = entry.elements as unknown[];
		if (
			!isSyntaxNode(component) ||
			typeof component.value !== "string"
		)
			throw new Error(
				"Astro's emitted route component is not a fixed module ID.",
			);
		if (!isSyntaxNode(loader) || typeof loader.name !== "string")
			throw new Error(
				"Astro's emitted page loader has an unsupported shape.",
			);
		const declaration = declarations.get(loader.name);
		if (
			!declaration ||
			!isSyntaxNode(declaration.init) ||
			(declaration.init.type !== "ArrowFunctionExpression" &&
				declaration.init.type !== "FunctionExpression")
		)
			throw new Error(
				"Astro's emitted page loader declaration is missing.",
			);
		if (components.has(component.value)) {
			retained.push(source.slice(entry.start, entry.end));
			continue;
		}
		edits.push({
			start: declaration.init.start,
			end: declaration.init.end,
			value: "undefined",
		});
	}
	if (retained.length !== components.size)
		throw new Error(
			`Astro's emitted route module map is missing the selected loader: ${[...components].join(", ")}.`,
		);
	edits.push({
		start: entries.start,
		end: entries.end,
		value: `[${retained.join(",")}]`,
	});
	return applyEdits(source, edits);
}

/** Keeps deferred component names but removes loaders outside the island Function. */
function pruneServerIslandLoaders(source: string): string {
	const edits: Array<{
		start: number;
		end: number;
		value: string;
	}> = [];
	visitSyntax(parseModule(source), (node) => {
		if (
			node.type !== "VariableDeclarator" ||
			!isSyntaxNode(node.id) ||
			typeof node.id.name !== "string" ||
			!/^serverIslandMap(?:\$\d+)?$/.test(node.id.name) ||
			!isSyntaxNode(node.init) ||
			node.init.type !== "NewExpression" ||
			!Array.isArray(node.init.arguments)
		)
			return;
		const entries = (node.init.arguments as unknown[])[0];
		if (
			isSyntaxNode(entries) &&
			entries.type === "ArrayExpression"
		)
			edits.push({
				start: entries.start,
				end: entries.end,
				value: "[]",
			});
	});
	return applyEdits(source, edits);
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

/** Describes the fixed import graph after route loader selection, without copying it. */
async function planEmittedGraph(
	source: URL,
	index: string,
	keepServerIslands: boolean,
	components: Set<string>,
	foundPageMap: boolean,
): Promise<PlannedFile[]> {
	const files: PlannedFile[] = [
		{ path: "index.js", contents: index },
	];
	const pending = localModuleReferences(index);
	const copied = new Set<string>(["index.js"]);
	while (pending.length) {
		const path = pending.pop()!;
		const original = new URL(path, source);
		const local = relative(
			fileURLToPath(source),
			fileURLToPath(original),
		)
			.split(sep)
			.join("/");
		if (local.startsWith("../") || local === "..")
			throw new Error(
				`Astro's emitted module ${path} escapes its Function Artifact.`,
			);
		if (copied.has(local)) continue;
		copied.add(local);
		if (/\.m?js$/.test(local)) {
			const originalSource = await readFile(original, "utf8");
			const selected = prunePageModules(
				originalSource,
				components,
			);
			foundPageMap ||= selected !== undefined;
			const moduleSource = keepServerIslands
				? (selected ?? originalSource)
				: pruneServerIslandLoaders(selected ?? originalSource);
			files.push({ path: local, contents: moduleSource });
			for (const reference of localModuleReferences(
				moduleSource,
			)) {
				pending.push(
					relative(
						fileURLToPath(source),
						fileURLToPath(new URL(reference, original)),
					)
						.split(sep)
						.join("/"),
				);
			}
		} else {
			files.push({ path: local, from: original });
		}
	}
	if (!foundPageMap)
		throw new Error(
			"Astro did not emit the expected route module map for separate Functions.",
		);
	return files;
}
