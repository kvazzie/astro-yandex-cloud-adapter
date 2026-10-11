import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({
    target: "object-storage-functions",
    apiGateway: true,
    dependencyStrategy: "install",
  }),
  image: { service: passthroughImageService() },
  output: "server",
  site: "https://install-basic.example",
});
