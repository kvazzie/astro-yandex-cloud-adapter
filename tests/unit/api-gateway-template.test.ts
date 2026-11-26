import { describe, expect, it } from "vitest";
import { Targets } from "@astro-yandex-cloud/targets";

import { generateApiGatewaySpecificationTemplate } from "../../packages/adapter/src/conditional/ApiGatewaySpecificationTemplate";
import {
	defineDeploymentManifest,
	encodeDeploymentManifest,
} from "../../packages/adapter/src/mandatory/DeploymentManifest";
import {
	reconcileRoutes,
	requiredOnDemandRoutes,
	type RoutePlan,
} from "../../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements";
import type { IntegrationResolvedRoute } from "astro";

function templateFor(
	staticUrl: string,
	runtimePattern: string,
	staticPriority: number,
	runtimePriority: number,
	{
		recursive404 = false,
		staticKind = "page",
	}: {
		recursive404?: boolean;
		staticKind?: "page" | "endpoint";
	} = {},
) {
	const manifest = defineDeploymentManifest({
		schemaVersion: 1,
		adapter: { version: "0.1.0-beta.0" },
		target: Targets.ObjectStorageCloudFunctionsTarget,
		modifiers: {
			apiGateway: true,
			...(recursive404 ? { recursive404 } : {}),
		},
		gatewayTemplate: { path: "api-gateway.yaml" },
		base: "/",
		artifacts: {
			client: { id: "client:primary", path: "client" },
			functions: [
				{
					id: "function:shared",
					path: "function",
					runtime: "nodejs22",
					entrypoint: "index.handler",
				},
			],
		},
		routes: {
			prerendered: [
				{
					kind: staticKind,
					url: staticUrl,
					objectKey: "page.html",
					artifactId: "client:primary",
				},
				// The root 404 scope must name a prerendered page.
				...(recursive404
					? [
							{
								kind: "page" as const,
								url: "/404",
								objectKey: "404.html",
								artifactId: "client:primary",
							},
						]
					: []),
			],
			onDemand: [
				{
					kind: "page",
					pattern: runtimePattern,
					artifactId: "function:shared",
					priority: runtimePriority,
					patternRegex: "^.*$",
				},
			],
			notFound: recursive404
				? [
						{
							scope: "/",
							url: "/404",
							objectKey: "404.html",
							artifactId: "client:primary",
						},
					]
				: [],
		},
	});
	// Astro ranks the static 404 page ahead of dynamic routes.
	const notFoundRoutes: RoutePlan["routes"] = recursive404
		? [
				{
					kind: "prerendered",
					routeKind: "page",
					pattern: "/404",
					priority: -1,
					patternRegex: "^/404/?$",
					paths: [
						{
							url: "/404",
							objectKey: "404.html",
							artifactId: manifest.artifacts.client
								.id as Extract<
								RoutePlan["routes"][number],
								{ kind: "prerendered" }
							>["paths"][number]["artifactId"],
						},
					],
				},
			]
		: [];
	const routePlan: RoutePlan = {
		base: "/",
		trailingSlash: "ignore",
		routes: [
			{
				kind: "prerendered",
				routeKind: staticKind,
				pattern: staticUrl,
				priority: staticPriority,
				patternRegex: "^.*$",
				paths: manifest.routes.prerendered
					.filter(({ url }) => url === staticUrl)
					.map(({ url, objectKey, artifactId }) => ({
						url,
						objectKey,
						artifactId: artifactId as Extract<
							RoutePlan["routes"][number],
							{ kind: "prerendered" }
						>["paths"][number]["artifactId"],
					})),
			},
			...notFoundRoutes,
			{
				kind: "on-demand",
				routeKind: "page",
				pattern: runtimePattern,
				priority: runtimePriority,
				patternRegex: "^.*$",
				origin: "project",
				artifactId: manifest.artifacts.functions[0]!
					.id as Extract<
					RoutePlan["routes"][number],
					{ kind: "on-demand" }
				>["artifactId"],
			},
		],
	};
	// The production writer validates the Manifest before Gateway generation.
	if (recursive404) encodeDeploymentManifest(manifest);
	return generateApiGatewaySpecificationTemplate(
		manifest,
		routePlan,
	);
}

