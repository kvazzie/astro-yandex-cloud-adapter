import { readFile } from "node:fs/promises";
import {
	basename,
	extname,
	join,
	relative,
	sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
} from "../../.emittedModules.ts";

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
		const from = pathToFileURL(
			join(fileURLToPath(directory), path),
		);
		files.push(
			/\.m?js$/.test(path) ||
				extname(path) === "" ||
				basename(path) === "package.json"
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

const wrapperMarker =
	"/* @astro-yandex-cloud/adapter: 404 policy wrapper */";

/** Names the bindings a declaration pattern declares, skipping defaults and computed keys. */
function patternBindings(pattern: unknown): string[] {
	if (!isSyntaxNode(pattern)) return [];
	switch (pattern.type) {
		case "Identifier":
			return typeof pattern.name === "string"
				? [pattern.name]
				: [];
		case "AssignmentPattern":
			return patternBindings(pattern.left);
		case "RestElement":
			return patternBindings(pattern.argument);
		case "ArrayPattern":
			return Array.isArray(pattern.elements)
				? pattern.elements.flatMap(patternBindings)
				: [];
		case "ObjectPattern":
			return Array.isArray(pattern.properties)
				? pattern.properties.flatMap((property: unknown) =>
						isSyntaxNode(property)
							? patternBindings(
									property.type === "RestElement"
										? property.argument
										: property.value,
								)
							: [],
					)
				: [];
		default:
			return [];
	}
}

/** Computes a wrapped handler without changing the emitted file. */
export function wrapFunctionPolicy(
	source: string,
	policy: Omit<FunctionArtifactPolicy, "artifactDirectory">,
	/** The artifact root relative to the wrapped module, ending in `/`. */
	artifactDirectory = "./",
): string {
	// A prepared entrypoint carries the marker; a binding name alone proves nothing.
	if (source.includes(wrapperMarker))
		throw new Error(
			"The emitted handler export is missing or already wrapped.",
		);
	let handlerName: string | undefined;
	const program = parseModule(source);
	// Identifiers may use escapes, so compare decoded names as well as source text.
	const identifiers = new Set<string>();
	visitSyntax(program, (node) => {
		if (
			node.type === "Identifier" &&
			typeof node.name === "string"
		)
			identifiers.add(node.name);
	});
	const unusedName = (base: string) => {
		let name = base;
		while (source.includes(name) || identifiers.has(name))
			name += "_";
		return name;
	};
	const wrapperName = unusedName("__yandexArtifactHandler");
	const urlName = unusedName("__yandexArtifactURL");
	// One generated rest parameter cannot shadow the original handler binding.
	const argumentsName = unusedName("__yandexArtifactArguments");
	const edits: Array<{
		start: number;
		end: number;
		value: string;
	}> = [];
	const trailingExports: string[] = [];
	visitSyntax(program, (node) => {
		if (node.type !== "ExportNamedDeclaration") return;
		// An inline declaration stays local, and the wrapper takes its export name.
		const declaration = node.declaration;
		if (isSyntaxNode(declaration)) {
			const names: string[] = [];
			if (
				declaration.type === "FunctionDeclaration" ||
				declaration.type === "ClassDeclaration"
			) {
				if (isSyntaxNode(declaration.id))
					names.push(String(declaration.id.name));
			} else if (
				declaration.type === "VariableDeclaration" &&
				Array.isArray(declaration.declarations)
			)
				for (const declarator of declaration.declarations as unknown[])
					if (isSyntaxNode(declarator))
						names.push(...patternBindings(declarator.id));
			if (!names.includes("handler")) return;
			handlerName = "handler";
			edits.push({
				start: node.start,
				end: declaration.start,
				value: "",
			});
			const others = names.filter((name) => name !== "handler");
			if (others.length)
				trailingExports.push(`export { ${others.join(", ")} };`);
			trailingExports.push(
				`export { ${wrapperName} as handler };`,
			);
			return;
		}
		if (!Array.isArray(node.specifiers)) return;
		for (const specifier of node.specifiers as unknown[]) {
			if (
				isSyntaxNode(specifier) &&
				isSyntaxNode(specifier.exported) &&
				specifier.exported.name === "handler" &&
				isSyntaxNode(specifier.local) &&
				typeof specifier.local.name === "string"
			) {
				handlerName = specifier.local.name;
				if (isSyntaxNode(node.source)) {
					handlerName = unusedName("__yandexOriginalHandler");
					const imported = source.slice(
						specifier.local.start,
						specifier.local.end,
					);
					const moduleSource = source.slice(
						node.source.start,
						node.source.end,
					);
					const suffix = source.slice(node.source.end, node.end);
					const others = (node.specifiers as unknown[]).flatMap(
						(other) =>
							isSyntaxNode(other) && other !== specifier
								? [source.slice(other.start, other.end)]
								: [],
					);
					edits.push({
						start: node.start,
						end: node.end,
						value:
							`import { ${imported} as ${handlerName} } from ${moduleSource}${suffix}\n` +
							(others.length
								? `export { ${others.join(", ")} } from ${moduleSource}${suffix}\n`
								: "") +
							`export { ${wrapperName} as handler };`,
					});
					continue;
				}
				edits.push({
					start: specifier.start,
					end: specifier.end,
					value: `${wrapperName} as handler`,
				});
			}
		}
	});
	if (!handlerName)
		throw new Error(
			"The emitted handler export is missing or already wrapped.",
		);
	const serialized = JSON.stringify(policy);
	const wrapper =
		`\n${wrapperMarker}\nimport { URL as ${urlName} } from "node:url";\nconst ${wrapperName} = (...${argumentsName}) => ` +
		`${handlerName}(${argumentsName}[0], ${argumentsName}[1], ${argumentsName}[2], {...${serialized}, artifactDirectory: new ${urlName}(${JSON.stringify(artifactDirectory)}, import.meta.url)});\n`;
	return (
		applyEdits(source, edits) +
		wrapper +
		trailingExports.map((line) => `${line}\n`).join("")
	);
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
