import { access, readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { PreviewModule, PreviewServer, PreviewServerParams } from "astro";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type {
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
} from "./runtime.js";

type Handler = (
  event: YandexCloudHttpEvent,
  context: YandexCloudInvocationContext,
) => Promise<YandexCloudHttpResult>;

async function requestBody(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("base64");
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveClient(
  options: PreviewServerParams,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (incoming.method !== "GET" && incoming.method !== "HEAD") return false;
  const base = options.base.replace(/\/$/, "") || "/";
  if (base !== "/" && pathname !== base && !pathname.startsWith(`${base}/`))
    return false;
  const suffix = base === "/" ? pathname : pathname.slice(base.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(suffix);
  } catch {
    return false;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return false;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return false;
  const root = fileURLToPath(options.client);
  const route = decoded.replace(/^\/+/, "");
  const candidates =
    route === "" || route.endsWith("/")
      ? [`${route}index.html`]
      : [route, `${route}/index.html`, `${route}.html`];
  for (const candidate of candidates) {
    const file = resolve(root, candidate);
    const fromRoot = relative(root, file);
    if (
      fromRoot.startsWith(`..${sep}`) ||
      fromRoot === ".." ||
      isAbsolute(fromRoot)
    )
      continue;
    try {
      if (!(await stat(file)).isFile()) continue;
      const bytes = await readFile(file);
      outgoing.writeHead(200, {
        ...options.headers,
        "content-type": contentType(file),
      });
      outgoing.end(incoming.method === "HEAD" ? undefined : bytes);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

const preview: PreviewModule["default"] = async (
  options,
): Promise<PreviewServer> => {
  let handler: Handler | undefined;
  try {
    await access(options.serverEntrypoint);
    handler = (
      (await import(options.serverEntrypoint.href)) as { handler: Handler }
    ).handler;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const handleRequest = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => {
    try {
      const requestUrl = new URL(incoming.url ?? "/", "http://preview.local");
      if (await serveClient(options, incoming, outgoing, requestUrl.pathname))
        return;
      if (!handler) {
        outgoing.writeHead(404, options.headers).end("Not Found");
        return;
      }
      const body = await requestBody(incoming);
      const event: YandexCloudHttpEvent = {
        httpMethod: incoming.method,
        path: requestUrl.pathname,
        rawQueryString: requestUrl.search.slice(1),
        headers: Object.fromEntries(
          Object.entries(incoming.headers).flatMap(([name, value]) =>
            typeof value === "string" ? [[name, value]] : [],
          ),
        ),
        multiValueHeaders: Object.fromEntries(
          Object.entries(incoming.headers).flatMap(([name, value]) =>
            Array.isArray(value) ? [[name, value]] : [],
          ),
        ),
        body,
        isBase64Encoded: body !== undefined,
        requestContext: { identity: { sourceIp: incoming.socket.remoteAddress } },
      };
      const context: YandexCloudInvocationContext = {
        functionFolderId: "preview",
        functionName: "preview",
        functionVersion: "preview",
        memoryLimitInMB: "0",
        requestId: "preview",
        getPayload: () => event.body,
        getRemainingTimeInMillis: () => Number.POSITIVE_INFINITY,
      };
      const result = await handler(event, context);
      outgoing.writeHead(result.statusCode, {
        ...options.headers,
        ...result.headers,
        ...result.multiValueHeaders,
      });
      outgoing.end(
        result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body,
      );
    } catch (error) {
      options.logger.error(error instanceof Error ? error.message : String(error));
      outgoing.writeHead(500).end("Internal Server Error");
    }
  };
  const server = createServer((incoming, outgoing) => {
    void handleRequest(incoming, outgoing);
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  const scope = Effect.runSync(Scope.make());
  const listener = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port, options.host, resolve);
        }),
      catch: (error) => error,
    }),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );
  try {
    await Effect.runPromise(Effect.provideService(listener, Scope.Scope, scope));
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    throw error;
  }
  const address = server.address();
  return {
    host: options.host,
    port: typeof address === "object" && address ? address.port : options.port,
    closed: () => closed,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
};

export default preview;
