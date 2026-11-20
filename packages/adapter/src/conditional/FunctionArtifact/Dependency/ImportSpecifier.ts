import {
	getStaticString,
	parseModule,
} from "../../../.emittedModules.ts";
import { isBuiltin } from "node:module";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	PlannedFile,
	PreparationSettings,
} from "../.types.ts";

/** Inspects the files that will form an artifact, without requiring output files on disk. */
export function findRuntimePackageImports(
	files: readonly PlannedFile[],
	strategy: PreparationSettings["dependencyStrategy"],
): Set<string> {
	if (
		strategy === "bundle" &&
		files.some((file) => file.path.endsWith(".node"))
	)
		throw new Error(
			'The Function Artifact contains a native runtime module, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
		);
	if (files.some((file) => file.path.endsWith(".cjs")))
		throw new Error(
			"The function artifact contains an unsupported CommonJS module. V1 function artifacts must use ESM.",
		);
	const names = new Set<string>();
	const modules = new Map<
		string,
		{ namespace: EmittedNamespace; inspect: () => void }
	>();
	const addModule = (
		url: URL,
		program: SyntaxNode,
		path: string,
	): void => {
		const resolveImport = (
			specifier: string,
		): LoaderRole | undefined => {
			const builtin = builtinModuleRole(specifier);
			if (builtin) return builtin;
			const target = URL.parse(specifier);
			if (target?.protocol === "data:") {
				if (!modules.has(target.href)) {
					const inline = inlineJavaScript(new URL(target));
					if (inline !== undefined)
						addModule(
							target,
							parseModule(inline),
							`inline module in ${path}`,
						);
				}
				return modules.get(target.href)?.namespace;
			}
			if (!isRelativeSpecifier(specifier)) return undefined;
			const local = URL.parse(specifier, url);
			if (!local) return undefined;
			local.hash = "";
			local.search = "";
			return modules.get(local.href)?.namespace;
		};
		const bindings = runtimeLoaderBindings(
			program,
			resolveImport,
		);
		modules.set(url.href, {
			namespace: emittedNamespace(
				program,
				bindings.bindingRole,
				resolveImport,
			),
			inspect: () => {
				for (const name of findImportedPackageNames(
					program,
					path,
					strategy,
					bindings,
					resolveImport,
				))
					names.add(name);
			},
		});
	};
	for (const file of files) {
		const path = basename(file.path);
		const isJavaScript = /\.m?js$/.test(path);
		if (
			!isJavaScript &&
			(extname(path) || file.contents === undefined)
		)
			continue;
		if (file.contents === undefined)
			throw new Error(
				`Missing computed module contents for ${file.path}.`,
			);
		let program: SyntaxNode;
		try {
			program = parseModule(file.contents);
		} catch (error) {
			// Extensionless assets share a filename shape with Node ES modules.
			if (!isJavaScript && error instanceof SyntaxError)
				continue;
			throw error;
		}
		addModule(pathToFileURL(file.path), program, file.path);
	}
	// Linking is lazy so imports can refer to later files or to cyclic re-exports.
	// Map iteration also inspects any JavaScript data modules discovered by the visitor.
	for (const module of modules.values()) module.inspect();
	return names;
}

