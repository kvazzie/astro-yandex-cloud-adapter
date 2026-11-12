import metadata from "../package.json" with { type: "json" };

import errorsNamespace from "./.Rules/.errorsNamespace.js";
import importPaths from "./.Rules/.importPaths.js";
import defaultImportName from "./.Rules/.defaultImportName.js";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
	meta: {
		name: metadata.name,
		version: metadata.version,
	},
	rules: {
		"errors-namespace": errorsNamespace,
		"import-paths": importPaths,
		"default-import-name": defaultImportName,
	},
};

export default plugin;
