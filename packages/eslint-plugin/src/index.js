import metadata from "../package.json" with { type: "json" };

import importPaths from "./rules/import-paths.js";

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: {
    name: metadata.name,
    version: metadata.version,
  },
  rules: {
    "import-paths": importPaths,
  },
};

export default plugin;
