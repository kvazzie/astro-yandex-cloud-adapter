import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({
    target: "object-storage-functions",
    apiGateway: true,
    functions: "separate",
  }),
  output: "server",
  base: "/docs",
  image: { service: passthroughImageService() },
});
