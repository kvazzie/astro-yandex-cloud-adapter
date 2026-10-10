import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ apiGateway: true }),
  base: "/docs",
  trailingSlash: "always",
  build: { assetsPrefix: "https://assets.example" },
});
