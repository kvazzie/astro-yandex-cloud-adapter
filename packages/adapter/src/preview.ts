import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { PreviewModule, PreviewServer } from "astro";

import type {
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
} from "./runtime.js";

async function requestBody(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("base64");
}

const preview: PreviewModule["default"] = async (
  options,
): Promise<PreviewServer> => {
  const entrypoint = (await import(options.serverEntrypoint.href)) as {
    handler: (
      event: YandexCloudHttpEvent,
      context: YandexCloudInvocationContext,
    ) => Promise<YandexCloudHttpResult>;
  };
  const handleRequest = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => {
    try {
      const requestUrl = new URL(incoming.url ?? "/", "http://preview.local");
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
      const result = await entrypoint.handler(event, context);
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  return {
    host: options.host,
    port: options.port,
    closed: () => closed,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

export default preview;
