import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import { site } from "virtual:yandex-cloud-runtime-config";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import {
  invoke,
  type YandexCloudHttpEvent,
  type YandexCloudHttpResult,
  type YandexCloudInvocationContext,
} from "./runtime.js";

setGetEnv((key) => process.env[key]);
const app = createApp({ streaming: false });

export async function handler(
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
): Promise<YandexCloudHttpResult> {
  const result = await Effect.runPromise(
    Effect.either(
      invoke(event, context, site, (request, clientAddress, locals) =>
        app.render(request, {
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
