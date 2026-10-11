import { describe, expect, expectTypeOf, it } from "vitest";

import {
  fromWebResponse,
  getClientAddress,
  runtimeLocals,
  toWebRequest,
  type YandexCloudHttpEvent,
  type YandexCloudInvocationContext,
} from "../../packages/adapter/src/runtime/bridge.js";

type DocumentedInvocationContext = {
  functionFolderId: string;
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: string;
  requestId: string;
  token?: {
    access_token: string;
    expires_in: number;
    token_type: string;
  };
  getPayload(): unknown;
  getRemainingTimeInMillis(): number;
};

expectTypeOf<YandexCloudInvocationContext>().toEqualTypeOf<DocumentedInvocationContext>();

describe("toWebRequest", () => {
  it("restores the original endpoint path and query for direct invocation", () => {
    const request = toWebRequest(
      {
        path: "/function-id",
        headers: { host: "functions.yandexcloud.net" },
        queryStringParameters: {
          __astro_path:
            "/docs/api/items/Ada?tag=first&tag=second&__astro_path=user-value",
        },
      },
      undefined,
      { apiGateway: false },
    );

    expect(request.url).toBe(
      "https://functions.yandexcloud.net/docs/api/items/Ada?tag=first&tag=second&__astro_path=user-value",
    );
  });

  it.each([
    {},
    { __astro_path: "" },
    { __astro_path: "https://untrusted.example/api" },
    { __astro_path: "//untrusted.example/api" },
    { __astro_path: "/api#fragment" },
    { __astro_path: "/api\\escape" },
    { __astro_path: "/api/%ZZ" },
    { __astro_path: "/api/%C0%AF" },
    { __astro_path: "/api/%00" },
    { __astro_path: "/api/../admin" },
    { __astro_path: "/api/%2e%2e/admin" },
  ])("rejects a missing or malformed direct request target %j", (parameters) => {
    expect(() =>
      toWebRequest(
        {
          path: "/function-id",
          headers: { host: "functions.yandexcloud.net" },
          queryStringParameters: parameters,
        },
        undefined,
        { apiGateway: false },
      ),
    ).toThrow(/request target/);
  });

  it("rejects duplicate direct request targets", () => {
    expect(() =>
      toWebRequest(
        {
          path: "/function-id",
          headers: { host: "functions.yandexcloud.net" },
          rawQueryString: "__astro_path=%2Fapi%2Fone&__astro_path=%2Fapi%2Ftwo",
        },
        undefined,
        { apiGateway: false },
      ),
    ).toThrow(/request target/);
  });

  it("rejects malformed outer target encoding", () => {
    expect(() =>
      toWebRequest(
        {
          path: "/function-id",
          headers: { host: "functions.yandexcloud.net" },
          rawQueryString: "__astro_path=%2Fapi%ZZ",
        },
        undefined,
        { apiGateway: false },
      ),
    ).toThrow(/request target/);
  });

  it("validates a static form origin before restoring its public Request URL", async () => {
    const request = toWebRequest(
      {
        httpMethod: "POST",
        headers: {
          host: "functions.yandexcloud.net",
          origin: "https://site.example",
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-host": "untrusted.example",
        },
        queryStringParameters: { __astro_path: "/api/submit?source=static" },
        body: "name=Ada",
      },
      "https://site.example",
      { apiGateway: false, directOrigin: "https://site.example" },
    );
    expect(request.url).toBe("https://site.example/api/submit?source=static");
    expect(request.headers.get("origin")).toBe("https://site.example");
    expect(await request.text()).toBe("name=Ada");
  });

  it("rejects conflicting repeated Origin headers before constructing a direct Request", () => {
    expect(() =>
      toWebRequest(
        {
          httpMethod: "POST",
          headers: { host: "functions.yandexcloud.net" },
          multiValueHeaders: {
            origin: ["https://site.example", "https://untrusted.example"],
            "content-type": ["application/x-www-form-urlencoded"],
          },
          queryStringParameters: { __astro_path: "/api/submit" },
          body: "name=Ada",
        },
        undefined,
        { apiGateway: false, directOrigin: "https://site.example" },
      ),
    ).toThrow(/Origin/);
  });

  it("does not infer permission for direct forms from Astro site", () => {
    expect(() =>
      toWebRequest(
        {
          httpMethod: "POST",
          headers: {
            host: "functions.yandexcloud.net",
            origin: "https://site.example",
            "content-type": "application/x-www-form-urlencoded",
          },
          queryStringParameters: { __astro_path: "/api/submit" },
          body: "name=Ada",
        },
        "https://site.example",
        { apiGateway: false },
      ),
    ).toThrow(/configured directOrigin/);
  });

  it("preserves Gateway paths and application query parameters", () => {
    const request = toWebRequest(
      {
        url: "/docs/api/items/Ada",
        path: "/docs/api/items/{slug}",
        headers: {
          host: "gateway.example",
          origin: "https://application.example",
        },
        queryStringParameters: { __astro_path: "application-value" },
      },
      undefined,
      { apiGateway: true },
    );
    expect(request.url).toBe(
      "https://gateway.example/docs/api/items/Ada?__astro_path=application-value",
    );
    expect(request.headers.get("origin")).toBe("https://application.example");
  });

  it("preserves repeated query values and request headers", async () => {
    const request = toWebRequest({
      httpMethod: "POST",
      path: "/api/search",
      headers: {
        Host: "function.example",
        "content-type": "text/plain",
        ignored: "single",
      },
      multiValueHeaders: { ignored: ["first", "second"] },
      queryStringParameters: { q: "astro", ignored: "single" },
      multiValueQueryStringParameters: {
        tag: ["cloud", "astro"],
        ignored: ["first", "second"],
      },
      body: Buffer.from("hello").toString("base64"),
      isBase64Encoded: true,
    });

    expect(request.url).toBe(
      "https://function.example/api/search?tag=cloud&tag=astro&ignored=first&ignored=second&q=astro",
    );
    expect(request.headers.get("ignored")).toBe("first, second");
    expect(await request.text()).toBe("hello");
  });

  it("ignores forwarded origin data", () => {
    const request = toWebRequest({
      path: "/proxy",
      headers: {
        host: "internal.example",
        "x-forwarded-host": "public.example, internal.example",
        "x-forwarded-proto": "http, https",
      },
    });
    expect(request.url).toBe("https://internal.example/proxy");
  });

  it("uses Astro site when no host is provided", () => {
    expect(
      toWebRequest({ path: "base/page" }, "https://site.example/root").url,
    ).toBe("https://site.example/base/page");
  });

  it("prefers the trusted request context source address", () => {
    const event: YandexCloudHttpEvent = {
      headers: { "x-forwarded-for": "203.0.113.1" },
      requestContext: {
        identity: { sourceIp: "192.0.2.8" },
        http: { sourceIp: "192.0.2.9" },
      },
    };
    const context: YandexCloudInvocationContext = {
      functionFolderId: "folder-1",
      functionName: "function-1",
      functionVersion: "version-1",
      memoryLimitInMB: "128",
      requestId: "request-1",
      token: {
        access_token: "token",
        expires_in: 3600,
        token_type: "Bearer",
      },
      getPayload: () => ({ hello: "world" }),
      getRemainingTimeInMillis: () => 5000,
    };
    expect(getClientAddress(event)).toBe("192.0.2.8");
    expect(runtimeLocals(event, context)).toEqual({
      runtime: { event, context },
    });
  });

  it("rejects an event without enough origin information", () => {
    expect(() => toWebRequest({ path: "/" })).toThrow(/no Host header/);
  });

  it("rejects an empty HTTP method", () => {
    expect(() =>
      toWebRequest({ httpMethod: "", headers: { host: "function.example" } }),
    ).toThrow(/empty HTTP method/);
  });
});

