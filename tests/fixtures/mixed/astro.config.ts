import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";
import { injectedRoute } from "../shared/injected-route.ts";

export default defineConfig({
  adapter: yandexCloud({ target: "object-storage-functions", apiGateway: true }),
  integrations: [injectedRoute],
  image: { service: passthroughImageService() },
  site: "https://fixture.example",
});
