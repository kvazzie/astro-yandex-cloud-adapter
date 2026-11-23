import type { Plugin } from "vite";

import * as Options from "../Options";

export const RUNTIME_CONFIG_ID =
	"virtual:yandex-cloud-runtime-config";
export const RESOLVED_RUNTIME_CONFIG_ID = `\0${RUNTIME_CONFIG_ID}`;

/** Embeds validated build choices in the generated Function handler. */
export function runtimeConfigPlugin(
	site: URL | string | undefined,
	options: typeof Options.Schema.Type,
): Plugin {
	return {
		name: "@astro-yandex-cloud/runtime-config",
		enforce: "pre",
		resolveId(id) {
			return id === RUNTIME_CONFIG_ID
				? RESOLVED_RUNTIME_CONFIG_ID
				: undefined;
		},
		load(id) {
			if (id !== RESOLVED_RUNTIME_CONFIG_ID) return undefined;
			const configuredSite = site
				? new URL(site).origin
				: undefined;
			const directOrigin =
				options.target ===
					Options.Targets.ObjectStorageCloudFunctionsTarget &&
				!options.apiGateway
					? options.directOrigin?.origin
					: undefined;
			return [
				`export const site = ${JSON.stringify(configuredSite)};`,
				`export const apiGateway = ${JSON.stringify(options.apiGateway)};`,
				`export const directOrigin = ${JSON.stringify(directOrigin)};`,
			].join("\n");
		},
	};
}
