import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
			source: string;
			syntax: SyntaxNode;
			declarations: Map<string, SyntaxNode>;
		}
	>();
	for (const file of await glob(["**/*.js", "**/*.mjs"], {
		cwd: fileURLToPath(directory),
		onlyFiles: true,
	})) {
		const source = await readFile(
			join(fileURLToPath(directory), file),
			"utf8",
		);
		const syntax = parseModule(source);
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
		modules.set(
			pathToFileURL(join(fileURLToPath(directory), file)).href,
			{ source, syntax, declarations },
		);
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
			if (!isSyntaxNode(declaration.init)) continue;
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
		const local = new Set<string>();
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
					local.add(specifier.local.name);
				}
			}
		}
		if (exported.size) {
			imageExports.set(url, exported);
			localImageExports.set(url, local);
		}
	}
	// Forwarding modules keep the wrapper's identity under their own export names.
	const nameOf = (node: unknown): string | undefined =>
		isSyntaxNode(node)
			? typeof node.name === "string"
				? node.name
				: getStaticString(node)
			: undefined;
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
						if (name !== "default") forwarded.add(name);
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
		if (!module) continue;
		let imageCall = false;
		// Calls are matched by declaration, so a shadowing local does not count.
		const localNames =
			localImageExports.get(url) ?? new Set<string>();
		const bindings = new Set<SyntaxNode>();
		const imports = new Set<SyntaxNode>();
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
			for (const specifier of node.specifiers as unknown[]) {
				if (
					isSyntaxNode(specifier) &&
					isSyntaxNode(specifier.local) &&
					typeof specifier.local.name === "string"
				)
					imports.add(specifier.local);
			}
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
		visitSyntax(module.syntax, (node) => {
			if (
				node.type !== "CallExpression" ||
				!isSyntaxNode(node.callee)
			)
				return;
			const callee = node.callee;
			if (
				callee.type === "Identifier" &&
				typeof callee.name === "string"
			) {
				const declaration = identifierBinding(callee);
				imageCall ||=
					declaration !== undefined &&
					(bindings.has(declaration) ||
						(topLevel.has(declaration) &&
							localNames.has(callee.name)) ||
						(!imageExports.has(url) &&
							imports.has(declaration) &&
							/^getImage(?:\$\d+)?$/.test(callee.name)));
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
			...localModuleReferences(module.source).map(
				(reference) => new URL(reference, url).href,
			),
		);
	}
	return false;
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
