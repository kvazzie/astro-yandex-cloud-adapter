import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		schema: "src/DeploymentManifest/Schema.ts",
		"v1/target-encoding": "src/.TargetSchema.ts",
	},
	copy: ".generated/deployment-manifest.schema.json",
	clean: true,
	dts: true,
	format: "esm",
	platform: "node",
	target: "node22",
});
