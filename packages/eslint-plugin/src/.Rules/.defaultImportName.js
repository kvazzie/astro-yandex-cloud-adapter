import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** @type {import("eslint").Rule.RuleModule} */
const defaultImportNameRule = {
	meta: {
		type: "problem",
		schema: [
			{
				type: "object",
				properties: {
					includePackageEntrypoints: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		messages: {
			name: 'Import the default export of "{{directory}}" as "{{expected}}".',
			directory:
				'Directory "{{directory}}" cannot form a PascalCase import identifier.',
		},
	},
	create(context) {
		/** @type {unknown} */
		const options = context.options[0];
		const includePackageEntrypoints =
			typeof options === "object" &&
			options !== null &&
			"includePackageEntrypoints" in options &&
			options.includePackageEntrypoints === true;

		/** @param {string} source */
		function moduleDirectory(source) {
			if (!/^(?:\.{1,2})(?:\/|$)/.test(source)) return;
			const path = source.split(/[?#]/)[0];
			if (!path) return;
			const absolute = resolve(dirname(context.filename), path);
			const stem = absolute.replace(/\.(?:js|ts)$/, "");

			if (!/\/$|^\.{1,2}$/.test(path)) {
				for (const extension of ["ts", "js"]) {
					const file = `${stem}.${extension}`;
					if (existsSync(file)) {
						return basename(file) === `index.${extension}`
							? dirname(file)
							: undefined;
					}
				}
			}

			if (
				existsSync(join(absolute, "index.ts")) ||
				existsSync(join(absolute, "index.js"))
			)
				return absolute;
		}

		return {
			ImportDeclaration(node) {
				const defaults = node.specifiers.filter(
					(specifier) =>
						specifier.type === "ImportDefaultSpecifier" ||
						(specifier.type === "ImportSpecifier" &&
							(specifier.imported.type === "Identifier"
								? specifier.imported.name
								: specifier.imported.value) === "default"),
				);
				if (
					!defaults.length ||
					typeof node.source.value !== "string"
				)
					return;
				const directory = moduleDirectory(node.source.value);
				if (!directory) return;
				const folder = basename(directory);
				if (
					!includePackageEntrypoints &&
					(existsSync(join(directory, "package.json")) ||
						(folder === "src" &&
							existsSync(
								join(dirname(directory), "package.json"),
							)))
				)
					return;

				const expected = folder
					.split(/[-_.\s]+/)
					.filter(Boolean)
					.map(
						(word) =>
							word.charAt(0).toUpperCase() + word.slice(1),
					)
					.join("");
				for (const specifier of defaults) {
					if (!/^[A-Z_$][\w$]*$/.test(expected)) {
						context.report({
							node: specifier.local,
							messageId: "directory",
							data: { directory: folder },
						});
					} else if (specifier.local.name !== expected) {
						context.report({
							node: specifier.local,
							messageId: "name",
							data: { directory: folder, expected },
						});
					}
				}
			},
		};
	},
};

export default defaultImportNameRule;
