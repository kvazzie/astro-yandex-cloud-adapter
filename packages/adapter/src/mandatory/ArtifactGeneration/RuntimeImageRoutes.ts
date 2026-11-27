import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { IntegrationResolvedRoute } from "astro";
import { glob } from "tinyglobby";

import {
	getStaticString,
	isSyntaxNode,
	localModuleReferences,
	parseModule,
	readIdentifierBindings,
	visitSyntax,
	type SyntaxNode,
} from "../../.emittedModules.ts";

/** Finds image calls reachable from runtime routes, excluding registered-only endpoints. */
export async function hasRuntimeImageCalls(
	directory: URL,
	routes: readonly IntegrationResolvedRoute[],
	routeComponents: ReadonlyMap<string, string>,
): Promise<boolean> {
	const components = new Set(
		routes
			.filter(
				(route) =>
					!route.isPrerendered &&
					(route.origin !== "internal" ||
						route.pattern.startsWith("/_actions/")),
			)
			.map(
				(route) =>
					routeComponents.get(route.pattern) ?? route.entrypoint,
			),
	);
	const modules = new Map<
		string,
		{
			syntax: SyntaxNode;
			declarations: Map<string, SyntaxNode>;
		}
	>();
	// Unrelated emitted files only fail the scan when it reaches them.
	const failures = new Map<string, Error>();
	const packageTypes = new Map<string, Promise<unknown>>();
	for (const file of await glob(["**/*.js", "**/*.mjs"], {
		cwd: fileURLToPath(directory),
		onlyFiles: true,
	})) {
		const path = join(fileURLToPath(directory), file);
		const url = pathToFileURL(path).href;
		const source = await readFile(path, "utf8");
		let syntax: SyntaxNode;
		try {
			syntax = parseEmittedModule(
				source,
				file.endsWith(".mjs")
					? "module"
					: await packageType(dirname(path), packageTypes),
			);
		} catch (cause) {
			const failure = new Error(
				`Could not parse emitted module ${file} for runtime image discovery: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
			// Dispatch maps hold the scan's roots, so they cannot be skipped.
			if (/\b(?:pageMap|serverIslandMap)\b/.test(source))
				throw failure;
			failures.set(url, failure);
			continue;
		}
		const declarations = new Map<string, SyntaxNode>();
		if (Array.isArray(syntax.body)) {
			for (const statement of syntax.body as unknown[]) {
				if (!isSyntaxNode(statement)) continue;
				const declaration =
					statement.type === "ExportNamedDeclaration"
						? statement.declaration
						: statement;
				if (
					!isSyntaxNode(declaration) ||
					declaration.type !== "VariableDeclaration" ||
					!Array.isArray(declaration.declarations)
				)
					continue;
				for (const node of declaration.declarations as unknown[]) {
					if (
						isSyntaxNode(node) &&
						node.type === "VariableDeclarator" &&
						isSyntaxNode(node.id) &&
						typeof node.id.name === "string"
					)
						declarations.set(node.id.name, node);
				}
			}
		}
		modules.set(url, { syntax, declarations });
	}

	const mapModules = new Set<string>();
	const pending: string[] = [];
	const runtimeLoaderModules: string[] = [];
	for (const [url, { declarations, syntax }] of modules) {
		const dispatchNames = new Map<string, "page" | "island">();
		// Manifest property names survive identifier minification.
		visitSyntax(syntax, (node) => {
			if (node.type !== "Property" || !isSyntaxNode(node.key))
				return;
			const key = node.computed
				? node.key.value
				: (node.key.name ?? node.key.value);
			if (key === "middleware" || key === "actions") {
				const loader =
					isSyntaxNode(node.value) &&
					node.value.type === "Identifier" &&
					typeof node.value.name === "string"
						? declarations.get(node.value.name)?.init
						: node.value;
				if (isSyntaxNode(loader))
					visitSyntax(loader, (child) => {
						const reference =
							child.type === "ImportExpression"
								? getStaticString(child.source)
								: undefined;
						if (reference?.startsWith("."))
							runtimeLoaderModules.push(
								new URL(reference, url).href,
							);
					});
			}
			if (
				!isSyntaxNode(node.value) ||
				node.value.type !== "Identifier" ||
				typeof node.value.name !== "string"
			)
				return;
			if (key === "pageMap" || key === "serverIslandMap")
				dispatchNames.set(
					node.value.name,
					key === "pageMap" ? "page" : "island",
				);
		});
		for (const [name, declaration] of declarations) {
			const kind =
				dispatchNames.get(name) ??
				(/^pageMap(?:\$\d+)?$/.test(name)
					? "page"
					: /^serverIslandMap(?:\$\d+)?$/.test(name)
						? "island"
						: undefined);
			if (!kind) continue;
			const init = declaration.init;
			if (
				!isSyntaxNode(init) ||
				init.type !== "NewExpression" ||
				!isSyntaxNode(init.callee) ||
				init.callee.type !== "Identifier" ||
				init.callee.name !== "Map" ||
				!Array.isArray(init.arguments)
			)
				continue;
			const entries: unknown = init.arguments[0];
			if (
				!isSyntaxNode(entries) ||
				!Array.isArray(entries.elements)
			)
				continue;
			for (const entry of entries.elements as unknown[]) {
				if (
					!isSyntaxNode(entry) ||
					!Array.isArray(entry.elements)
				)
					continue;
				const [component, loader] = entry.elements as unknown[];
				if (!isSyntaxNode(component) || !isSyntaxNode(loader))
					continue;
				const selected =
					loader.type === "Identifier" &&
					typeof loader.name === "string"
						? declarations.get(loader.name)?.init
						: loader;
				if (!isSyntaxNode(selected)) continue;
				visitSyntax(selected, (node) => {
					if (
						node.type === "ImportExpression" &&
						getStaticString(node.source)?.startsWith(".")
					) {
						mapModules.add(url);
						if (
							kind === "page" &&
							!components.has(getStaticString(component) ?? "")
						)
							return;
						pending.push(
							new URL(getStaticString(node.source)!, url).href,
						);
					}
				});
			}
		}
	}
	if (components.size || pending.length)
		pending.push(...runtimeLoaderModules);

	// Link the image service wrapper's exported binding to imports in runtime pages.
	// Method/property names are the service protocol; local identifiers may be minified.
	const imageExports = new Map<string, Set<string>>();
	const localImageExports = new Map<string, Set<string>>();
	for (const [url, { syntax, declarations }] of modules) {
		let astroAssets = false;
		visitSyntax(syntax, (node) => {
			if (
				node.type !== "ObjectExpression" ||
				!Array.isArray(node.properties)
			)
				return;
			const properties = new Map(
				node.properties.flatMap((property: unknown) =>
					isSyntaxNode(property) &&
					property.type === "Property" &&
					isSyntaxNode(property.key)
						? [
								[
									property.computed
										? getStaticString(property.key)
										: (property.key.name ??
											getStaticString(property.key)),
									property.value,
								] as const,
							]
						: [],
				),
			);
			const hasString = (value: unknown, key: string): boolean =>
				isSyntaxNode(value) &&
				value.type === "ObjectExpression" &&
				Array.isArray(value.properties) &&
				value.properties.some(
					(property: unknown) =>
						isSyntaxNode(property) &&
						isSyntaxNode(property.key) &&
						(property.key.name ??
							getStaticString(property.key)) === key &&
						getStaticString(property.value) !== undefined,
				);
			if (
				hasString(properties.get("endpoint"), "route") &&
				hasString(properties.get("service"), "entrypoint")
			)
				astroAssets = true;
		});
		if (!astroAssets || !Array.isArray(syntax.body)) continue;
		const functions = new Set<string>();
		for (const node of syntax.body as unknown[]) {
			if (
				!isSyntaxNode(node) ||
				node.type !== "FunctionDeclaration" ||
				!isSyntaxNode(node.id) ||
				typeof node.id.name !== "string"
			)
				continue;
			const name = node.id.name;
			visitSyntax(node, (child) => {
				if (
					child.type === "CallExpression" &&
					isSyntaxNode(child.callee) &&
					child.callee.type === "MemberExpression" &&
					isSyntaxNode(child.callee.property) &&
					(child.callee.property.name ??
						getStaticString(child.callee.property)) === "getURL"
				)
					functions.add(name);
			});
		}
		for (const [name, declaration] of declarations) {
			// A function value that calls a wrapper is a wrapper; a call evaluated at
			// module load, such as `const image = getImage({})`, is a runtime call.
			if (
				!isSyntaxNode(declaration.init) ||
				(declaration.init.type !== "ArrowFunctionExpression" &&
					declaration.init.type !== "FunctionExpression")
			)
				continue;
			visitSyntax(declaration.init, (child) => {
				if (
					child.type === "CallExpression" &&
					isSyntaxNode(child.callee) &&
					typeof child.callee.name === "string" &&
					functions.has(child.callee.name)
				)
					functions.add(name);
			});
		}
		const exported = new Set<string>();
		for (const node of syntax.body as unknown[]) {
			if (
				!isSyntaxNode(node) ||
				node.type !== "ExportNamedDeclaration" ||
				!Array.isArray(node.specifiers)
			)
				continue;
			for (const specifier of node.specifiers as unknown[]) {
				if (
					!isSyntaxNode(specifier) ||
					!isSyntaxNode(specifier.local) ||
					typeof specifier.local.name !== "string" ||
					!functions.has(specifier.local.name) ||
					!isSyntaxNode(specifier.exported)
				)
					continue;
				const name =
					specifier.exported.name ??
					getStaticString(specifier.exported);
				if (typeof name === "string") {
					exported.add(name);
				}
			}
		}
		if (exported.size) imageExports.set(url, exported);
		// Same-module calls reach a wrapper whether or not the module exports it.
		if (functions.size) localImageExports.set(url, functions);
	}
	// Forwarding modules keep the wrapper's identity under their own export names.
	const nameOf = (node: unknown): string | undefined =>
		isSyntaxNode(node)
			? typeof node.name === "string"
				? node.name
				: getStaticString(node)
			: undefined;
	// A module's explicit exports take precedence over names from `export *`.
	const explicitExports = new Map<string, Set<string>>();
	for (const [url, { syntax }] of modules) {
		const names = new Set<string>();
		for (const node of Array.isArray(syntax.body)
			? (syntax.body as unknown[])
			: []) {
			if (!isSyntaxNode(node)) continue;
			if (node.type === "ExportDefaultDeclaration")
				names.add("default");
			if (node.type === "ExportAllDeclaration") {
				const exported = nameOf(node.exported);
				if (exported) names.add(exported);
			}
			if (node.type !== "ExportNamedDeclaration") continue;
			const declaration = node.declaration;
			if (isSyntaxNode(declaration)) {
				if (Array.isArray(declaration.declarations))
					for (const declarator of declaration.declarations as unknown[])
						if (isSyntaxNode(declarator))
							declarePatternNames(declarator.id, names);
				declarePatternNames(declaration.id, names);
			}
			for (const specifier of Array.isArray(node.specifiers)
				? (node.specifiers as unknown[])
				: []) {
				const exported = isSyntaxNode(specifier)
					? nameOf(specifier.exported)
					: undefined;
				if (exported) names.add(exported);
			}
		}
		explicitExports.set(url, names);
	}
	for (let changed = true; changed;) {
		changed = false;
		for (const [url, { syntax }] of modules) {
			if (!Array.isArray(syntax.body)) continue;
			const sourceExports = (node: SyntaxNode) => {
				const reference = getStaticString(node.source);
				return reference === "astro:assets"
					? new Set(["getImage"])
					: reference?.startsWith(".")
						? imageExports.get(new URL(reference, url).href)
						: undefined;
			};
			const imported = new Set<string>();
			for (const node of syntax.body as unknown[]) {
				if (
					!isSyntaxNode(node) ||
					node.type !== "ImportDeclaration" ||
					!Array.isArray(node.specifiers)
				)
					continue;
				const source = sourceExports(node);
				for (const specifier of node.specifiers as unknown[])
					if (
						isSyntaxNode(specifier) &&
						specifier.type === "ImportSpecifier" &&
						source?.has(nameOf(specifier.imported) ?? "")
					)
						imported.add(nameOf(specifier.local) ?? "");
			}
			const forwarded = new Set(imageExports.get(url));
			const size = forwarded.size;
			for (const node of syntax.body as unknown[]) {
				if (!isSyntaxNode(node)) continue;
				if (
					node.type === "ExportAllDeclaration" &&
					!node.exported
				)
					for (const name of sourceExports(node) ?? [])
						if (
							name !== "default" &&
							!explicitExports.get(url)?.has(name)
						)
							forwarded.add(name);
				if (
					node.type !== "ExportNamedDeclaration" ||
					!Array.isArray(node.specifiers)
				)
					continue;
				const source = node.source
					? sourceExports(node)
					: imported;
				for (const specifier of node.specifiers as unknown[]) {
					if (!isSyntaxNode(specifier)) continue;
					const exported = nameOf(specifier.exported);
					if (
						exported &&
						source?.has(nameOf(specifier.local) ?? "")
					)
						forwarded.add(exported);
				}
			}
			if (forwarded.size !== size) {
				imageExports.set(url, forwarded);
				changed = true;
			}
		}
	}

	const visited = new Set<string>();
	while (pending.length) {
		const url = pending.pop()!;
		if (visited.has(url) || mapModules.has(url)) continue;
		visited.add(url);
		const module = modules.get(url);
		const failure = failures.get(url);
		if (failure) throw failure;
		if (!module) continue;
		let imageCall = false;
		// Calls are matched by declaration, so a shadowing local does not count.
		const localNames =
			localImageExports.get(url) ?? new Set<string>();
		const bindings = new Set<SyntaxNode>();
		const namespaces = new Map<
			SyntaxNode,
			ReadonlySet<string>
		>();
		visitSyntax(module.syntax, (node) => {
			if (
				node.type !== "ImportDeclaration" ||
				!Array.isArray(node.specifiers)
			)
				return;
			const reference = getStaticString(node.source);
			const exported =
				reference === "astro:assets"
					? new Set(["getImage"])
					: reference?.startsWith(".")
						? imageExports.get(new URL(reference, url).href)
						: undefined;
			if (!exported) return;
			for (const specifier of node.specifiers as unknown[]) {
				if (
					!isSyntaxNode(specifier) ||
					!isSyntaxNode(specifier.local) ||
					typeof specifier.local.name !== "string"
				)
					continue;
				if (specifier.type === "ImportNamespaceSpecifier") {
					namespaces.set(specifier.local, exported);
					continue;
				}
				if (!isSyntaxNode(specifier.imported)) continue;
				const name =
					specifier.imported.name ??
					getStaticString(specifier.imported);
				if (typeof name === "string" && exported.has(name))
					bindings.add(specifier.local);
			}
		});
		const identifierBinding = readIdentifierBindings(
			module.syntax,
		);
		const topLevel = topLevelBindings(module.syntax);
		// A call inside a wrapper's own declaration runs only when that wrapper is called.
		// Declarations are compared by node, so a nested binding that shadows a wrapper
		// name is not mistaken for the wrapper.
		const wrapperDeclarations = new Set<SyntaxNode>();
		for (const statement of Array.isArray(module.syntax.body)
			? (module.syntax.body as unknown[])
			: []) {
			const declaration =
				isSyntaxNode(statement) &&
				(statement.type === "ExportNamedDeclaration" ||
					statement.type === "ExportDefaultDeclaration")
					? statement.declaration
					: statement;
			if (
				isSyntaxNode(declaration) &&
				declaration.type === "FunctionDeclaration" &&
				isSyntaxNode(declaration.id) &&
				typeof declaration.id.name === "string" &&
				localNames.has(declaration.id.name)
			)
				wrapperDeclarations.add(declaration);
		}
		for (const name of localNames) {
			const declarator = module.declarations.get(name);
			if (declarator) wrapperDeclarations.add(declarator);
		}
		const insideWrapper = (ancestors: SyntaxNode[]) =>
			ancestors.some((ancestor) =>
				wrapperDeclarations.has(ancestor),
			);
		visitSyntax(module.syntax, (node, ancestors) => {
			if (
				node.type !== "CallExpression" ||
				!isSyntaxNode(node.callee) ||
				insideWrapper(ancestors)
			)
				return;
			const callee = node.callee;
			if (
				callee.type === "Identifier" &&
				typeof callee.name === "string"
			) {
				// Only bindings linked to the recognized wrapper count; the name `getImage` is not evidence.
				const declaration = identifierBinding(callee);
				imageCall ||=
					declaration !== undefined &&
					(bindings.has(declaration) ||
						(topLevel.has(declaration) &&
							localNames.has(callee.name)));
			} else if (
				callee.type === "MemberExpression" &&
				isSyntaxNode(callee.object) &&
				callee.object.type === "Identifier" &&
				typeof callee.object.name === "string" &&
				isSyntaxNode(callee.property)
			) {
				// Static bracket access names the same export; dynamic keys stay unclassified.
				const property = callee.computed
					? getStaticString(callee.property)
					: callee.property.name;
				const declaration = identifierBinding(callee.object);
				imageCall ||=
					typeof property === "string" &&
					declaration !== undefined &&
					namespaces.get(declaration)?.has(property) === true;
			}
		});
		if (imageCall) return true;
		pending.push(
			...localModuleReferences(module.syntax).map(
				(reference) => new URL(reference, url).href,
			),
		);
	}
	return false;
}

/** Parses a file in the format Node.js would load it with. */
function parseEmittedModule(
	source: string,
	format: unknown,
): SyntaxNode {
	if (format === "module") return parseModule(source);
	if (format === "commonjs")
		return parseModule(source, "commonjs");
	// Without a package type, Node.js 22 detects ESM syntax in a `.js` file.
	try {
		return parseModule(source, "commonjs");
	} catch {
		return parseModule(source);
	}
}

/** Reads the nearest package.json `type`, as Node.js resolves a `.js` file's format. */
function packageType(
	directory: string,
	cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
	let type = cache.get(directory);
	if (!type) {
		type = readFile(
			join(directory, "package.json"),
			"utf8",
		).then(
			(contents) => {
				try {
					return (JSON.parse(contents) as { type?: unknown })
						.type;
				} catch {
					return undefined;
				}
			},
			() =>
				dirname(directory) === directory ||
				basename(directory) === "node_modules"
					? undefined
					: packageType(dirname(directory), cache),
		);
		cache.set(directory, type);
	}
	return type;
}

/** Adds the names a binding pattern declares, skipping default-value references. */
function declarePatternNames(
	pattern: unknown,
	names: Set<string>,
): void {
	if (!isSyntaxNode(pattern)) return;
	if (
		pattern.type === "Identifier" &&
		typeof pattern.name === "string"
	)
		names.add(pattern.name);
	else if (pattern.type === "AssignmentPattern")
		declarePatternNames(pattern.left, names);
	else if (pattern.type === "RestElement")
		declarePatternNames(pattern.argument, names);
	else if (
		pattern.type === "ArrayPattern" &&
		Array.isArray(pattern.elements)
	)
		for (const element of pattern.elements as unknown[])
			declarePatternNames(element, names);
	else if (
		pattern.type === "ObjectPattern" &&
		Array.isArray(pattern.properties)
	)
		for (const property of pattern.properties as unknown[])
			if (isSyntaxNode(property))
				declarePatternNames(
					property.type === "RestElement"
						? property.argument
						: property.value,
					names,
				);
}

/** Reads the declaration nodes of a module's top-level bindings. */
function topLevelBindings(program: SyntaxNode): Set<SyntaxNode> {
	const declarations = new Set<SyntaxNode>();
	// Identifiers in default values are references, which a lookup never returns.
	const declare = (pattern: unknown) => {
		if (isSyntaxNode(pattern))
			visitSyntax(pattern, (node) => {
				if (node.type === "Identifier") declarations.add(node);
			});
	};
	for (const statement of Array.isArray(program.body)
		? (program.body as unknown[])
		: []) {
		if (!isSyntaxNode(statement)) continue;
		const declaration =
			statement.type === "ExportNamedDeclaration" ||
			statement.type === "ExportDefaultDeclaration"
				? statement.declaration
				: statement;
		if (!isSyntaxNode(declaration)) continue;
		if (
			declaration.type === "FunctionDeclaration" ||
			declaration.type === "ClassDeclaration"
		)
			declare(declaration.id);
		if (
			declaration.type === "VariableDeclaration" &&
			Array.isArray(declaration.declarations)
		)
			for (const declarator of declaration.declarations as unknown[])
				if (isSyntaxNode(declarator)) declare(declarator.id);
	}
	return declarations;
}
