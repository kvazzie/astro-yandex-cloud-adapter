import { gunzipSync, gzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
	fromWebResponse,
	getClientAddress,
	invoke,
	Errors,
	toWebRequest,
	type YandexCloudHttpEvent,
	type YandexCloudInvocationContext,
} from "@astro-yandex-cloud/function-runtime-bridge";

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

const invocationContext: YandexCloudInvocationContext = {
	functionFolderId: "folder-1",
	functionName: "function-1",
	functionVersion: "version-1",
	memoryLimitInMB: "128",
	requestId: "request-1",
	getPayload: () => undefined,
	getRemainingTimeInMillis: () => 5000,
};

describe("toWebRequest", () => {
	it("uses the caller's direct request target parameter", () => {
		const request = toWebRequest(
			{
				headers: { host: "function.example" },
				queryStringParameters: {
					original_target: "/api/items?tag=first&tag=second",
				},
			},
			undefined,
			{
				apiGateway: false,
				requestTargetParameter: "original_target",
			},
		);
		expect(request.url).toBe(
			"https://function.example/api/items?tag=first&tag=second",
		);
		expect(() =>
			toWebRequest(
				{ headers: { host: "function.example" } },
				undefined,
				{
					apiGateway: false,
					requestTargetParameter: "original_target",
				},
			),
		).toThrow(Errors.FunctionRequestError);
	});

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
			{
				apiGateway: false,
				requestTargetParameter: "__astro_path",
			},
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
	])(
		"rejects a missing or malformed direct request target %j",
		(parameters) => {
			expect(() =>
				toWebRequest(
					{
						path: "/function-id",
						headers: { host: "functions.yandexcloud.net" },
						queryStringParameters: parameters,
					},
					undefined,
					{
						apiGateway: false,
						requestTargetParameter: "__astro_path",
					},
				),
			).toThrow(/request target/);
		},
	);

	it("rejects duplicate direct request targets", () => {
		expect(() =>
			toWebRequest(
				{
					path: "/function-id",
					headers: { host: "functions.yandexcloud.net" },
					rawQueryString:
						"__astro_path=%2Fapi%2Fone&__astro_path=%2Fapi%2Ftwo",
				},
				undefined,
				{
					apiGateway: false,
					requestTargetParameter: "__astro_path",
				},
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
				{
					apiGateway: false,
					requestTargetParameter: "__astro_path",
				},
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
				queryStringParameters: {
					__astro_path: "/api/submit?source=static",
				},
				body: "name=Ada",
			},
			"https://site.example",
			{
				apiGateway: false,
				requestTargetParameter: "__astro_path",
				directOrigin: "https://site.example",
			},
		);
		expect(request.url).toBe(
			"https://site.example/api/submit?source=static",
		);
		expect(request.headers.get("origin")).toBe(
			"https://site.example",
		);
		expect(await request.text()).toBe("name=Ada");
	});

	it("rejects conflicting repeated Origin headers before constructing a direct Request", () => {
		expect(() =>
			toWebRequest(
				{
					httpMethod: "POST",
					headers: { host: "functions.yandexcloud.net" },
					multiValueHeaders: {
						origin: [
							"https://site.example",
							"https://untrusted.example",
						],
						"content-type": [
							"application/x-www-form-urlencoded",
						],
					},
					queryStringParameters: { __astro_path: "/api/submit" },
					body: "name=Ada",
				},
				undefined,
				{
					apiGateway: false,
					requestTargetParameter: "__astro_path",
					directOrigin: "https://site.example",
				},
			),
		).toThrow(/Origin/);
	});

	it("does not infer permission for direct forms from the fallback origin", () => {
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
				{
					apiGateway: false,
					requestTargetParameter: "__astro_path",
				},
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
				queryStringParameters: {
					__astro_path: "application-value",
				},
			},
			undefined,
			{ apiGateway: true },
		);
		expect(request.url).toBe(
			"https://gateway.example/docs/api/items/Ada?__astro_path=application-value",
		);
		expect(request.headers.get("origin")).toBe(
			"https://application.example",
		);
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

	it("uses the fallback origin when no host is provided", () => {
		expect(
			toWebRequest(
				{ path: "base/page" },
				"https://site.example/root",
			).url,
		).toBe("https://site.example/base/page");
	});

	it("passes the trusted client address and provider context to the renderer", async () => {
		const event: YandexCloudHttpEvent = {
			headers: {
				host: "function.example",
				"x-forwarded-for": "203.0.113.1",
			},
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
		const result = await Effect.runPromise(
			invoke(
				event,
				context,
				undefined,
				(request, clientAddress, runtime) => {
					expect(request.url).toBe("https://function.example/");
					expect(clientAddress).toBe("192.0.2.8");
					expect(runtime.event).toBe(event);
					expect(runtime.context).toBe(context);
					return Promise.resolve(
						new Response("rendered", {
							headers: { "content-type": "text/plain" },
						}),
					);
				},
			),
		);
		expect(result.body).toBe("rendered");
	});

	it("rejects an event without enough origin information", () => {
		expect(() => toWebRequest({ path: "/" })).toThrow(
			/no Host header/,
		);
	});

	it("rejects an empty HTTP method", () => {
		expect(() =>
			toWebRequest({
				httpMethod: "",
				headers: { host: "function.example" },
			}),
		).toThrow(/empty HTTP method/);
	});
});

