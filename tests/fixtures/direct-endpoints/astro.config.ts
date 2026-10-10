import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({
    target: "object-storage-functions",
    directOrigin: "https://static.example",
  }),
  base: "/docs",
  image: { service: passthroughImageService() },
  site: "https://static.example",
});
