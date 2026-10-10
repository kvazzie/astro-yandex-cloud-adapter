import type {
  FunctionInvocationOptions,
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./types.js";
import * as Effect from "effect/Effect";

import { DIRECT_REQUEST_TARGET_PARAMETER } from "./constants.js";

export type {
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./types.js";

/** A malformed direct invocation that must not reach application code. */
export class FunctionRequestError extends Error {
  constructor(
    readonly status: 400 | 403,
    message: string,
  ) {
    super(message);
    this.name = "FunctionRequestError";
  }
}

function firstHeader(
  event: YandexCloudHttpEvent,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (key.toLowerCase() === wanted && values?.length) return values[0];
  }
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

function appendHeaders(target: Headers, event: YandexCloudHttpEvent): void {
  const multiNames = new Set<string>();
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    multiNames.add(name.toLowerCase());
    for (const value of values ?? []) target.append(name, value);
  }
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined && !multiNames.has(name.toLowerCase()))
      target.append(name, value);
  }
}

function eventPath(event: YandexCloudHttpEvent): string {
  const path =
    event.url ??
    event.rawPath ??
    event.path ??
    event.requestContext?.http?.path ??
    "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function eventQuery(event: YandexCloudHttpEvent): string {
  if (event.rawQueryString !== undefined) return event.rawQueryString;
  const query = new URLSearchParams();
  const multiNames = new Set<string>();
  for (const [name, values] of Object.entries(
    event.multiValueQueryStringParameters ?? {},
  )) {
    multiNames.add(name);
    for (const value of values ?? []) query.append(name, value);
  }
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined && !multiNames.has(name)) query.append(name, value);
  }
  return query.toString();
}

/** Validates the provider wrapper separately from the application's query. */
function directRequestTarget(query: string): string {
  const invalid = () =>
    new FunctionRequestError(400, "Invalid or missing direct request target.");
  const targets = new URLSearchParams(query).getAll(
    DIRECT_REQUEST_TARGET_PARAMETER,
  );
  if (targets.length !== 1) throw invalid();
  const target = targets[0]!;
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[\\#\s]/u.test(target)
  )
    throw invalid();
  const path = target.split("?", 1)[0]!;
  let decodedPath: string;
  try {
    const decoded = decodeURIComponent(target);
    if (!decoded.startsWith("/") || decoded.startsWith("//")) throw invalid();
    decodedPath = decodeURIComponent(path);
    // URLSearchParams repairs malformed outer encoding; reject it instead.
    for (const entry of query.split("&")) {
      const equals = entry.indexOf("=");
      const rawName = equals < 0 ? entry : entry.slice(0, equals);
      if (
        decodeURIComponent(rawName.replaceAll("+", " ")) ===
        DIRECT_REQUEST_TARGET_PARAMETER
      )
        if (
          decodeURIComponent(entry.slice(equals + 1).replaceAll("+", " ")) !==
          target
        )
          throw invalid();
    }
  } catch {
    throw invalid();
  }
  if (/[\\\p{Cc}]/u.test(decodedPath)) throw invalid();
  if (
    path.split("/").some((segment) => {
      const value = decodeURIComponent(segment);
      return value === "." || value === "..";
    })
  )
    throw invalid();
  return target;
}

function originForEvent(
  event: YandexCloudHttpEvent,
  configuredSite?: string,
): string {
  const host = firstHeader(event, "host");

  if (host) return `https://${host}`;
  if (configuredSite) return new URL(configuredSite).origin;
  throw new TypeError(
    "The Yandex HTTPS event has no Host header and Astro `site` is not set.",
  );
}

