import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";
import { injectedRoute } from "../shared/injected-route.ts";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions" }),
  integrations: [injectedRoute],
  site: "https://fixture.example",
});
