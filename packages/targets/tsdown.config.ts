import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { index: "src/index.ts" },
	clean: true,
	dts: true,
	format: "esm",
	platform: "node",
	target: "node22",
});
