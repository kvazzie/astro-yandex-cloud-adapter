import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions", apiGateway: true }),
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
            source: `const example = 'require("false-positive-package")';
const extension = "addon.node";
// require("comment-package")
import "missing-runtime-package";
void example;
void extension;
`,
          });
        },
      },
    ],
  },
});
