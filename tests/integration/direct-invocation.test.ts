import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "astro";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  YandexCloudHttpEvent,
  YandexCloudHttpResult,
  YandexCloudInvocationContext,
} from "../../packages/adapter/src/runtime.js";

interface GeneratedHandler {
  handler(
    event: YandexCloudHttpEvent,
    context: YandexCloudInvocationContext,
  ): Promise<YandexCloudHttpResult>;
}

const fixture = resolve(import.meta.dirname, "../fixtures/direct-endpoints");
const context: YandexCloudInvocationContext = {
  functionFolderId: "direct-folder",
  functionName: "direct-function",
  functionVersion: "direct-version",
  memoryLimitInMB: "128",
  requestId: "direct-request",
  getPayload: () => undefined,
  getRemainingTimeInMillis: () => 30_000,
};

/** Models the provider wrapper, independently of the application's URL. */
function directEvent(
  target: string | undefined,
  overrides: Partial<YandexCloudHttpEvent> = {},
): YandexCloudHttpEvent {
  return {
    httpMethod: "GET",
    path: "/function-id",
    headers: { host: "functions.yandexcloud.net" },
    queryStringParameters: target === undefined ? {} : { __astro_path: target },
    ...overrides,
  };
}

describe.sequential("Direct stateless Function invocation", () => {
  let root: string;
  let generated: GeneratedHandler;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "astro-yandex-direct-"));
    await cp(fixture, root, {
      recursive: true,
      filter: (source) => !/\/(?:node_modules|dist|\.astro)(?:\/|$)/.test(source),
    });
    await symlink(
      resolve(import.meta.dirname, "../fixtures/static/node_modules"),
      join(root, "node_modules"),
    );
    await build({ root: `${root}/`, logLevel: "silent" });
    generated = (await import(
      pathToFileURL(join(root, "dist/function/index.js")).href
    )) as GeneratedHandler;
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("accepts a static form with body and restored URL while Astro origin checking stays enabled", async () => {
    const page = await readFile(join(root, "dist/client/index.html"), "utf8");
    expect(page).toContain("https://functions.yandexcloud.net/function-id?");
    const response = await generated.handler(
      directEvent("/docs/api/submit?source=static&__astro_path=user-value", {
        httpMethod: "POST",
        headers: {
          host: "functions.yandexcloud.net",
          origin: "https://static.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "name=Ada",
      }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      name: "Ada",
      method: "POST",
      pathname: "/docs/api/submit",
      origin: "https://static.example",
      source: "static",
      applicationParameter: "user-value",
      checkedOrigin: "https://static.example",
    });
  });

  it("routes dynamic endpoint paths and repeated query values without consuming an application parameter", async () => {
    const response = await generated.handler(
      directEvent(
        "/docs/api/items/Ada?value=first&value=second&__astro_path=application",
        {
          queryStringParameters: undefined,
          rawQueryString:
            "__astro_path=%2Fdocs%2Fapi%2Fitems%2FAda%3Fvalue%3Dfirst%26value%3Dsecond%26__astro_path%3Dapplication",
        },
      ),
      context,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      slug: "Ada",
      pathname: "/docs/api/items/Ada",
      values: ["first", "second"],
      applicationParameter: "application",
    });
  });

  it("routes a rest endpoint through the provider wrapper", async () => {
    const response = await generated.handler(
      directEvent("/docs/api/rest/one/two"),
      context,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      path: "one/two",
      pathname: "/docs/api/rest/one/two",
    });
  });

  it.each([undefined, "https://untrusted.example", "null"])(
    "rejects a static form with an untrusted or missing Origin %s",
    async (origin) => {
      const response = await generated.handler(
        directEvent("/docs/api/submit", {
          httpMethod: "POST",
          headers: {
            host: "functions.yandexcloud.net",
            origin,
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-host": "static.example",
          },
          body: "name=Ada",
        }),
        context,
      );
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("Origin");
    },
  );

  it.each([
    undefined,
    "//untrusted.example/docs/api/items/Ada",
    "/docs/api/%ZZ",
    "/docs/api/%C0%AF",
    "/docs/api/items/Ada#fragment",
  ])("fails a missing or malformed request target safely %s", async (target) => {
    const response = await generated.handler(directEvent(target), context);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("request target");
  });

  it("fails duplicated provider request targets safely", async () => {
    const response = await generated.handler(
      directEvent(undefined, {
        multiValueQueryStringParameters: {
          __astro_path: ["/docs/api/items/Ada", "/docs/api/rest/one"],
        },
      }),
      context,
    );
    expect(response.statusCode).toBe(400);
  });

  it("does not add CORS permission to cross-origin JavaScript requests", async () => {
    const accepted = await generated.handler(
      directEvent("/docs/api/items/Ada", {
        headers: {
          host: "functions.yandexcloud.net",
          origin: "https://static.example",
        },
      }),
      context,
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers).not.toHaveProperty("access-control-allow-origin");

    const rejected = await generated.handler(
      directEvent("/docs/api/items/Ada", {
        headers: {
          host: "functions.yandexcloud.net",
          origin: "https://untrusted.example",
        },
      }),
      context,
    );
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers).not.toHaveProperty("access-control-allow-origin");
  });
});
