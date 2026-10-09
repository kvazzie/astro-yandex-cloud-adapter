import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";
export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions", apiGateway: true, recursive404: true, functions: "separate" }),
  base: "/docs",
  image: { service: passthroughImageService() },
});
