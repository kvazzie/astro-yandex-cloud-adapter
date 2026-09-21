import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "astro";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { YandexCloudHttpResult } from "../../packages/adapter/src/runtime.js";
import type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudManifestV1,
} from "../../packages/adapter/src/types.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");

interface GeneratedHandler {
  handler(
    event: YandexCloudHttpEvent,
    context: YandexCloudInvocationContext,
  ): Promise<YandexCloudHttpResult>;
}

let generatedHandler: GeneratedHandler;
let actionsGeneratedHandler: GeneratedHandler;

async function generatedFixtureHandler(
  fixture: string,
  cacheKey: string,
): Promise<GeneratedHandler> {
  return (await import(
    `${pathToFileURL(join(fixtures, fixture, "dist/function/index.js")).href}?${cacheKey}`
  )) as GeneratedHandler;
}

function invocationContext(
  overrides: Partial<YandexCloudInvocationContext> = {},
): YandexCloudInvocationContext {
  return {
    functionFolderId: "test-folder",
    functionName: "test-function",
    functionVersion: "test-version",
    memoryLimitInMB: "128",
    requestId: "test-request",
    getPayload: () => undefined,
    getRemainingTimeInMillis: () => 30_000,
    ...overrides,
  };
}

function directHttpEvent(
  overrides: Partial<YandexCloudHttpEvent> = {},
): YandexCloudHttpEvent {
  const httpMethod = overrides.httpMethod ?? "GET";
  return {
    httpMethod,
    path: "/",
    headers: { host: "fixture.example" },
    multiValueHeaders: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    requestContext: {
      identity: { sourceIp: "192.0.2.1", userAgent: "vitest" },
      httpMethod,
      requestId: "test-request",
      requestTime: "20/Sep/2026:12:00:00 +0000",
      requestTimeEpoch: 1_790_000_000,
    },
    body: "",
    isBase64Encoded: false,
    ...overrides,
  };
}

function apiGatewayV01Event(
  overrides: Partial<YandexCloudHttpEvent> = {},
): YandexCloudHttpEvent {
  return directHttpEvent({
    url: "/",
    path: "/",
    pathParams: {},
    params: {},
    multiValueParams: {},
    ...overrides,
  });
}

async function layout(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? (await layout(path)).map((child) => `${entry.name}/${child}`)
        : [entry.name];
    }),
  );
  return paths.flat().sort();
}

async function manifest(fixture: string): Promise<YandexCloudManifestV1> {
  return JSON.parse(
    await readFile(join(fixtures, fixture, "dist/yandex-cloud.json"), "utf8"),
  ) as YandexCloudManifestV1;
}