function findImportedPackageNames(
	program: SyntaxNode,
	relativePath: string,
	strategy: PreparationSettings["dependencyStrategy"],
	bindings: ReturnType<typeof runtimeLoaderBindings>,
	resolveImport: (specifier: string) => LoaderRole | undefined,
): Set<string> {
	const dependencyNames = new Set<string>();
	const collectPackageImport = (
		importSpecifier: string,
	): void => {
		if (
			importSpecifier.endsWith(".node") &&
			strategy === "bundle"
		) {
			throw new Error(
				`The Function Artifact contains the native runtime module ${importSpecifier} referenced by ${relativePath}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
			);
		}
		// Native file imports stay inside the owning package for install builds,
		// so the package itself is pinned; bundle builds cannot carry native code.
		if (!isBareImportSpecifier(importSpecifier)) return;
		dependencyNames.add(
			packageNameFromSpecifier(importSpecifier),
		);
	};
	const inspectModuleImport = (specifier: string): void => {
		const url = URL.parse(specifier);
		if (url?.protocol === "data:") {
			resolveImport(specifier);
		} else collectPackageImport(specifier);
	};
	const rejectDynamicImport = (detail?: string): never => {
		if (strategy === "install") {
			throw new Error(
				`The Function Artifact contains unresolved dynamic runtime dependency resolution${detail ? ` (${detail})` : ""} in ${relativePath}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
			);
		}
		throw new Error(
			`The Function Artifact contains unresolved dynamic or native runtime dependency resolution${detail ? ` (${detail})` : ""} in ${relativePath}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
		);
	};
	const { bindingRole, isUnbound } = bindings;
	visitSyntax(program, (node, ancestors) => {
		const parent = ancestors.at(-1);
		if (
			node.type === "Identifier" &&
			parent &&
			(parent.type === "MetaProperty" ||
				(parent.type === "ExportSpecifier" &&
					(parent.local !== node ||
						isSyntaxNode(ancestors.at(-2)?.source))) ||
				(parent.type === "ExportAllDeclaration" &&
					parent.exported === node) ||
				(parent.type === "MemberExpression" &&
					parent.property === node &&
					!parent.computed) ||
				([
					"Property",
					"MethodDefinition",
					"PropertyDefinition",
				].includes(parent.type) &&
					parent.key === node &&
					!parent.computed &&
					parent.value !== node))
		)
			return;

		const role = bindingRole(node);
		if (
			role === "register" &&
			!parent?.type.startsWith("Import")
		)
			rejectDynamicImport(
				"Node module registration cannot be packaged statically",
			);
		if (
			role === "factory" ||
			role === "require" ||
			role === "resolve" ||
			role === "module" ||
			role === "meta" ||
			role === "builtin"
		) {
			const declaration =
				parent?.type === "VariableDeclarator" &&
				isSyntaxNode(parent.id) &&
				(parent.id.type === "Identifier"
					? parent.init === null ||
						(bindingRole(parent.id) === role &&
							bindingRole(parent.init) === role)
					: (role === "module" || role === "meta") &&
						isLoaderPattern(parent.id, role, bindingRole)) &&
				(ancestors.at(-3)?.type !== "ExportNamedDeclaration" ||
					(role === "meta" &&
						parent.id.type === "ObjectPattern" &&
						Array.isArray(parent.id.properties) &&
						parent.id.properties.every(
							(property: unknown) =>
								isSyntaxNode(property) &&
								loaderPropertyRole(
									role,
									isSyntaxNode(property.key) &&
										property.key.type === "Identifier"
										? property.key.name
										: getStaticString(property.key),
								) === undefined &&
								bindingRole(property.value) === undefined,
						))) &&
				(parent.id === node || parent.init === node);
			const importBinding = parent?.type.startsWith("Import");
			const patternBinding =
				parent?.type === "Property" &&
				parent.value === node &&
				isLoaderPattern(ancestors.at(-2), role);
			const awaited =
				parent?.type === "AwaitExpression" &&
				parent.argument === node;
			const observation =
				parent?.type === "UnaryExpression" &&
				parent.operator === "typeof" &&
				parent.argument === node;
			if (
				node.type === "ImportExpression" &&
				!awaited &&
				!observation
			)
				rejectDynamicImport();
			const call =
				parent?.type === "CallExpression" &&
				parent.callee === node;
			const member =
				parent?.type === "MemberExpression" &&
				parent.object === node &&
				((role === "meta" &&
					(parent.computed
						? getStaticString(parent.property) !== undefined
						: isSyntaxNode(parent.property) &&
							parent.property.type === "Identifier")) ||
					(!parent.computed &&
						((role === "module" &&
							node.type !== "ImportExpression") ||
							(role === "require" &&
								isIdentifier(parent.property, "resolve")))));
			if (
				!declaration &&
				!importBinding &&
				!patternBinding &&
				!awaited &&
				!call &&
				!observation &&
				!member
			)
				rejectDynamicImport();
		}
		if (
			node.type === "VariableDeclarator" &&
			bindingRole(node.init) === "process" &&
			isSyntaxNode(node.id) &&
			node.id.type === "ObjectPattern" &&
			(!isLoaderPattern(node.id, "process", bindingRole) ||
				(ancestors.at(-2)?.type === "ExportNamedDeclaration" &&
					Array.isArray(node.id.properties) &&
					node.id.properties.some(
						(property: unknown) =>
							isSyntaxNode(property) &&
							loaderPropertyRole(
								"process",
								isSyntaxNode(property.key) &&
									property.key.type === "Identifier"
									? property.key.name
									: getStaticString(property.key),
							) === "builtin",
					)))
		)
			rejectDynamicImport(
				"process getter destructuring changes or exports a loader binding",
			);
		if (
			node.type === "AssignmentPattern" &&
			bindingRole(node.right) === "process" &&
			isSyntaxNode(node.left) &&
			node.left.type === "ObjectPattern" &&
			!isLoaderPattern(node.left, "process", bindingRole)
		)
			rejectDynamicImport(
				"process parameter destructuring changes a loader binding",
			);
		// A process object is ordinary runtime data; its extracted getter is the loader.
		if (
			node.type === "MemberExpression" &&
			bindingRole(node.object) === "process" &&
			node.computed &&
			getStaticString(node.property) === undefined
		)
			rejectDynamicImport(
				"process builtin lookup must use a fixed property",
			);
		if (
			node.type === "VariableDeclarator" &&
			isSyntaxNode(node.id) &&
			node.id.type === "Identifier" &&
			node.init !== null &&
			(bindingRole(node.id) === "process" ||
				bindingRole(node.init) === "process") &&
			bindingRole(node.id) !== bindingRole(node.init)
		)
			rejectDynamicImport(
				"process alias initialization changes its binding role",
			);
		if (
			node.type === "AssignmentExpression" &&
			(bindingRole(node.left) === "process" ||
				bindingRole(node.right) === "process") &&
			!(
				node.operator === "=" &&
				isSyntaxNode(node.left) &&
				((node.left.type === "Identifier" &&
					bindingRole(node.left) === bindingRole(node.right)) ||
					(bindingRole(node.right) === "process" &&
						isLoaderPattern(node.left, "process", bindingRole)))
			)
		)
			rejectDynamicImport(
				"process alias assignment cannot preserve its binding role",
			);

		if (
			node.type === "CallExpression" &&
			bindingRole(node.callee) === "builtin" &&
			(!Array.isArray(node.arguments) ||
				node.arguments.length !== 1 ||
				getStaticString(node.arguments[0]) === undefined)
		)
			rejectDynamicImport(
				"process.getBuiltinModule must use one fixed builtin name",
			);
		if (
			node.type === "CallExpression" &&
			bindingRole(node.callee) === "factory"
		) {
			const argument: unknown = Array.isArray(node.arguments)
				? node.arguments[0]
				: undefined;
			if (
				!isSyntaxNode(argument) ||
				argument.type !== "MemberExpression" ||
				!isIdentifier(argument.property, "url") ||
				!isSyntaxNode(argument.object) ||
				argument.object.type !== "MetaProperty" ||
				!isIdentifier(argument.object.meta, "import") ||
				!isIdentifier(argument.object.property, "meta") ||
				argument.computed ||
				(node.arguments &&
					(node.arguments as unknown[]).length !== 1)
			)
				rejectDynamicImport(
					"createRequire must use import.meta.url",
				);
		}
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration": {
				const importSpecifier = getStaticString(node.source);
				if (
					node.type !== "ImportDeclaration" &&
					builtinModuleRole(importSpecifier) !== undefined &&
					(node.type === "ExportAllDeclaration" ||
						(Array.isArray(node.specifiers) &&
							node.specifiers.some((specifier: unknown) => {
								if (!isSyntaxNode(specifier)) return false;
								const name =
									isSyntaxNode(specifier.local) &&
									specifier.local.type === "Identifier"
										? specifier.local.name
										: getStaticString(specifier.local);
								return builtinModuleRole(importSpecifier) ===
									"process"
									? name === "getBuiltinModule" ||
											name === "default"
									: loaderPropertyRole("module", name) !==
											undefined || name === "register";
							})))
				)
					rejectDynamicImport(
						"Node loader re-exports cannot be tracked across modules",
					);
				if (importSpecifier)
					inspectModuleImport(importSpecifier);
				return;
			}
			case "ImportExpression": {
				const importSpecifier = getStaticString(node.source);
				if (importSpecifier) {
					inspectModuleImport(importSpecifier);
				} else if (
					!isAstroLoggerImport(node.source, ancestors, bindings)
				) {
					rejectDynamicImport();
				}
				return;
			}
			case "CallExpression": {
				const callee = node.callee;
				if (
					!isSyntaxNode(callee) ||
					(bindingRole(callee) !== "require" &&
						bindingRole(callee) !== "resolve" &&
						!(
							callee.type === "MemberExpression" &&
							!callee.computed &&
							isIdentifier(callee.property, "resolve") &&
							bindingRole(callee.object) === "require"
						) &&
						!(
							isUnbound(callee) &&
							(isIdentifier(callee, "require") ||
								isIdentifier(callee, "__require"))
						))
				) {
					return;
				}
				const arguments_ = node.arguments;
				if (
					bindingRole(callee) === "resolve" &&
					(!Array.isArray(arguments_) || arguments_.length !== 1)
				)
					rejectDynamicImport(
						"resolution options or additional arguments are not accounted for; use require.resolve('package') or import.meta.resolve('package') without options",
					);
				const requireArgument: unknown = Array.isArray(
					arguments_,
				)
					? arguments_[0]
					: undefined;
				collectPackageImport(
					getStaticString(requireArgument) ??
						rejectDynamicImport(),
				);
				return;
			}
			default: {
				return;
			}
		}
	});
	return dependencyNames;
}

function inlineJavaScript(url: URL): string | undefined {
	url.hash = "";
	const comma = url.href.indexOf(",");
	const header = url.href.slice(5, comma).trim();
	if (
		comma < 0 ||
		!/^(?:text|application)\/javascript\s*(?:;|$)/i.test(header)
	)
		return undefined;
	// Data URLs percent-decode bytes first, including base64 padding. A raw
	// percent sign (e.g. the JS remainder operator) remains part of the source.
	const body = Buffer.from(url.href.slice(comma + 1))
		.toString("latin1")
		.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
	return Buffer.from(
		body,
		/; *base64$/i.test(header) ? "base64" : "latin1",
	).toString("utf8");
}

declare const bareSpecifierBrand: unique symbol;

type BareImportSpecifier = string & {
	readonly [bareSpecifierBrand]: "BareImportSpecifier";
};

function isBareImportSpecifier(
	importSpecifier: string,
): importSpecifier is BareImportSpecifier {
	if (
		importSpecifier.startsWith(".") ||
		importSpecifier.startsWith("/") ||
		importSpecifier.startsWith("file:") ||
		URL.parse(importSpecifier)?.protocol === "data:"
	) {
		return false;
	}
	return !isBuiltin(importSpecifier);
}

function packageNameFromSpecifier(
	bareSpecifier: BareImportSpecifier,
): string {
	if (bareSpecifier.startsWith("@")) {
		return bareSpecifier.split("/").slice(0, 2).join("/");
	}
	const slashIndex = bareSpecifier.indexOf("/");
	return slashIndex === -1
		? bareSpecifier
		: bareSpecifier.slice(0, slashIndex);
}

function isAstroLoggerImport(
	sourceNode: unknown,
	ancestors: SyntaxNode[],
	{
		sameBinding,
		isStableBinding,
	}: Pick<
		ReturnType<typeof runtimeLoaderBindings>,
		"sameBinding" | "isStableBinding"
	>,
): boolean {
	// Astro's builtin logger dispatch survives minification; its local names do not.
	const dispatch = ancestors.findLast(
		(node) => node.type === "SwitchStatement",
	);
	const loader = ancestors.findLast(
		(node) => node.type === "FunctionDeclaration",
	);
	const branch = ancestors.findLast(
		(node) => node.type === "SwitchCase",
	);
	if (
		!dispatch ||
		!loader ||
		!branch ||
		!Array.isArray(dispatch.cases) ||
		!isSyntaxNode(dispatch.discriminant) ||
		!isSyntaxNode(dispatch.discriminant.object) ||
		dispatch.discriminant.object.type !== "Identifier" ||
		!Array.isArray(loader.params) ||
		!isSyntaxNode(loader.body) ||
		!Array.isArray(loader.body.body)
	)
		return false;
	const configName = dispatch.discriminant.object.name;
	if (
		typeof configName !== "string" ||
		!sameBinding(loader.params[0], dispatch.discriminant.object)
	)
		return false;
	const isEntrypoint = (
		value: unknown,
		object: string,
	): boolean =>
		isSyntaxNode(value) &&
		value.type === "MemberExpression" &&
		isIdentifier(value.object, object) &&
		(value.computed
			? getStaticString(value.property) === "entrypoint"
			: isIdentifier(value.property, "entrypoint"));
	if (!isEntrypoint(dispatch.discriminant, configName))
		return false;
	const cases = dispatch.cases.flatMap((node) =>
		isSyntaxNode(node) ? [getStaticString(node.test)] : [],
	);
	if (
		![
			"astro/logger/node",
			"astro/logger/console",
			"astro/logger/json",
			"astro/logger/compose",
		].every((name) => cases.includes(name))
	)
		return false;
	for (const statement of loader.body.body as unknown[]) {
		if (
			!isSyntaxNode(statement) ||
			statement.type !== "VariableDeclaration" ||
			!Array.isArray(statement.declarations)
		)
			continue;
		for (const declaration of statement.declarations as unknown[]) {
			if (
				!isSyntaxNode(declaration) ||
				!isSyntaxNode(declaration.id) ||
				declaration.id.type !== "Identifier" ||
				typeof declaration.id.name !== "string" ||
				!isSyntaxNode(declaration.init) ||
				declaration.init.type !== "CallExpression" ||
				!isSyntaxNode(declaration.init.callee) ||
				declaration.init.callee.type !== "Identifier" ||
				typeof declaration.init.callee.name !== "string" ||
				!Array.isArray(declaration.init.arguments) ||
				declaration.init.arguments.length !== 1 ||
				!isEntrypoint(
					declaration.init.arguments[0],
					configName,
				) ||
				!isSyntaxNode(declaration.init.arguments[0]) ||
				!sameBinding(
					declaration.init.arguments[0].object,
					loader.params[0],
				)
			)
				continue;
			if (
				branch.test === null &&
				sameBinding(sourceNode, declaration.id) &&
				isStableBinding(declaration.id)
			)
				return true;
			const callback = ancestors.findLast(
				(node) => node.type === "ArrowFunctionExpression",
			);
			const parameter: unknown =
				callback && Array.isArray(callback.params)
					? callback.params[0]
					: undefined;
			if (
				getStaticString(branch.test) ===
					"astro/logger/compose" &&
				isSyntaxNode(parameter) &&
				parameter.type === "Identifier" &&
				typeof parameter.name === "string" &&
				isSyntaxNode(sourceNode) &&
				sourceNode.type === "CallExpression" &&
				sameBinding(
					sourceNode.callee,
					declaration.init.callee,
				) &&
				isStableBinding(declaration.init.callee) &&
				Array.isArray(sourceNode.arguments) &&
				sourceNode.arguments.length === 1 &&
				isEntrypoint(sourceNode.arguments[0], parameter.name) &&
				isSyntaxNode(sourceNode.arguments[0]) &&
				sameBinding(sourceNode.arguments[0].object, parameter)
			)
				return true;
		}
	}
	return false;
}

function isRelativeSpecifier(specifier: string): boolean {
	return (
		specifier.startsWith("./") || specifier.startsWith("../")
	);
}

function isIdentifier(value: unknown, name: string): boolean {
	return (
		isSyntaxNode(value) &&
		value.type === "Identifier" &&
		value.name === name
	);
}

interface SyntaxNode {
	type: string;
	[property: string]: unknown;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function visitSyntax(
	node: SyntaxNode,
	visitor: (node: SyntaxNode, ancestors: SyntaxNode[]) => void,
	ancestors: SyntaxNode[] = [],
): void {
	visitor(node, ancestors);
	const nextAncestors = [...ancestors, node];
	for (const value of Object.values(node)) {
		if (isSyntaxNode(value))
			visitSyntax(value, visitor, nextAncestors);
		else if (Array.isArray(value)) {
			for (const child of value) {
				if (isSyntaxNode(child))
					visitSyntax(child, visitor, nextAncestors);
			}
		}
	}
}

interface EmittedNamespace {
	get(name: string, seen: Set<unknown>): LoaderRole | undefined;
}

function exportName(value: unknown): string | undefined {
	return isSyntaxNode(value) && typeof value.name === "string"
		? value.name
		: getStaticString(value);
}

/** Resolve a static export back to its lexical binding without evaluating either module. */
function emittedNamespace(
	program: SyntaxNode,
	bindingRole: (
		value: unknown,
		seen?: Set<unknown>,
	) => LoaderRole | undefined,
	resolveImport: (specifier: string) => LoaderRole | undefined,
): EmittedNamespace {
	type ReadRole = (seen: Set<unknown>) => LoaderRole | undefined;
	const exports = new Map<string, ReadRole>();
	const stars: Array<() => LoaderRole | undefined> = [];
	for (const statement of program.body as SyntaxNode[]) {
		const { declaration, source } = statement;
		if (statement.type === "ExportDefaultDeclaration") {
			exports.set("default", (seen) =>
				bindingRole(declaration, seen),
			);
			continue;
		}
		if (
			statement.type !== "ExportNamedDeclaration" &&
			statement.type !== "ExportAllDeclaration"
		)
			continue;
		const specifier = getStaticString(source);
		const imported = () =>
			specifier ? resolveImport(specifier) : undefined;
		if (statement.type === "ExportAllDeclaration") {
			const name = exportName(statement.exported);
			if (name) exports.set(name, imported);
			else stars.push(imported);
			continue;
		}
		if (isSyntaxNode(declaration)) {
			if (Array.isArray(declaration.declarations)) {
				const bindPattern = (id: unknown): void => {
					if (!isSyntaxNode(id)) return;
					if (
						id.type === "Identifier" &&
						typeof id.name === "string"
					)
						exports.set(id.name, (seen) =>
							bindingRole(id, seen),
						);
					else if (
						id.type === "ObjectPattern" &&
						Array.isArray(id.properties)
					)
						for (const prop of id.properties as SyntaxNode[])
							bindPattern(prop.value ?? prop.argument);
					else if (
						id.type === "ArrayPattern" &&
						Array.isArray(id.elements)
					)
						for (const element of id.elements)
							bindPattern(element);
					else if (
						id.type === "AssignmentPattern" ||
						id.type === "RestElement"
					)
						bindPattern(id.left ?? id.argument);
				};
				for (const d of declaration.declarations as SyntaxNode[])
					bindPattern(d.id);
			} else {
				const name = exportName(declaration.id);
				if (name) exports.set(name, () => undefined);
			}
		}
		for (const item of statement.specifiers as SyntaxNode[]) {
			const name = exportName(item.exported),
				local = exportName(item.local);
			if (name && local)
				exports.set(name, (seen) =>
					specifier
						? loaderPropertyRole(imported(), local, seen)
						: bindingRole(item.local, seen),
				);
		}
	}
	const keys = new Map<string, object>();
	return {
		get(name, seen) {
			const key = keys.get(name) ?? {};
			if (seen.has(key)) return undefined;
			keys.set(name, key);
			const path = new Set(seen).add(key);
			const explicit = exports.get(name);
			if (explicit) return explicit(path);
			if (name !== "default")
				for (const target of stars) {
					const role = loaderPropertyRole(target(), name, path);
					if (role) return role;
				}
			return undefined;
		},
	};
}

type LoaderRole =
	| EmittedNamespace
	| "factory"
	| "require"
	| "resolve"
	| "module"
	| "meta"
	| "process"
	| "builtin"
	| "register";

function builtinModuleRole(
	specifier: string | undefined,
): LoaderRole | undefined {
	if (["module", "node:module"].includes(specifier ?? ""))
		return "module";
	if (["process", "node:process"].includes(specifier ?? ""))
		return "process";
	return undefined;
}

function loaderPropertyRole(
	role: LoaderRole | undefined,
	property: unknown,
	seen = new Set<unknown>(),
): LoaderRole | undefined {
	if (typeof role === "object" && typeof property === "string")
		return role.get(property, seen);
	if (role === "module") {
		if (property === "register") return "register";
		if (property === "createRequire") return "factory";
		if (property === "default" || property === "Module")
			return "module";
	}
	if (role === "process") {
		if (property === "getBuiltinModule") return "builtin";
		if (property === "default") return "process";
	}
	if (role === "meta" && property === "resolve")
		return "resolve";
	return undefined;
}

function isLoaderPattern(
	value: unknown,
	role?: LoaderRole,
	bindingRole?: (value: unknown) => LoaderRole | undefined,
): boolean {
	return (
		isSyntaxNode(value) &&
		value.type === "ObjectPattern" &&
		Array.isArray(value.properties) &&
		value.properties.length > 0 &&
		value.properties.every(
			(property: unknown) =>
				isSyntaxNode(property) &&
				property.type === "Property" &&
				!property.computed &&
				isSyntaxNode(property.key) &&
				(property.key.type === "Identifier" ||
					getStaticString(property.key) !== undefined) &&
				(role !== "module" ||
					(!isIdentifier(property.key, "register") &&
						getStaticString(property.key) !== "register")) &&
				isSyntaxNode(property.value) &&
				property.value.type === "Identifier" &&
				(!bindingRole ||
					bindingRole(property.value) ===
						loaderPropertyRole(
							role,
							property.key.type === "Identifier"
								? property.key.name
								: getStaticString(property.key),
						)),
		)
	);
}

/** Resolve lexical bindings before inspecting calls, including declarations after a use. */
function runtimeLoaderBindings(
	program: SyntaxNode,
	resolveImport: (specifier: string) => LoaderRole | undefined,
): {
	bindingRole: (
		value: unknown,
		seen?: Set<unknown>,
	) => LoaderRole | undefined;
	isUnbound: (value: unknown) => boolean;
	sameBinding: (a: unknown, b: unknown) => boolean;
	isStableBinding: (value: SyntaxNode) => boolean;
} {
	interface Binding {
		value?: unknown;
		importRole?: (seen: Set<unknown>) => LoaderRole | undefined;
		role?: LoaderRole;
		property?: string;
		previous?: Binding;
		declaration?: SyntaxNode;
		bodyScope?: Scope;
		direct?: boolean;
	}
	interface Scope {
		parent?: Scope;
		varScope: boolean;
		bindings: Map<string, Binding>;
		parameters?: Map<string, Binding>;
	}
	const scopes = new Map<SyntaxNode, Scope>();
	const declarePattern = (
		value: unknown,
		scope: Scope,
		binding: Binding = {},
	) => {
		if (!isSyntaxNode(value)) return;
		if (
			value.type === "Identifier" &&
			typeof value.name === "string"
		)
			scope.bindings.set(value.name, binding);
		else if (value.type === "RestElement")
			declarePattern(value.argument, scope);
		else if (value.type === "AssignmentPattern")
			declarePattern(value.left, scope, {
				...binding,
				value: value.right,
			});
		else if (
			value.type === "ArrayPattern" &&
			Array.isArray(value.elements)
		) {
			for (const element of value.elements)
				declarePattern(element, scope);
		} else if (
			value.type === "ObjectPattern" &&
			Array.isArray(value.properties)
		) {
			for (const property of value.properties as unknown[]) {
				if (isSyntaxNode(property)) {
					const key = property.computed
						? getStaticString(property.key)
						: exportName(property.key);
					declarePattern(
						property.type === "RestElement"
							? property.argument
							: property.value,
						scope,
						typeof key === "string" &&
							isSyntaxNode(property.value) &&
							property.value.type === "Identifier"
							? {
									value: binding.value,
									property: key,
								}
							: {},
					);
				}
			}
		}
	};
	visitSyntax(program, (node, ancestors) => {
		const parent = ancestors.at(-1);
		const outer =
			parent?.type === "SwitchStatement" &&
			parent.discriminant === node
				? scopes.get(parent)?.parent
				: parent
					? scopes.get(parent)
					: undefined;
		const isFunction =
			/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
				node.type,
			);
		// Parameter expressions cannot observe the separate body var environment.
		const separatesParameters =
			node.type === "BlockStatement" &&
			parent?.body === node &&
			Array.isArray(parent.params) &&
			parent.params.some((param: unknown) => {
				if (!isSyntaxNode(param)) return false;
				let expression = false;
				visitSyntax(param, (child) => {
					if (
						child.type === "AssignmentPattern" ||
						(child.type === "Property" && child.computed)
					)
						expression = true;
				});
				return expression;
			});
		const isVarScope =
			isFunction ||
			node.type === "StaticBlock" ||
			separatesParameters;
		if (
			(node.type === "FunctionDeclaration" ||
				node.type === "ClassDeclaration") &&
			outer
		)
			declarePattern(node.id, outer);
		const scope: Scope =
			!outer ||
			isVarScope ||
			[
				"BlockStatement",
				"ClassDeclaration",
				"ClassExpression",
				"CatchClause",
				"ForStatement",
				"ForInStatement",
				"ForOfStatement",
				"SwitchStatement",
			].includes(node.type)
				? {
						parent: outer,
						varScope: !outer || isVarScope,
						parameters: separatesParameters
							? outer?.bindings
							: undefined,
						bindings: separatesParameters
							? new Map(outer?.bindings)
							: new Map<string, Binding>(),
					}
				: outer;
		scopes.set(node, scope);
		if (
			node.type === "ClassDeclaration" ||
			node.type === "ClassExpression"
		)
			declarePattern(node.id, scope);
		if (isFunction) {
			declarePattern(node.id, scope);
			if (Array.isArray(node.params))
				for (const param of node.params)
					declarePattern(param, scope);
		}
		if (node.type === "CatchClause")
			declarePattern(node.param, scope);
		if (node.type === "VariableDeclarator") {
			let target = scope;
			if (parent?.kind === "var")
				while (!target.varScope && target.parent)
					target = target.parent;
			if (
				parent?.kind === "var" &&
				node.init === null &&
				isSyntaxNode(node.id) &&
				node.id.type === "Identifier" &&
				typeof node.id.name === "string" &&
				target.bindings.has(node.id.name)
			)
				return;
			const name = isSyntaxNode(node.id)
				? node.id.name
				: undefined;
			const previous =
				parent?.kind === "var" &&
				typeof name === "string" &&
				target.parameters?.has(name)
					? target.bindings.get(name)
					: undefined;
			declarePattern(
				node.id,
				target,
				previous
					? {
							value: node.init,
							previous,
							declaration: node,
							bodyScope: target,
							direct:
								scope === target &&
								ancestors.at(-2)?.type === "BlockStatement",
						}
					: { value: node.init },
			);
		}
		if (
			node.type === "ImportDeclaration" &&
			Array.isArray(node.specifiers)
		) {
			const source = getStaticString(node.source);
			if (!source) return;
			for (const item of node.specifiers as SyntaxNode[]) {
				declarePattern(item.local, scope, {
					importRole: (seen) => {
						const imported = resolveImport(source);
						if (item.type === "ImportNamespaceSpecifier")
							return imported;
						return loaderPropertyRole(
							imported,
							item.type === "ImportDefaultSpecifier"
								? "default"
								: exportName(item.imported),
							seen,
						);
					},
				});
			}
		}
	});
	const lookup = (value: SyntaxNode): Binding | undefined => {
		if (typeof value.name !== "string") return undefined;
		let scope = scopes.get(value);
		while (scope) {
			const binding = scope.bindings.get(value.name);
			if (binding) return binding;
			scope = scope.parent;
		}
		return undefined;
	};
	const isUnbound = (value: unknown): boolean =>
		isSyntaxNode(value) &&
		value.type === "Identifier" &&
		!lookup(value);
	const sameBinding = (a: unknown, b: unknown): boolean =>
		isSyntaxNode(a) &&
		isSyntaxNode(b) &&
		a.type === "Identifier" &&
		isIdentifier(b, String(a.name)) &&
		lookup(a) === lookup(b);
	// Full minification can emit a single-init let in place of const.
	// Keep lexical identity and reject any later write to that binding.
	let writtenBindings: Set<Binding> | undefined;
	const isStableBinding = (value: SyntaxNode): boolean => {
		const binding = lookup(value);
		if (!binding) return false;
		if (!writtenBindings) {
			const writes = new Set<Binding>();
			const initializers = new Set<Binding>();
			const mark = (
				target: unknown,
				initialize: boolean,
			): void => {
				if (!isSyntaxNode(target)) return;
				switch (target.type) {
					case "Identifier": {
						const entry = lookup(target);
						if (!entry) return;
						if (!initialize || initializers.has(entry))
							writes.add(entry);
						else initializers.add(entry);
						return;
					}
					case "ArrayPattern":
						for (const element of target.elements as unknown[])
							mark(element, initialize);
						return;
					case "ObjectPattern":
						for (const property of target.properties as SyntaxNode[])
							mark(
								property.type === "RestElement"
									? property.argument
									: property.value,
								initialize,
							);
						return;
					case "AssignmentPattern":
						mark(target.left, initialize);
						return;
					case "RestElement":
						mark(target.argument, initialize);
				}
			};
			visitSyntax(program, (node, ancestors) => {
				if (node.type === "AssignmentExpression")
					mark(node.left, false);
				else if (node.type === "UpdateExpression")
					mark(node.argument, false);
				else if (
					node.type === "ForInStatement" ||
					node.type === "ForOfStatement"
				)
					mark(node.left, false);
				else if (node.type === "VariableDeclarator") {
					const declaration = ancestors.at(-2);
					const repeated =
						declaration?.type === "ForInStatement" ||
						declaration?.type === "ForOfStatement";
					if (node.init || repeated) mark(node.id, !repeated);
				}
			});
			writtenBindings = writes;
		}
		return !writtenBindings.has(binding);
	};
	const roleOf = (
		value: unknown,
		seen = new Set<unknown>(),
	): LoaderRole | undefined => {
		if (!isSyntaxNode(value) || seen.has(value))
			return undefined;
		seen.add(value);
		if (
			value.type === "MetaProperty" &&
			isIdentifier(value.meta, "import") &&
			isIdentifier(value.property, "meta")
		)
			return "meta";
		if (value.type === "ImportExpression")
			return resolveImport(getStaticString(value.source) ?? "");
		if (value.type === "AwaitExpression")
			return roleOf(value.argument, seen);
		if (
			value.type === "SequenceExpression" &&
			Array.isArray(value.expressions)
		)
			return roleOf(value.expressions.at(-1), seen);
		if (
			value.type === "AssignmentExpression" &&
			value.operator === "=" &&
			roleOf(value.right, seen) === "process"
		)
			return "process";
		if (
			value.type === "Identifier" &&
			typeof value.name === "string"
		) {
			const binding = lookup(value);
			if (binding) {
				const read = (
					record: Binding,
				): LoaderRole | undefined => {
					if (
						record.previous &&
						record.declaration &&
						record.declaration.id !== value
					) {
						let frame = scopes.get(value);
						while (frame && !frame.varScope)
							frame = frame.parent;
						const sameFrame = frame === record.bodyScope;
						if (
							sameFrame &&
							Number(value.start) <
								Number(record.declaration.end)
						)
							return read(record.previous);
						// A nested function or conditional initializer can still observe the parameter.
						if (
							(!sameFrame || !record.direct) &&
							read(record.previous) === "process"
						)
							return "process";
					}
					const role =
						record.importRole?.(seen) ??
						record.role ??
						roleOf(record.value, new Set(seen));
					return record.property
						? loaderPropertyRole(role, record.property, seen)
						: role;
				};
				return read(binding);
			}
			if (value.name === "process") return "process";
		}
		if (value.type === "MemberExpression") {
			const role = roleOf(value.object, seen);
			const property = value.computed
				? getStaticString(value.property)
				: isSyntaxNode(value.property) &&
					  value.property.type === "Identifier"
					? value.property.name
					: undefined;
			if (
				property === "process" &&
				isIdentifier(value.object, "globalThis") &&
				isUnbound(value.object)
			)
				return "process";
			if (
				!value.computed ||
				role === "process" ||
				typeof role === "object"
			) {
				const selected = loaderPropertyRole(
					role,
					property,
					seen,
				);
				if (selected) return selected;
			}
			if (
				property === "resolve" &&
				(role === "meta" ||
					(!value.computed && role === "require"))
			)
				return "resolve";
		}
		if (value.type === "CallExpression") {
			const role = roleOf(value.callee, seen);
			if (role === "factory") return "require";
			if (
				(role === "builtin" || role === "require") &&
				Array.isArray(value.arguments) &&
				value.arguments.length === 1
			) {
				const specifier = getStaticString(value.arguments[0]);
				if (
					role === "require" &&
					specifier &&
					isRelativeSpecifier(specifier)
				)
					return resolveImport(specifier);
				return builtinModuleRole(specifier);
			}
		}

		if (
			value.type === "ConditionalExpression" &&
			[value.consequent, value.alternate].some(
				(branch) => roleOf(branch, new Set(seen)) === "process",
			)
		)
			return "process";

		if (
			value.type === "LogicalExpression" &&
			(roleOf(value.right, new Set(seen)) === "process" ||
				(value.operator !== "&&" &&
					roleOf(value.left, seen) === "process"))
		)
			return "process";
		return undefined;
	};
	return {
		bindingRole: roleOf,
		isUnbound,
		sameBinding,
		isStableBinding,
	};
}
