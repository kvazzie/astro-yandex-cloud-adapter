import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({
    target: "object-storage-functions",
    apiGateway: true,
    functions: "separate",
    dependencyStrategy: "install",
  }),
  output: "server",
  base: "/docs",
  image: { domains: ["127.0.0.1"] },
});
