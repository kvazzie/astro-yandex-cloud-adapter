import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
  image: { service: passthroughImageService() },
  output: "server",
  vite: {
    plugins: [
      {
        name: "fixture-unresolved-runtime-import",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "unresolved-runtime.js",
            source: 'import "missing-runtime-package";\n',
          });
        },
      },
    ],
  },
});
