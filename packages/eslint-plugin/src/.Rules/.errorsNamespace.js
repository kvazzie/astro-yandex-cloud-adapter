import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** @type {import("eslint").Rule.RuleModule} */
const errorsNamespaceRule = {
	meta: {
		type: "problem",
		schema: [],
		messages: {
			importNamespace:
				'Import errors through the module index, e.g. Options.Errors.InvalidConfiguration. Only its index may import "./Errors.ts", as namespace Errors.',
			exportNamespace:
				'Export errors only as `export * as Errors from "./Errors.ts"` from their module index.',
			missingExport:
				'This index has a neighboring Errors.ts and must export it with `export * as Errors from "./Errors.ts"`.',
		},
	},
	create(context) {
		const isIndex = basename(context.filename) === "index.ts";
		/** @param {unknown} value */
		const isErrorsSource = (value) =>
			typeof value === "string" &&
			/(?:^|\/)[Ee]rrors(?:\.[cm]?[jt]s)?$/.test(value);
		let hasErrorsExport = false;

		return {
			ImportDeclaration(node) {
				if (!isErrorsSource(node.source.value)) return;
				const [specifier] = node.specifiers;
				if (
					!isIndex ||
					node.source.value !== "./Errors.ts" ||
					node.specifiers.length !== 1 ||
					specifier?.type !== "ImportNamespaceSpecifier" ||
					specifier.local.name !== "Errors"
				) {
					context.report({ node, messageId: "importNamespace" });
				}
			},
			ExportNamedDeclaration(node) {
				if (isErrorsSource(node.source?.value)) {
					context.report({ node, messageId: "exportNamespace" });
				}
			},
			ExportAllDeclaration(node) {
				if (!isErrorsSource(node.source.value)) return;
				if (
					isIndex &&
					node.source.value === "./Errors.ts" &&
					node.exported?.type === "Identifier" &&
					node.exported.name === "Errors" &&
					!("exportKind" in node && node.exportKind === "type")
				) {
					hasErrorsExport = true;
				} else {
					context.report({ node, messageId: "exportNamespace" });
				}
			},
			/** @param {import("eslint").Rule.Node} node */
			"ImportExpression > Literal.source, TSImportType > Literal.source, TSExternalModuleReference > Literal, CallExpression[callee.name='require'] > Literal.arguments"(
				node,
			) {
				if (
					node.type === "Literal" &&
					isErrorsSource(node.value)
				) {
					context.report({ node, messageId: "importNamespace" });
				}
			},
			"Program:exit"(node) {
				if (
					isIndex &&
					existsSync(
						join(dirname(context.filename), "Errors.ts"),
					) &&
					!hasErrorsExport
				) {
					context.report({ node, messageId: "missingExport" });
				}
			},
		};
	},
};

export default errorsNamespaceRule;
