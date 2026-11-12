# ESLint rules

`@astro-yandex-cloud/eslint-plugin` is a private workspace
package for repository module conventions. It exports a native
ESM plugin and requires ESLint 9.32 or later in the 9.x line. No
build step is needed before loading the plugin.

```js
import yandexCloud from "@astro-yandex-cloud/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    plugins: { "astro-yandex-cloud": yandexCloud },
    rules: {
      "astro-yandex-cloud/errors-namespace": "error",
      "astro-yandex-cloud/import-paths": "error",
      "astro-yandex-cloud/default-import-name": "error",
    },
  },
];
```

## errors-namespace

Modules keep error declarations in `Errors.ts` and expose them
through their index:

```ts
export * as Errors from "./Errors.ts";
```

Only that module's `index.ts` may import `./Errors.ts` directly,
using `import * as Errors`. Consumers import the module index and
access constructors through its `Errors` namespace, for example
`Options.Errors.InvalidConfiguration`. Named re-exports, a
different namespace name, type-only namespace exports, and direct
dynamic or CommonJS imports of the errors file are rejected.
Every linted `index.ts` with a neighboring `Errors.ts` must
contain the namespace export.

The rule inspects literal module specifiers. It does not resolve
path aliases or computed import expressions. It also permits
importing `Errors` by name from a module index.

## import-paths

Relative imports of TypeScript files use `.ts`. Imports of
directories use the directory path without `/index`, including
imports of the current directory as `.` and the parent directory
as `..`.

```ts
import * as Options from "./Options";
import preview from "./.preview.ts";
```

The rule checks imports, re-exports, literal dynamic imports,
import types, and literal `require` calls. It resolves relative
paths against the importing file and supports `eslint --fix`. A
trailing slash distinguishes a directory from a same-named `.ts`
file. Package imports, assets, native JavaScript files, and
computed expressions keep their existing paths.

TypeScript sources use `moduleResolution: "Bundler"` and
`allowImportingTsExtensions: true`. tsdown and Vite resolve these
source paths; published JavaScript keeps runtime-compatible
imports. The plugin itself runs directly in Node.js and retains
`NodeNext` resolution and explicit `.js` imports.

## default-import-name

Default imports of internal directory modules use the directory
name in PascalCase:

```ts
import Hooks from "./Hooks";
import FunctionRuntimeBridge from "./FunctionRuntimeBridge";
```

The rule resolves relative directory imports and explicit
`index.ts` or `index.js` paths. It checks default bindings in
ordinary and type-only imports, including
`import { default as Hooks }`. Project module directories use
PascalCase. For other checked directories, the rule also converts
kebab-case, snake_case, and camelCase names into PascalCase
identifiers. A sibling `.ts` file takes precedence over an
extensionless directory import; a trailing slash selects the
directory explicitly.

Package imports, imports of individual files, named imports,
namespace imports, and re-exports are outside this rule.
Unresolved paths are left to TypeScript. A directory name that
cannot form a PascalCase identifier is reported.

Public package entrypoints are excluded by default: directories
containing `package.json`, and a package's immediate `src`
directory. To include these local entrypoints, configure:

```js
"astro-yandex-cloud/default-import-name": [
  "error",
  { includePackageEntrypoints: true },
]
```

The rule reports invalid names without an autofix. Renaming a
binding and all its references requires checking for scope
collisions.

The root lint command checks this package. Run its type check
with:

```sh
pnpm --filter @astro-yandex-cloud/eslint-plugin typecheck
```
