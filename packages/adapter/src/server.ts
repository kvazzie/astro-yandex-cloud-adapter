import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import { site } from "virtual:yandex-cloud-runtime-config";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import { invoke } from "./runtime/bridge.js";
import type {
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
} from "./runtime.js";

setGetEnv((key) => process.env[key]);
const app = createApp({ streaming: false });

export async function handler(
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
  previewUrl?: URL,
): Promise<YandexCloudHttpResult> {
  const result = await Effect.runPromise(
    Effect.either(
      invoke(event, context, site, (request, clientAddress, locals) =>
        // Only local preview supplies a URL; cloud invocations keep HTTPS origins.
        app.render(previewUrl ? new Request(previewUrl, request) : request, {
          addCookieHeader: true,
          clientAddress,
          locals,
        }),
      ),
    ),
  );
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}
