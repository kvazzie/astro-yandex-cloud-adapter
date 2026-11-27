import { parse, type Comment } from "acorn";

export interface SyntaxNode {
	type: string;
	start: number;
	end: number;
	[property: string]: unknown;
}

/** Parses runtime syntax without running application code during Artifact Generation. */
export function parseModule(
	source: string,
	sourceType: "module" | "commonjs" = "module",
	/** Receives the comments, which the syntax tree omits. */
	comments?: Comment[],
): SyntaxNode {
	return parse(source, {
		allowHashBang: true,
		ecmaVersion: "latest",
		sourceType,
		...(comments ? { onComment: comments } : {}),
	}) as unknown as SyntaxNode;
}

/** Visits syntax nodes while keeping source offsets for narrowly scoped edits. */
export function visitSyntax(
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

interface LexicalScope<Binding> {
	parent?: LexicalScope<Binding>;
	varScope: boolean;
	bindings: Map<string, Binding>;
	parameters?: Map<string, Binding>;
}

/** Builds the lexical environments before consumers inspect references. */
function readLexicalScopes<Binding>(
	program: SyntaxNode,
	declare: (
		node: SyntaxNode,
		scope: LexicalScope<Binding>,
		outer: LexicalScope<Binding> | undefined,
		ancestors: SyntaxNode[],
		isFunction: boolean,
	) => void,
): ReadonlyMap<SyntaxNode, LexicalScope<Binding>> {
	const scopes = new Map<SyntaxNode, LexicalScope<Binding>>();
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
					expression ||=
						child.type === "AssignmentPattern" ||
						(child.type === "Property" &&
							child.computed === true);
				});
				return expression;
			});
		const isVarScope =
			isFunction ||
			node.type === "StaticBlock" ||
			separatesParameters;
		const scope: LexicalScope<Binding> =
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
		declare(node, scope, outer, ancestors, isFunction);
	});
	return scopes;
}

function lookupLexicalBinding<Binding>(
	scopes: ReadonlyMap<SyntaxNode, LexicalScope<Binding>>,
	value: SyntaxNode,
): Binding | undefined {
	if (typeof value.name !== "string") return undefined;
	for (
		let scope = scopes.get(value);
		scope;
		scope = scope.parent
	) {
		const binding = scope.bindings.get(value.name);
		if (binding !== undefined) return binding;
	}
	return undefined;
}

/** Returns the declaration node for an emitted module identifier. */
export function readIdentifierBindings(program: SyntaxNode) {
	const scopes = readLexicalScopes<SyntaxNode>(
		program,
		(node, scope, outer, ancestors, isFunction) => {
			if (
				node.type === "FunctionDeclaration" ||
				node.type === "ClassDeclaration"
			)
				declareBindingPattern(outer ?? scope, node.id);
			if (isFunction) {
				declareBindingPattern(scope, node.id);
				if (Array.isArray(node.params))
					for (const param of node.params)
						declareBindingPattern(scope, param);
			}
			if (
				node.type === "ClassDeclaration" ||
				node.type === "ClassExpression"
			)
				declareBindingPattern(scope, node.id);
			if (node.type === "CatchClause")
				declareBindingPattern(scope, node.param);
			if (node.type === "VariableDeclarator") {
				let target = scope;
				if (ancestors.at(-1)?.kind === "var")
					while (!target.varScope && target.parent)
						target = target.parent;
				declareBindingPattern(target, node.id);
			}
			if (
				node.type === "ImportDeclaration" &&
				Array.isArray(node.specifiers)
			)
				for (const specifier of node.specifiers)
					if (isSyntaxNode(specifier))
						declareBindingPattern(scope, specifier.local);
		},
	);
	return (identifier: SyntaxNode) =>
		lookupLexicalBinding(scopes, identifier);
}

function declareBindingPattern(
	scope: LexicalScope<SyntaxNode>,
	pattern: unknown,
): void {
	if (!isSyntaxNode(pattern)) return;
	if (
		pattern.type === "Identifier" &&
		typeof pattern.name === "string"
	)
		scope.bindings.set(pattern.name, pattern);
	else if (pattern.type === "RestElement")
		declareBindingPattern(scope, pattern.argument);
	else if (pattern.type === "AssignmentPattern")
		declareBindingPattern(scope, pattern.left);
	else if (
		pattern.type === "ArrayPattern" &&
		Array.isArray(pattern.elements)
	)
		for (const element of pattern.elements)
			declareBindingPattern(scope, element);
	else if (
		pattern.type === "ObjectPattern" &&
		Array.isArray(pattern.properties)
	)
		for (const property of pattern.properties)
			if (isSyntaxNode(property))
				declareBindingPattern(
					scope,
					property.type === "RestElement"
						? property.argument
						: property.value,
				);
}

/** Narrows a parsed child before reading syntax-specific fields. */
export function isSyntaxNode(
	value: unknown,
): value is SyntaxNode {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** Reads a fixed string, including minified no-substitution templates. */
export function getStaticString(
	value: unknown,
): string | undefined {
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

/** Reads the fixed specifier of a syntax-level module edge. */
function staticModuleReference(
	node: SyntaxNode,
): string | undefined {
	if (
		node.type === "ImportDeclaration" ||
		node.type === "ExportNamedDeclaration" ||
		node.type === "ExportAllDeclaration" ||
		node.type === "ImportExpression"
	)
		return getStaticString(node.source);
}

/** Collects the fixed local module edges of Astro's emitted graph; assets read by URL are not executed. */
export function localModuleReferences(
	source: string | SyntaxNode,
	excluded: ReadonlySet<SyntaxNode> = new Set(),
): string[] {
	const references = new Set<string>();
	const syntax =
		typeof source === "string" ? parseModule(source) : source;
	visitSyntax(syntax, (node) => {
		if (excluded.has(node)) return;
		const module = staticModuleReference(node);
		if (module?.startsWith(".")) references.add(module);
	});
	return [...references];
}