describe("API Gateway template route precedence", () => {
	it("keeps a static parent separate from a required child parameter", () => {
		const template = templateFor("/posts/", "/posts/[id]", 1, 0);
		expect(
			template.paths["/posts/"]?.get?.[
				"x-yc-apigateway-integration"
			],
		).toMatchObject({ type: "object_storage" });
		expect(
			template.paths["/posts/{id}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});

	it("keeps the static homepage ahead of an empty catch-all alias", () => {
		const template = templateFor("/", "/[...slug]", 0, 1);
		expect(
			template.paths["/"]?.get?.["x-yc-apigateway-integration"],
		).toMatchObject({
			type: "object_storage",
			object: "page.html",
		});
		expect(
			template.paths["/{slug+}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});

	it.each([
		["/api/status", ["/api/status", "/api/status/"]],
		["/api/report.v-1", ["/api/report.v-1", "/api/report.v-1/"]],
		["/feed.xml", ["/feed.xml"]],
	])(
		"serves both slash spellings of an extensionless prerendered endpoint under ignore: %s",
		(url, paths) => {
			const template = templateFor(url, "/runtime/[id]", 1, 0, {
				staticKind: "endpoint",
			});
			const literal = Object.keys(template.paths).filter(
				(path) => !path.startsWith("/runtime"),
			);
			expect(literal.sort()).toEqual([...paths].sort());
			for (const path of paths)
				expect(
					template.paths[path]?.get?.[
						"x-yc-apigateway-integration"
					],
				).toMatchObject({ object: "page.html" });
		},
	);

	it("encodes literal braces in a prerendered Gateway path", () => {
		const template = templateFor(
			"/docs/{example}",
			"/api/[id]",
			1,
			0,
		);
		for (const path of [
			"/docs/%7Bexample%7D",
			"/docs/%7Bexample%7D/",
		])
			expect(
				template.paths[path]?.get?.[
					"x-yc-apigateway-integration"
				],
			).toMatchObject({
				type: "object_storage",
				object: "page.html",
			});
		expect(Object.keys(template.paths)).not.toContain(
			"/docs/{example}",
		);
	});

	it("keeps a padded greedy parameter distinct from a fixed capture", () => {
		const template = templateFor(
			"/",
			"/[id______]/[...id]",
			1,
			0,
			{
				recursive404: true,
			},
		);
		for (const [path, item] of Object.entries(template.paths)) {
			const names = Object.values(item).flatMap(
				(operation) =>
					operation.parameters?.map(({ name }) => name) ?? [],
			);
			expect(new Set(names).size, path).toBe(names.length);
			for (const name of names)
				expect(path, name).toContain(`{${name}`);
		}
		expect(Object.keys(template.paths)).toContain(
			"/{id______}/{id_______+}",
		);
	});
});

describe("completed-build route requirements", () => {
	const imageRoute = {
		type: "endpoint",
		origin: "internal",
		pattern: "/_image",
		isPrerendered: false,
	} as IntegrationResolvedRoute;
	it.each([
		{
			html: '<img src="/_image?href=%2Fa.png&w=1">',
			required: true,
		},
		{
			html: "<img srcset='/a.png 1x, /_image?href=b 2x'>",
			required: true,
		},
		{
			html: '<div style="background:url(/_image?href=c)"></div>',
			required: true,
		},
		{
			html: "<p>Request /_image?href=x to resize.</p>",
			required: false,
		},
		{
			html: "<pre><code>&lt;img src=&quot;/_image?href=x&quot;&gt;</code></pre>",
			required: false,
		},
	])(
		"requires the image endpoint only for an actual image request: $html",
		({ html, required }) => {
			expect(
				requiredOnDemandRoutes({
					resolvedRoutes: [imageRoute],
					clientHtml: html,
					hasServerIslands: false,
					hasRuntimeImages: false,
					imageEndpoint: "/_image",
				}),
			).toEqual(required ? [imageRoute] : []);
		},
	);

	it.each([
		{
			file: "api/status",
			trailingSlash: "always",
			url: "/api/status/",
		},
		{
			file: "api/status",
			trailingSlash: "never",
			url: "/api/status",
		},
		{
			file: "feed.xml",
			trailingSlash: "always",
			url: "/feed.xml",
		},
		{
			file: "api/report.v-1",
			trailingSlash: "always",
			url: "/api/report.v-1/",
		},
		{
			file: ".well-known/.env",
			trailingSlash: "always",
			url: "/.well-known/.env/",
		},
	] as const)(
		"projects a prerendered endpoint $file under trailingSlash $trailingSlash",
		({ file, trailingSlash, url }) => {
			const clientDirectory = new URL("file:///build/client/");
			const route = {
				type: "endpoint",
				origin: "project",
				pattern: `/${file}`,
				isPrerendered: true,
				patternRegex: /^.*$/,
			} as unknown as IntegrationResolvedRoute;
			const plan = reconcileRoutes({
				base: "/",
				clientDirectory,
				clientFiles: [file],
				clientHtml: "",
				pages: [],
				resolvedRoutes: [route],
				emittedAssets: new Map([
					[route.pattern, [new URL(file, clientDirectory)]],
				]),
				hasFunction: false,
				trailingSlash,
				hasServerIslands: false,
				hasRuntimeImages: false,
				imageEndpoint: "/_image",
			});
			expect(plan.routes[0]).toMatchObject({
				kind: "prerendered",
				paths: [{ url, objectKey: file }],
			});
		},
	);
});
