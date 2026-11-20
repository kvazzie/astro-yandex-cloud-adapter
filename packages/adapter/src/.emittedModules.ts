import { parse } from "acorn";

export interface SyntaxNode {
	type: string;
	start: number;
	end: number;
	[property: string]: unknown;
}

/** Parses emitted ESM without running application code during Artifact Generation. */
export function parseModule(source: string): SyntaxNode {
	return parse(source, {
		allowHashBang: true,
		ecmaVersion: "latest",
		sourceType: "module",
	}) as unknown as SyntaxNode;
}

/** Visits syntax nodes while keeping source offsets for narrowly scoped edits. */
export function visitSyntax(
	node: SyntaxNode,
	visitor: (node: SyntaxNode) => void,
): void {
	visitor(node);
	for (const value of Object.values(node)) {
		if (isSyntaxNode(value)) visitSyntax(value, visitor);
		else if (Array.isArray(value)) {
			for (const child of value) {
				if (isSyntaxNode(child)) visitSyntax(child, visitor);
			}
		}
	}
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

/** Collects the fixed local module and asset edges of Astro's emitted graph. */
export function localModuleReferences(source: string): string[] {
	const references = new Set<string>();
	visitSyntax(parseModule(source), (node) => {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration" ||
			node.type === "ImportExpression"
		) {
			const source = getStaticString(node.source);
			if (source?.startsWith(".")) references.add(source);
		}
		if (
			node.type === "NewExpression" &&
			isSyntaxNode(node.callee) &&
			node.callee.type === "Identifier" &&
			node.callee.name === "URL" &&
			Array.isArray(node.arguments)
		) {
			const [source, base] = node.arguments as unknown[];
			if (
				getStaticString(source)?.startsWith(".") &&
				isSyntaxNode(base) &&
				base.type === "MemberExpression" &&
				isSyntaxNode(base.object) &&
				base.object.type === "MetaProperty"
			) {
				references.add(getStaticString(source)!);
			}
		}
	});
	return [...references];
}
