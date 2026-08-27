import { describe, expect, it } from "vitest";

import {
  fromWebResponse,
  getClientAddress,
  runtimeLocals,
  toWebRequest,
  type YandexCloudHttpEvent,
} from "../../packages/adapter/src/runtime.js";

describe("toWebRequest", () => {
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

  it("uses forwarded origin data ahead of Host", () => {
    const request = toWebRequest({
      path: "/proxy",
      headers: {
        host: "internal.example",
        "x-forwarded-host": "public.example, internal.example",
        "x-forwarded-proto": "http, https",
      },
    });
    expect(request.url).toBe("http://public.example/proxy");
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
    expect(getClientAddress(event)).toBe("192.0.2.8");
    expect(runtimeLocals(event, { requestId: "request-1" })).toEqual({
      runtime: { event, context: { requestId: "request-1" } },
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
