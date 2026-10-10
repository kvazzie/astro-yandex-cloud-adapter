import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions", apiGateway: true }),
  base: "/docs",
  trailingSlash: "ignore",
  image: { service: passthroughImageService() },
  integrations: [
    {
      name: "gateway-injected-route",
      hooks: {
        "astro:config:setup": ({ injectRoute }) => {
          injectRoute({
            pattern: "/injected/[name]",
            entrypoint: "./src/injected.ts",
            prerender: false,
          });
        },
      },
    },
  ],
});
