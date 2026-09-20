import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";
import { injectedRoute } from "../shared/injected-route.ts";

export default defineConfig({
  adapter: yandexCloud(),
  integrations: [injectedRoute],
});