describe("fromWebResponse", () => {
  it("returns text, status, redirects, and repeated cookies", async () => {
    const headers = new Headers({
      location: "/next",
      "content-type": "text/plain; charset=utf-8",
    });
    headers.append("set-cookie", "first=1; Path=/");
    headers.append("set-cookie", "second=2; Path=/; HttpOnly");
    const result = await fromWebResponse(
      new Response("moved", { status: 302, headers }),
    );

    expect(result).toMatchObject({
      statusCode: 302,
      headers: { location: "/next", "content-type": "text/plain; charset=utf-8" },
      body: "moved",
      isBase64Encoded: false,
    });
    expect(result.multiValueHeaders["set-cookie"]).toEqual([
      "first=1; Path=/",
      "second=2; Path=/; HttpOnly",
    ]);
  });

  it("encodes binary responses as base64", async () => {
    const result = await fromWebResponse(
      new Response(Uint8Array.from([0, 1, 2, 255]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(result.body).toBe("AAEC/w==");
    expect(result.isBase64Encoded).toBe(true);
  });

  it("handles empty responses without base64 encoding", async () => {
    const result = await fromWebResponse(new Response(null, { status: 204 }));
    expect(result).toMatchObject({
      statusCode: 204,
      body: "",
      isBase64Encoded: false,
    });
  });
});