describe.sequential("Astro artifact builds", () => {
  beforeAll(async () => {
    for (const fixture of [
      "static",
      "static-functions",
      "mixed",
      "server",
      "server-island",
      "actions",
    ]) {
      await build({ root: `${join(fixtures, fixture)}/`, logLevel: "silent" });
    }

    const isolated = await mkdtemp(join(tmpdir(), "astro-yandex-function-"));
    await cp(join(fixtures, "mixed/dist/function"), isolated, { recursive: true });
    generatedHandler = (await import(
      `${pathToFileURL(join(isolated, "index.js")).href}?isolated=1`
    )) as GeneratedHandler;

    const isolatedActions = await mkdtemp(join(tmpdir(), "astro-yandex-actions-"));
    await cp(join(fixtures, "actions/dist/function"), isolatedActions, {
      recursive: true,
    });
    actionsGeneratedHandler = (await import(
      `${pathToFileURL(join(isolatedActions, "index.js")).href}?isolated=actions`
    )) as GeneratedHandler;
  });

  it("emits an Object Storage-only static layout and manifest", async () => {
    const files = (await layout(join(fixtures, "static/dist"))).map((file) => {
      if (!file.startsWith("client/_astro/logo.")) return file;
      return file.slice(file.lastIndexOf("/") + 1).includes("_")
        ? "client/_astro/logo.optimized.svg"
        : "client/_astro/logo.source.svg";
    });
    expect(files).toEqual([
      "client/_astro/logo.source.svg",
      "client/_astro/logo.optimized.svg",
      "client/about/index.html",
      "client/index.html",
      "client/robots.txt",
      "yandex-cloud.json",
    ]);
    expect(await manifest("static")).toMatchObject({
      schemaVersion: 1,
      target: "object-storage",
      buildOutput: "static",
      artifacts: { client: "client" },
      routes: { prerendered: ["/", "/about/"], onDemand: [] },
    });
  });

  it("emits a mixed client/function layout and deployment metadata", async () => {
    const files = await layout(join(fixtures, "mixed/dist"));
    expect(files).toContain("client/index.html");
    expect(files).toContain("client/public.txt");
    expect(files).toContain("function/index.js");
    expect(files).toContain("function/package.json");
    expect(files.some((file) => file.startsWith("function/chunks/"))).toBe(true);
    expect(await manifest("mixed")).toMatchObject({
      schemaVersion: 1,
      target: "object-storage-functions",
      buildOutput: "server",
      artifacts: { client: "client", function: "function" },
      function: {
        runtime: "nodejs22",
        format: "esm",
        entrypoint: "index.handler",
      },
    });
  });

  it("omits a Function Artifact for a Static-only Build on the Object Storage + Cloud Functions Target", async () => {
    const files = (await layout(join(fixtures, "static-functions/dist"))).map(
      (file) => {
        if (!file.startsWith("client/_astro/logo.")) return file;
        return file.slice(file.lastIndexOf("/") + 1).includes("_")
          ? "client/_astro/logo.optimized.svg"
          : "client/_astro/logo.source.svg";
      },
    );
    expect(files).not.toContain("function/index.js");
    expect(files).toEqual([
      "client/_astro/logo.source.svg",
      "client/_astro/logo.optimized.svg",
      "client/about/index.html",
      "client/index.html",
      "client/robots.txt",
      "yandex-cloud.json",
    ]);
    expect(await manifest("static-functions")).toMatchObject({
      target: "object-storage-functions",
      buildOutput: "static",
      artifacts: { client: "client" },
      routes: { prerendered: ["/", "/about/"], onDemand: [] },
    });
  });

  it("executes the generated handler outside the fixture dependency tree", async () => {
    const response = await generatedHandler.handler(
      directHttpEvent({
        httpMethod: "POST",
        path: "/api/echo",
        headers: {
          host: "fixture.example",
          origin: "https://fixture.example",
          "content-type": "text/plain",
        },
        multiValueQueryStringParameters: { value: ["one", "two"] },
        body: "payload",
        requestContext: { identity: { sourceIp: "192.0.2.42" } },
      }),
      invocationContext({ requestId: "integration-request" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      body: "payload",
      query: ["one", "two"],
      requestId: "integration-request",
    });

    const page = await generatedHandler.handler(
      directHttpEvent({
        path: "/runtime",
        requestContext: {
          identity: { sourceIp: "192.0.2.42" },
          requestId: "page-event",
        },
      }),
      invocationContext({ requestId: "page-request" }),
    );
    expect(page.body).toContain("page-request:page-event:192.0.2.42");
    expect(page.multiValueHeaders["set-cookie"]).toEqual(
      expect.arrayContaining([
        "runtime=true; Path=/; HttpOnly",
        "second=two; Path=/; SameSite=Strict",
      ]),
    );
    expect(page.headers["x-fixture-middleware"]).toBe("runtime");

    const binary = await generatedHandler.handler(
      directHttpEvent({
        path: "/api/binary",
      }),
      invocationContext(),
    );
    expect(binary).toMatchObject({
      statusCode: 200,
      body: "AAEC/w==",
      isBase64Encoded: true,
    });

    const error = await generatedHandler.handler(
      directHttpEvent({
        path: "/api/error",
      }),
      invocationContext(),
    );
    expect(error.statusCode).toBe(500);
  });

  it("executes a valid Action through API Gateway 0.1", async () => {
    const response = await actionsGeneratedHandler.handler(
      apiGatewayV01Event({
        httpMethod: "POST",
        url: "/_actions/greet",
        path: "/_actions/{path}",
        pathParams: { path: "greet" },
        headers: {
          host: "actions.example",
          "content-type": "application/json",
          cookie: "session=session-123",
        },
        body: JSON.stringify({ name: "Ada" }),
      }),
      invocationContext(),
    );

    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "content-type": "application/json+devalue",
        "x-actions-middleware": "active",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual([
      { message: 1, session: 2, middleware: 3 },
      "Hello, Ada",
      "session-123",
      "active",
    ]);
    expect(response.multiValueHeaders["set-cookie"]).toEqual(
      expect.arrayContaining([
        "action-first=one; Path=/; HttpOnly",
        "action-second=two; Path=/; SameSite=Lax",
      ]),
    );
  });

  it("discovers and executes an integration-injected route", async () => {
    const deployment = await manifest("mixed");
    expect(deployment.routes.onDemand).toEqual(
      expect.arrayContaining(["/injected/[name]"]),
    );

    const response = await generatedHandler.handler(
      directHttpEvent({ path: "/injected/Ada" }),
      invocationContext(),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      source: "integration",
      name: "Ada",
    });
  });

  it("emits and executes a Function Artifact for a server island", async () => {
    const deployment = await manifest("server-island");
    expect(deployment).toMatchObject({
      buildOutput: "server",
      artifacts: { client: "client", function: "function" },
      routes: { prerendered: ["/"] },
    });
    expect(deployment.routes.onDemand).toEqual(
      expect.arrayContaining(["/_server-islands/[name]"]),
    );

    const page = await readFile(
      join(fixtures, "server-island/dist/client/index.html"),
      "utf8",
    );
    const islandUrl = page
      .match(/<link rel="preload" as="fetch" href="([^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    expect(islandUrl).toBeDefined();

    const url = new URL(islandUrl!, "https://fixture.example");
    const handler = await generatedFixtureHandler("server-island", "island=1");
    const response = await handler.handler(
      directHttpEvent({
        path: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
      }),
      invocationContext(),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<p id="server-greeting">Hello, Ada.</p>');
  });

  it("uses direct HTTPS paths and Host origins", async () => {
    const response = await generatedHandler.handler(
      directHttpEvent({
        path: "/api/inspect/direct/path",
        headers: {
          Host: "direct.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        requestContext: {
          identity: { sourceIp: "192.0.2.10", userAgent: "vitest" },
          httpMethod: "GET",
          requestId: "direct-request",
          requestTime: "20/Sep/2026:12:00:00 +0000",
          requestTimeEpoch: 1_790_000_000,
        },
      }),
      invocationContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      origin: "https://direct.example",
      pathname: "/api/inspect/direct/path",
    });
  });

  it("uses the actual API Gateway 0.1 path instead of its route template", async () => {
    const response = await generatedHandler.handler(
      apiGatewayV01Event({
        url: "/api/inspect/gateway/path",
        path: "/api/inspect/{path}",
        headers: { Host: "gateway.example" },
        requestContext: {
          identity: { sourceIp: "192.0.2.11", userAgent: "vitest" },
          httpMethod: "GET",
          requestId: "gateway-request",
          requestTime: "20/Sep/2026:12:00:00 +0000",
          requestTimeEpoch: 1_790_000_000,
          apiGateway: { operationContext: {} },
        },
        pathParams: { path: "gateway/path" },
      }),
      invocationContext(),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      origin: "https://gateway.example",
      pathname: "/api/inspect/gateway/path",
    });
  });

  it.each(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])(
    "passes the %s request method through the generated handler",
    async (method) => {
      const response = await generatedHandler.handler(
        directHttpEvent({
          httpMethod: method,
          path: "/api/inspect/method",
          headers: {
            host: "methods.example",
            origin: "https://methods.example",
          },
          requestContext: {
            identity: { sourceIp: "192.0.2.12", userAgent: "vitest" },
            httpMethod: method,
            requestId: `method-${method}`,
            requestTime: "20/Sep/2026:12:00:00 +0000",
            requestTimeEpoch: 1_790_000_000,
          },
        }),
        invocationContext(),
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-inspected-method"]).toBe(method);
      if (method === "HEAD") expect(response.body).toBe("");
      else expect(JSON.parse(response.body)).toMatchObject({ method });
    },
  );

  it("passes repeated query values, headers, and a text body", async () => {
    const response = await generatedHandler.handler(
      directHttpEvent({
        httpMethod: "POST",
        path: "/api/inspect/text",
        headers: {
          host: "request.example",
          origin: "https://request.example",
          "content-type": "text/plain",
          "x-repeated": "last",
        },
        multiValueHeaders: { "x-repeated": ["first", "second"] },
        multiValueQueryStringParameters: { value: ["first", "second"] },
        requestContext: {
          identity: { sourceIp: "192.0.2.13", userAgent: "vitest" },
          httpMethod: "POST",
          requestId: "text-request",
          requestTime: "20/Sep/2026:12:00:00 +0000",
          requestTimeEpoch: 1_790_000_000,
        },
        body: "hello",
      }),
      invocationContext(),
    );

    expect(JSON.parse(response.body)).toMatchObject({
      bodyBase64: "aGVsbG8=",
      values: ["first", "second"],
      repeatedHeader: "first, second",
    });
  });

  it("decodes a binary request body", async () => {
    const response = await generatedHandler.handler(
      directHttpEvent({
        httpMethod: "POST",
        path: "/api/inspect/binary",
        headers: {
          host: "request.example",
          "content-type": "application/octet-stream",
        },
        requestContext: {
          identity: { sourceIp: "192.0.2.14", userAgent: "vitest" },
          httpMethod: "POST",
          requestId: "binary-request",
          requestTime: "20/Sep/2026:12:00:00 +0000",
          requestTimeEpoch: 1_790_000_000,
        },
        body: "AAEC/w==",
        isBase64Encoded: true,
      }),
      invocationContext(),
    );

    expect(JSON.parse(response.body)).toMatchObject({ bodyBase64: "AAEC/w==" });
  });

  it("uses the configured Astro site when Host is unavailable", async () => {
    const response = await generatedHandler.handler(
      directHttpEvent({
        path: "/api/inspect/site-fallback",
        headers: {},
        requestContext: {
          identity: { sourceIp: "192.0.2.15", userAgent: "vitest" },
          httpMethod: "GET",
          requestId: "site-request",
          requestTime: "20/Sep/2026:12:00:00 +0000",
          requestTimeEpoch: 1_790_000_000,
        },
      }),
      invocationContext(),
    );

    expect(JSON.parse(response.body)).toMatchObject({
      origin: "https://fixture.example",
    });
  });

  it.each([
    ["redirect", 307, "/runtime"],
    ["empty", 204, undefined],
  ] as const)(
    "returns %s responses in Yandex format",
    async (kind, statusCode, location) => {
      const response = await generatedHandler.handler(
        apiGatewayV01Event({
          url: `/api/response/${kind}`,
          path: "/api/response/{kind}",
          headers: { host: "response.example" },
        }),
        invocationContext(),
      );

      expect(response).toMatchObject({
        statusCode,
        body: "",
        isBase64Encoded: false,
      });
      expect(response.headers.location).toBe(location);
    },
  );

  it("supports all-server output", async () => {
    const deployment = await manifest("server");
    expect(deployment).toMatchObject({
      target: "object-storage-functions",
      buildOutput: "server",
    });
    expect(deployment.routes.onDemand).toEqual(
      expect.arrayContaining(["/", "/_image"]),
    );

    const entrypoint = await generatedFixtureHandler("server", "server=1");
    const response = await entrypoint.handler(
      directHttpEvent({ headers: { host: "server.example" } }),
      invocationContext(),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<h1>Server output</h1>");

    const sourceImage = new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red" /></svg>',
      { headers: { "content-type": "image/svg+xml" } },
    );
    Object.defineProperty(sourceImage, "url", {
      value: "https://images.example/source.svg",
    });
    const remoteImage = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sourceImage);
    let image: YandexCloudHttpResult;
    try {
      image = await entrypoint.handler(
        directHttpEvent({
          path: "/_image",
          queryStringParameters: {
            href: "https://images.example/source.svg",
            w: "16",
            f: "svg",
          },
        }),
        invocationContext(),
      );
    } finally {
      remoteImage.mockRestore();
    }
    expect(image).toMatchObject({
      statusCode: 200,
      isBase64Encoded: false,
      headers: { "content-type": "image/svg+xml" },
    });
    expect(image.body).toContain('<rect width="32" height="32" fill="red"');
  });

  it("rejects an Object Storage build containing an on-demand route", async () => {
    await expect(
      build({ root: `${join(fixtures, "rejected")}/`, logLevel: "silent" }),
    ).rejects.toThrow(
      /object-storage target cannot serve on-demand routes: \/.*Use target "object-storage-functions" or prerender these routes/,
    );
  });

  it("rejects an integration-injected route for Object Storage", async () => {
    await expect(
      build({
        root: `${join(fixtures, "rejected-injected")}/`,
        logLevel: "silent",
      }),
    ).rejects.toThrow(
      /object-storage target cannot serve on-demand routes: \/injected\/\[name\].*Use target "object-storage-functions" or prerender these routes/,
    );
  });

  it("rejects active Astro-internal routes for Object Storage", async () => {
    let failure: unknown;
    try {
      await build({
        root: `${join(fixtures, "rejected-server-island")}/`,
        logLevel: "silent",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(
      "object-storage target cannot serve on-demand routes",
    );
    expect(message).toContain("/_server-islands/[name]");
    expect(message).toContain("/_image");
    expect(message).toContain(
      'Use target "object-storage-functions" or prerender these routes.',
    );
  });
});
