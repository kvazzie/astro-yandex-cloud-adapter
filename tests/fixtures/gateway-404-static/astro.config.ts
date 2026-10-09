import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ apiGateway: true, recursive404: true }),
  base: "/docs",
  trailingSlash: "never",
});
