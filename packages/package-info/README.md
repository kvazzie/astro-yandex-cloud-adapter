# Package info

Read a module's package name and version from its nearest `package.json`:

```ts
import { readPackageInfo } from "@astro-yandex-cloud/package-info";

const { name, version } = readPackageInfo(import.meta.url);
```

Pass the calling module's file URL. The lookup walks its parent directories and
stops at the filesystem root or a `node_modules` directory. The nearest manifest
must contain non-empty string `name` and `version` fields. Invalid manifests and
filesystem errors are reported instead of falling back to another package.

The package runs directly in Node.js 22.12 and later. It has no runtime
dependencies. The adapter bundles it so installed adapters read their own
metadata without requiring this private workspace package at runtime.

Run its type check with `pnpm --filter @astro-yandex-cloud/package-info typecheck`.
Its tests live in `tests/unit/package-info.test.ts` and run with `pnpm test:unit`.
