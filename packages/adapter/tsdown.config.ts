import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		"deployment-manifest":
			"src/mandatory/DeploymentManifest/index.ts",
		index: "src/index.ts",
		preview: "src/.preview.ts",
		runtime: "src/.runtime.ts",
		server: "src/.astroHandler.ts",
	},
	copy: ".generated/deployment-manifest.schema.json",
	clean: true,
	dts: {
		resolve: [
			"@astro-yandex-cloud/function-runtime-bridge",
			"@astro-yandex-cloud/deployment-manifest",
			"@astro-yandex-cloud/targets",
		],
	},
	format: "esm",
	platform: "node",
	target: "node22",
	noExternal: [
		"@astro-yandex-cloud/package-info",
		"@astro-yandex-cloud/function-runtime-bridge",
		"@astro-yandex-cloud/deployment-manifest",
		"@astro-yandex-cloud/targets",
	],
	external: [
		/^astro(?:\/.*)?$/,
		"virtual:yandex-cloud-runtime-config",
	],
});
