import type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./types.js";

export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./types.js";

export interface YandexCloudHttpResult {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
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
    event.url ?? event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
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

export function getClientAddress(event: YandexCloudHttpEvent): string | undefined {
  return (
    event.requestContext?.identity?.sourceIp ??
    event.requestContext?.http?.sourceIp
  );
}

export function toWebRequest(
  event: YandexCloudHttpEvent,
  configuredSite?: string,
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
  const url = `${originForEvent(event, configuredSite)}${eventPath(event)}${query ? `?${query}` : ""}`;
  const headers = new Headers();
  appendHeaders(headers, event);

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
