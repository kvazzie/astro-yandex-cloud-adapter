import { createRequire } from "node:module";

import type { PackageJson } from "pkg-types";

export const ADAPTER_NAME = "@astro-yandex-cloud/adapter" as const;
const packageJson = createRequire(import.meta.url)(
  "../package.json",
) as PackageJson;
if (!packageJson.version) {
  throw new Error("The adapter package.json must declare a version.");
}
export const ADAPTER_VERSION = packageJson.version;
export const RUNTIME_CONFIG_ID = "virtual:yandex-cloud-runtime-config";
export const RESOLVED_RUNTIME_CONFIG_ID = `\0${RUNTIME_CONFIG_ID}`;
