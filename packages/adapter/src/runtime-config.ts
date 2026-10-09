import type { Plugin } from "vite";

import { RESOLVED_RUNTIME_CONFIG_ID, RUNTIME_CONFIG_ID } from "./constants.js";
import type { FunctionInvocationOptions } from "./runtime/types.js";

/** Embeds validated build choices in the generated Function handler. */
export function runtimeConfigPlugin(
  site: URL | string | undefined,
  options: Partial<FunctionInvocationOptions> = {},
): Plugin {
  return {
    name: "@astro-yandex-cloud/runtime-config",
    enforce: "pre",
    resolveId(id) {
      return id === RUNTIME_CONFIG_ID ? RESOLVED_RUNTIME_CONFIG_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_RUNTIME_CONFIG_ID) return undefined;
      const configuredSite = site ? new URL(site).origin : undefined;
      return [
        `export const site = ${JSON.stringify(configuredSite)};`,
        `export const apiGateway = ${JSON.stringify(options.apiGateway ?? false)};`,
        `export const directOrigin = ${JSON.stringify(options.directOrigin)};`,
      ].join("\n");
    },
  };
}
