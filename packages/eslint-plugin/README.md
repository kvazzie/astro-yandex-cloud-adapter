# ESLint rules

`@astro-yandex-cloud/eslint-plugin` is a private workspace package for repository
module conventions. It exports a native ESM plugin and requires ESLint 9.32 or
later in the 9.x line. No build step is needed before loading the plugin.

```js
import yandexCloud from "@astro-yandex-cloud/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    plugins: { "astro-yandex-cloud": yandexCloud },
    rules: {
      "astro-yandex-cloud/import-paths": "error",
    },
  },
];
```

## import-paths

Relative imports of TypeScript files use `.ts`. Imports of directories use the
directory path without `/index`, including imports of the current directory as
`.` and the parent directory as `..`.

```ts
import * as Target from "./target";
import { ADAPTER_NAME } from "./constants.ts";
```

The rule checks imports, re-exports, literal dynamic imports, import types, and
literal `require` calls. It resolves relative paths against the importing file
and supports `eslint --fix`. A trailing slash distinguishes a directory from a
same-named `.ts` file. Package imports, assets, native JavaScript files, and
computed expressions keep their existing paths.

TypeScript sources use `moduleResolution: "Bundler"` and
`allowImportingTsExtensions: true`. tsdown and Vite resolve these source paths;
published JavaScript keeps runtime-compatible imports. The plugin itself runs
directly in Node.js and retains `NodeNext` resolution and explicit `.js` imports.

The root lint command checks this package. Run its type check with:

```sh
pnpm --filter @astro-yandex-cloud/eslint-plugin typecheck
```
