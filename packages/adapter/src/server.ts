import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import {
  apiGateway,
  directOrigin,
  site,
} from "virtual:yandex-cloud-runtime-config";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import { invoke } from "./runtime/bridge.js";
import { staticNotFoundResponse } from "./runtime/not-found.js";
import type {
  FunctionArtifactPolicy,
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
} from "./runtime.js";

setGetEnv((key) => process.env[key]);
const app = createApp({ streaming: false });

/** Handles provider invocations and local preview through Astro's renderer. */
export async function handler(
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
  previewUrl?: URL,
  artifactPolicy: FunctionArtifactPolicy = {},
): Promise<YandexCloudHttpResult> {
  const result = await Effect.runPromise(
    Effect.either(
      invoke(
        event,
        context,
        site,
        async (request, clientAddress, locals) => {
          // Only local preview supplies a URL; cloud invocations keep HTTPS origins.
          const astroRequest = previewUrl
            ? new Request(previewUrl, request)
            : request;
          const routeData = app.match(astroRequest);
          const pathname = new URL(astroRequest.url).pathname;
          const explicit404 = artifactPolicy.notFound?.some(
            (scope) =>
              scope.url.replace(/\/$/, "") === pathname.replace(/\/$/, ""),
          );
          if (explicit404 || !routeData || routeData.route === "/404") {
            const fallback = await staticNotFoundResponse(
              astroRequest,
              artifactPolicy,
            );
            if (fallback) return fallback;
          }
          if (
            routeData &&
            artifactPolicy.allowedRoutes &&
            !artifactPolicy.allowedRoutes.includes(routeData.route)
          )
            return (
              (await staticNotFoundResponse(astroRequest, artifactPolicy)) ??
              new Response("Not Found", { status: 404 })
            );
          return app.render(astroRequest, {
            addCookieHeader: true,
            clientAddress,
            locals,
            routeData,
          });
        },
        // Preview already has the application's original path, query, and origin.
        { apiGateway: previewUrl ? true : apiGateway, directOrigin },
      ),
    ),
  );
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}
