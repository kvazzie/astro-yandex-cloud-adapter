import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import { site } from "virtual:yandex-cloud-runtime-config";

import {
  fromWebResponse,
  getClientAddress,
  runtimeLocals,
  toWebRequest,
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
  const request = toWebRequest(event, site);
  const response = await app.render(request, {
    addCookieHeader: true,
    clientAddress: getClientAddress(event),
    locals: runtimeLocals(event, context),
  });
  return fromWebResponse(response);
}