/** Uses only a configured origin after verifying incoming browser origin data. */
function directRequestOrigin(
  event: YandexCloudHttpEvent,
  headers: Headers,
  method: string,
  configuredSite: string | undefined,
  directOrigin: string | undefined,
): string {
  const origin = headers.get("origin");
  const contentType = headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const formSubmission =
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    (contentType === "application/x-www-form-urlencoded" ||
      contentType === "multipart/form-data" ||
      contentType === "text/plain");
  if (formSubmission && (!directOrigin || !origin))
    throw new FunctionRequestError(
      403,
      "Direct form submissions require a configured directOrigin and matching Origin header.",
    );
  if (origin && (!directOrigin || origin !== directOrigin))
    throw new FunctionRequestError(403, "Untrusted direct request Origin.");
  return directOrigin ?? originForEvent(event, configuredSite);
}

export function getClientAddress(event: YandexCloudHttpEvent): string | undefined {
  return (
    event.requestContext?.identity?.sourceIp ??
    event.requestContext?.http?.sourceIp
  );
}

export function toWebRequest(
  event: YandexCloudHttpEvent,
  configuredSite?: string,
  options?: FunctionInvocationOptions,
): Request {
  if (!event || typeof event !== "object")
    throw new TypeError("Expected a Yandex HTTPS event.");

  const method = (
    event.httpMethod ??
    event.method ??
    event.requestContext?.http?.method ??
    "GET"
  )
    .toUpperCase()
    .trim();
  if (!method)
    throw new TypeError("The Yandex HTTPS event contains an empty HTTP method.");

  const query = eventQuery(event);
  const headers = new Headers();
  appendHeaders(headers, event);
  const target =
    options && !options.apiGateway
      ? directRequestTarget(query)
      : `${eventPath(event)}${query ? `?${query}` : ""}`;
  const origin =
    options && !options.apiGateway
      ? directRequestOrigin(
          event,
          headers,
          method,
          configuredSite,
          options.directOrigin,
        )
      : originForEvent(event, configuredSite);
  const url = `${origin}${target}`;

  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD" && event.body != null) {
    if (event.isBase64Encoded) {
      const decoded = Buffer.from(event.body, "base64");
      body = decoded.buffer.slice(
        decoded.byteOffset,
        decoded.byteOffset + decoded.byteLength,
      );
    } else {
      body = event.body;
    }
  }

  return new Request(url, { method, headers, body });
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/json+devalue" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "image/svg+xml"
  );
}

function responseCookies(headers: Headers): string[] {
  const extendedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extendedHeaders.getSetCookie === "function")
    return extendedHeaders.getSetCookie();
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

export async function fromWebResponse(
  response: Response,
): Promise<YandexCloudHttpResult> {
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }

  const cookies = responseCookies(response.headers);
  if (cookies.length) multiValueHeaders["set-cookie"] = cookies;

  const bytes = new Uint8Array(await response.arrayBuffer());
  const empty =
    response.status === 204 || response.status === 304 || bytes.byteLength === 0;
  const textual = isTextual(response.headers.get("content-type"));

  return {
    statusCode: response.status,
    headers,
    multiValueHeaders,
    body: empty
      ? ""
      : textual
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("base64"),
    isBase64Encoded: !empty && !textual,
  };
}

export function runtimeLocals(
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
): { runtime: YandexCloudRuntime } {
  return { runtime: { event, context } };
}

/** Translates one Function invocation around a framework-owned renderer. */
export function invoke(
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
  configuredSite: string | undefined,
  render: (
    request: Request,
    clientAddress: string | undefined,
    locals: { runtime: YandexCloudRuntime },
  ) => Promise<Response>,
  options?: FunctionInvocationOptions,
): Effect.Effect<YandexCloudHttpResult, unknown> {
  return Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => toWebRequest(event, configuredSite, options),
      catch: (error) => error,
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        render(request, getClientAddress(event), runtimeLocals(event, context)),
      catch: (error) => error,
    });
    return yield* Effect.tryPromise({
      try: () => fromWebResponse(response),
      catch: (error) => error,
    });
  }).pipe(
    Effect.catchAll((error) =>
      error instanceof FunctionRequestError
        ? Effect.tryPromise(() =>
            fromWebResponse(
              new Response(error.message, {
                status: error.status,
                headers: { "content-type": "text/plain; charset=utf-8" },
              }),
            ),
          )
        : Effect.fail(error),
    ),
  );
}
