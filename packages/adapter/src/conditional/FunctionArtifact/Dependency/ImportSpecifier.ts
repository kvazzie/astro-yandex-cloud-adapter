import { isBuiltin } from "node:module";
import { basename } from "node:path";
import { parse } from "acorn";
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
	for (const file of files) {
		if (!/\.m?js$/.test(basename(file.path))) continue;
		if (file.contents === undefined)
			throw new Error(
				`Missing computed module contents for ${file.path}.`,
			);
		for (const name of findImportedPackageNames(
			file.contents,
			file.path,
			strategy,
		))
			names.add(name);
	}
	return names;
}

function findImportedPackageNames(
	moduleSource: string,
	relativePath: string,
	strategy: PreparationSettings["dependencyStrategy"],
): Set<string> {
	const dependencyNames = new Set<string>();
	const program = parse(moduleSource, {
		allowHashBang: true,
		ecmaVersion: "latest",
		sourceType: "module",
	}) as unknown as SyntaxNode;

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
	const rejectDynamicImport = (): never => {
		if (strategy === "install") {
			throw new Error(
				`The Function Artifact contains unresolved dynamic runtime dependency resolution in ${relativePath}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
			);
		}
		throw new Error(
			`The Function Artifact contains unresolved dynamic or native runtime dependency resolution in ${relativePath}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
		);
	};
	const bindingRole = runtimeLoaderBindings(program);
	visitSyntax(program, (node, ancestors) => {
		const parent = ancestors.at(-1);
		if (
			node.type === "Identifier" &&
			parent &&
			((parent.type === "MemberExpression" &&
				parent.property === node &&
				!parent.computed) ||
				(parent.type === "Property" &&
					parent.key === node &&
					!parent.computed &&
					!parent.shorthand))
		)
			return;
		const role = bindingRole(node);
		if (
			role === "factory" ||
			role === "require" ||
			role === "module"
		) {
			const declaration =
				parent?.type === "VariableDeclarator" &&
				isSyntaxNode(parent.id) &&
				parent.id.type === "Identifier" &&
				ancestors.at(-3)?.type !== "ExportNamedDeclaration" &&
				(parent.id === node || parent.init === node);
			const importBinding = parent?.type.startsWith("Import");
			const awaited =
				parent?.type === "AwaitExpression" &&
				parent.argument === node;
			if (node.type === "ImportExpression" && !awaited)
				rejectDynamicImport();
			const call =
				parent?.type === "CallExpression" &&
				parent.callee === node;
			const member =
				parent?.type === "MemberExpression" &&
				parent.object === node &&
				!parent.computed &&
				((role === "module" &&
					node.type !== "ImportExpression") ||
					(role === "require" &&
						isIdentifier(parent.property, "resolve")));
			if (
				!declaration &&
				!importBinding &&
				!awaited &&
				!call &&
				!member
			)
				rejectDynamicImport();
		}
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
				argument.computed ||
				(node.arguments &&
					(node.arguments as unknown[]).length !== 1)
			)
				rejectDynamicImport();
		}
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration": {
				const importSpecifier = getStaticString(node.source);
				if (importSpecifier)
					collectPackageImport(importSpecifier);
				return;
			}
			case "ImportExpression": {
				const importSpecifier = getStaticString(node.source);
				if (importSpecifier) {
					collectPackageImport(importSpecifier);
				} else if (
					!isAstroLoggerImport(
						node.source,
						relativePath,
						ancestors,
					)
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
						!(
							callee.type === "MemberExpression" &&
							!callee.computed &&
							isIdentifier(callee.property, "resolve") &&
							bindingRole(callee.object) === "require"
						) &&
						!isIdentifier(callee, "require") &&
						!isIdentifier(callee, "__require"))
				) {
					return;
				}
				const arguments_ = node.arguments;
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
		importSpecifier.startsWith("file:")
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

function getStaticString(value: unknown): string | undefined {
	if (!isSyntaxNode(value)) return undefined;
	if (
		value.type === "Literal" &&
		typeof value.value === "string"
	) {
		return value.value;
	}
	if (value.type !== "TemplateLiteral") return undefined;
	const expressions = value.expressions;
	const quasis = value.quasis;
	if (
		!Array.isArray(expressions) ||
		expressions.length ||
		!Array.isArray(quasis)
	) {
		return undefined;
	}
	const first: unknown = (quasis as unknown[])[0];
	if (!isSyntaxNode(first)) return undefined;
	const templateValue = first.value;
	if (
		typeof templateValue !== "object" ||
		templateValue === null
	) {
		return undefined;
	}
	const cooked =
		"cooked" in templateValue ? templateValue.cooked : undefined;
	return typeof cooked === "string" ? cooked : undefined;
}

function isAstroLoggerImport(
	sourceNode: unknown,
	relativePath: string,
	ancestors: SyntaxNode[],
): boolean {
	if (
		relativePath !== "index.js" &&
		!/(^|[\\/])chunks[\\/]render-[^\\/]+\.js$/.test(relativePath)
	) {
		return false;
	}
	if (
		!ancestors.some(
			(ancestor) =>
				ancestor.type === "FunctionDeclaration" &&
				isIdentifier(ancestor.id, "loadLoggerDestination"),
		)
	) {
		return false;
	}
	if (isIdentifier(sourceNode, "entrypoint")) return true;
	if (
		!isSyntaxNode(sourceNode) ||
		sourceNode.type !== "CallExpression"
	)
		return false;
	if (!isIdentifier(sourceNode.callee, "normalizeEntrypoint"))
		return false;
	const arguments_ = sourceNode.arguments;
	const entrypointArgument: unknown = Array.isArray(arguments_)
		? arguments_[0]
		: undefined;
	return (
		isSyntaxNode(entrypointArgument) &&
		entrypointArgument.type === "MemberExpression" &&
		isIdentifier(entrypointArgument.object, "loggerConfig") &&
		isIdentifier(entrypointArgument.property, "entrypoint")
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

type LoaderRole = "factory" | "require" | "module";

/** Resolve lexical bindings before inspecting calls, including declarations after a use. */
function runtimeLoaderBindings(
	program: SyntaxNode,
): (value: unknown) => LoaderRole | undefined {
	interface Scope {
		parent?: Scope;
		functionScope: boolean;
		bindings: Map<
			string,
			{ value?: unknown; role?: LoaderRole }
		>;
	}
	const scopes = new Map<SyntaxNode, Scope>();
	const declarePattern = (
		value: unknown,
		scope: Scope,
		binding: { value?: unknown; role?: LoaderRole } = {},
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
			declarePattern(value.left, scope);
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
				if (isSyntaxNode(property))
					declarePattern(
						property.type === "RestElement"
							? property.argument
							: property.value,
						scope,
					);
			}
		}
	};
	visitSyntax(program, (node, ancestors) => {
		const parent = ancestors.at(-1);
		const outer = parent ? scopes.get(parent) : undefined;
		const isFunction =
			/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(
				node.type,
			);
		if (
			(node.type === "FunctionDeclaration" ||
				node.type === "ClassDeclaration") &&
			outer
		)
			declarePattern(node.id, outer);
		const scope =
			!outer ||
			isFunction ||
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
						functionScope: !outer || isFunction,
						bindings: new Map(),
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
				while (!target.functionScope && target.parent)
					target = target.parent;
			declarePattern(node.id, target, { value: node.init });
		}
		if (
			node.type === "ImportDeclaration" &&
			Array.isArray(node.specifiers)
		) {
			const builtin = ["module", "node:module"].includes(
				getStaticString(node.source) ?? "",
			);
			for (const specifier of node.specifiers as unknown[]) {
				if (!isSyntaxNode(specifier)) continue;
				const role: LoaderRole | undefined = !builtin
					? undefined
					: specifier.type === "ImportSpecifier"
						? isIdentifier(
								specifier.imported,
								"createRequire",
							) ||
							getStaticString(specifier.imported) ===
								"createRequire"
							? "factory"
							: undefined
						: "module";
				declarePattern(specifier.local, scope, { role });
			}
		}
	});
	const roleOf = (
		value: unknown,
		seen = new Set<unknown>(),
	): LoaderRole | undefined => {
		if (!isSyntaxNode(value) || seen.has(value))
			return undefined;
		seen.add(value);
		if (
			value.type === "ImportExpression" &&
			["module", "node:module"].includes(
				getStaticString(value.source) ?? "",
			)
		)
			return "module";
		if (value.type === "AwaitExpression")
			return roleOf(value.argument, seen);
		if (
			value.type === "Identifier" &&
			typeof value.name === "string"
		) {
			let scope = scopes.get(value);
			while (scope) {
				const binding = scope.bindings.get(value.name);
				if (binding)
					return binding.role ?? roleOf(binding.value, seen);
				scope = scope.parent;
			}
		}
		if (
			value.type === "MemberExpression" &&
			!value.computed &&
			isIdentifier(value.property, "createRequire") &&
			roleOf(value.object, seen) === "module"
		)
			return "factory";
		if (
			value.type === "MemberExpression" &&
			!value.computed &&
			isIdentifier(value.property, "resolve") &&
			roleOf(value.object, seen) === "require"
		)
			return "require";
		if (
			value.type === "CallExpression" &&
			roleOf(value.callee, seen) === "factory"
		)
			return "require";
		return undefined;
	};
	return (value) => roleOf(value);
}