describe("fromWebResponse", () => {
	it("preserves gzip-compressed text bytes and their headers", async () => {
		const bytes = gzipSync("compressed café");
		const headers = {
			"content-type": "text/plain; charset=utf-8",
			"content-encoding": "gzip",
			"content-length": String(bytes.byteLength),
		};
		const result = await fromWebResponse(
			new Response(bytes, { headers }),
		);

		expect(result.isBase64Encoded).toBe(true);
		expect(result.headers).toEqual(headers);
		const restored = Buffer.from(result.body, "base64");
		expect(restored).toEqual(bytes);
		expect(gunzipSync(restored).toString("utf8")).toBe(
			"compressed café",
		);
	});

	it.each([
		"text/plain; charset=iso-8859-1",
		"text/plain; charset=utf-8",
		"text/plain",
		"application/json",
	])("preserves non-UTF-8 bytes for %s", async (contentType) => {
		const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
		const headers = {
			"content-type": contentType,
		};
		const result = await fromWebResponse(
			new Response(bytes, { headers }),
		);

		expect(result.isBase64Encoded).toBe(true);
		expect(result.headers).toEqual(headers);
		expect(Buffer.from(result.body, "base64")).toEqual(
			Buffer.from(bytes),
		);
	});

	it("uses base64 when Content-Encoding is present even for valid UTF-8 bytes", async () => {
		const result = await fromWebResponse(
			new Response("hello", {
				headers: {
					"content-type": "text/plain",
					"content-encoding": "identity",
				},
			}),
		);

		expect(result.isBase64Encoded).toBe(true);
		expect(
			Buffer.from(result.body, "base64").toString("utf8"),
		).toBe("hello");
		expect(result.headers["content-encoding"]).toBe("identity");
	});

	it("preserves a UTF-8 byte order mark in an ordinary text result", async () => {
		const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]);
		const result = await fromWebResponse(
			new Response(bytes, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			}),
		);

		expect(result.isBase64Encoded).toBe(false);
		expect(result.body).toBe("\uFEFFa");
		expect(Buffer.from(result.body, "utf8")).toEqual(
			Buffer.from(bytes),
		);
	});

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
			headers: {
				location: "/next",
				"content-type": "text/plain; charset=utf-8",
			},
			body: "moved",
			isBase64Encoded: false,
		});
		expect(result.multiValueHeaders["set-cookie"]).toEqual([
			"first=1; Path=/",
			"second=2; Path=/; HttpOnly",
		]);
		expect(result.headers).not.toHaveProperty("set-cookie");
	});

	it.each([
		"text/plain",
		"text/html; charset=utf-8",
		"application/json",
		"application/problem+json",
	])(
		"preserves ordinary UTF-8 text for %s",
		async (contentType) => {
			const body = '"café 🌍"';
			const result = await fromWebResponse(
				new Response(body, {
					headers: { "content-type": contentType },
				}),
			);

			expect(result.body).toBe(body);
			expect(result.isBase64Encoded).toBe(false);
			expect(Buffer.from(result.body, "utf8")).toEqual(
				Buffer.from(body),
			);
		},
	);

	it("encodes binary responses as base64", async () => {
		const result = await fromWebResponse(
			new Response(Uint8Array.from([0, 1, 2, 255]), {
				headers: { "content-type": "application/octet-stream" },
			}),
		);
		expect(result.body).toBe("AAEC/w==");
		expect(result.isBase64Encoded).toBe(true);
	});

	it.each([
		{ status: 200, body: null },
		{ status: 200, body: "" },
		{ status: 204, body: null },
		{ status: 304, body: null },
	])(
		"handles empty responses without base64 encoding: $status, $body",
		async ({ status, body }) => {
			const result = await fromWebResponse(
				new Response(body, {
					status,
					headers: { "content-encoding": "gzip" },
				}),
			);
			expect(result).toMatchObject({
				statusCode: status,
				headers: { "content-encoding": "gzip" },
				body: "",
				isBase64Encoded: false,
			});
		},
	);
});

describe("invoke", () => {
	it("rejects a direct request before invoking the renderer", async () => {
		let rendered = false;
		const result = await Effect.runPromise(
			invoke(
				{ headers: { host: "function.example" } },
				invocationContext,
				undefined,
				() => {
					rendered = true;
					return Promise.resolve(new Response("unexpected"));
				},
				{
					apiGateway: false,
					requestTargetParameter: "original_target",
				},
			),
		);
		expect(rendered).toBe(false);
		expect(result.statusCode).toBe(400);
		expect(result.body).toMatch(/request target/);
	});

	it("preserves application failures", async () => {
		const failure = new Error("Application render failed");
		const result = await Effect.runPromise(
			Effect.either(
				invoke(
					{ headers: { host: "function.example" } },
					invocationContext,
					undefined,
					() => Promise.reject(failure),
				),
			),
		);
		expect(result).toMatchObject({
			_tag: "Left",
			left: failure,
		});
	});
});
