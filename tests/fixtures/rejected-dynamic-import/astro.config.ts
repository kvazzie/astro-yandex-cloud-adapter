import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
  image: { service: passthroughImageService() },
  output: "server",
  vite: {
    plugins: [
      {
        name: "fixture-computed-runtime-import",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "computed-runtime-import.js",
            source: `const packageName = "missing-runtime-package";
import(packageName);
`,
          });
        },
      },
    ],
  },
});
