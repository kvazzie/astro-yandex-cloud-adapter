import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
  image: { service: passthroughImageService() },
  output: "server",
  vite: {
    plugins: [
      {
        name: "fixture-dynamic-runtime-import",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "dynamic-runtime.js",
            source: `const packageName = "missing-runtime-package";
require(packageName);
`,
          });
        },
      },
    ],
  },
});
