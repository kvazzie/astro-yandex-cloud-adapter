import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "deployment-manifest": "src/deployment-manifest.ts",
    index: "src/index.ts",
    preview: "src/preview.ts",
    runtime: "src/runtime.ts",
    server: "src/server.ts",
  },
  copy: "src/deployment-manifest.schema.json",
  clean: true,
  dts: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [/^astro(?:\/.*)?$/, "sharp", "virtual:yandex-cloud-runtime-config"],
});
