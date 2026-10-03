import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: yandexCloud({
    target: "object-storage-functions",
    dependencyStrategy: "install",
  }),
  output: "server",
  site: "https://install-sharp.example",
});
