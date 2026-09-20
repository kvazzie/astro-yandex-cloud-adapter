import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

const injectedRoute = {
  name: "fixture-injected-route",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({
        pattern: "/injected/[name]",
        entrypoint: "./src/injected.ts",
        prerender: false,
      });
    },
  },
};

export default defineConfig({
  adapter: yandexCloud(),
  integrations: [injectedRoute],
});
