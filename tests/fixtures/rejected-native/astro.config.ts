import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions", apiGateway: true }),
  image: { domains: ["images.example"] },
  output: "server",
});
