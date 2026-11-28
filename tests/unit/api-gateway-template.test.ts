import { describe, expect, it } from "vitest";
import { Targets } from "@astro-yandex-cloud/targets";

import { generateApiGatewaySpecificationTemplate } from "../../packages/adapter/src/conditional/ApiGatewaySpecificationTemplate";
import {
	defineDeploymentManifest,
	encodeDeploymentManifest,
} from "../../packages/adapter/src/mandatory/DeploymentManifest";
import {
	clientDocuments,
	manifestRoutes,
	reconcileRoutes,
	requiredOnDemandRoutes,
	type RoutePlan,
} from "../../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements";
import type { IntegrationResolvedRoute } from "astro";
import { pathToFileURL } from "node:url";

function templateFor(
	staticUrl: string,
	runtimePattern: string,
	staticPriority: number,
	runtimePriority: number,
	{
		recursive404 = false,
		staticKind = "page",
		staticPattern = staticUrl,
		trailingSlash = "ignore",
		staticRegex = "^.*$",
		runtimeRegex = "^.*$",
		notFoundScope = "/",
	}: {
		recursive404?: boolean;
		staticKind?: "page" | "endpoint";
		staticPattern?: string;
		trailingSlash?: RoutePlan["trailingSlash"];
		/** Astro's regex for each route; the default matches every URL. */
		staticRegex?: string;
		runtimeRegex?: string;
		notFoundScope?: string;
	} = {},
) {
	const notFoundUrl = `${notFoundScope === "/" ? "" : notFoundScope}/404`;
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
								url: notFoundUrl,
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
							scope: notFoundScope,
							url: notFoundUrl,
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
					pattern: notFoundUrl,
					priority: -1,
					patternRegex: "^/404/?$",
					paths: [
						{
							url: notFoundUrl,
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
		trailingSlash,
		routes: [
			{
				kind: "prerendered",
				routeKind: staticKind,
				pattern: staticPattern,
				priority: staticPriority,
				patternRegex: staticRegex,
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
				patternRegex: runtimeRegex,
				origin: "project",
				artifactId: manifest.artifacts.functions[0]!
					.id as Extract<
					RoutePlan["routes"][number],
					{ kind: "on-demand" }
				>["artifactId"],
			},
		],
	};
	// The production writer validates the Manifest before Gateway generation;
	// a scope with literal braces exercises the generator on its own.
	if (recursive404 && notFoundScope === "/")
		encodeDeploymentManifest(manifest);
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

	it.each([
		{
			trailingSlash: "ignore",
			url: "/api/report.xml",
			paths: ["/api/report.xml", "/api/report.xml/"],
		},
		{
			trailingSlash: "always",
			url: "/api/report.xml/",
			paths: ["/api/report.xml/"],
		},
	] as const)(
		"derives Gateway aliases of a dotted parameter value from its route under $trailingSlash",
		({ trailingSlash, url, paths }) => {
			const template = templateFor(url, "/runtime/[id]", 1, 0, {
				staticKind: "endpoint",
				staticPattern: "/api/[slug]",
				trailingSlash,
			});
			const literal = Object.keys(template.paths).filter(
				(path) => !path.startsWith("/runtime"),
			);
			expect(literal.sort()).toEqual([...paths].sort());
		},
	);

	// Astro ranks /en/[name] ahead of /[lang]/feed.xml because its first
	// segment is static, while Gateway prefers the literal /en/feed.xml.
	it.each([
		{ trailingSlash: "always", conflict: false },
		{ trailingSlash: "ignore", conflict: true },
		{ trailingSlash: "never", conflict: true },
	] as const)(
		"compares an on-demand page with a prerendered endpoint only at spellings Astro matches under $trailingSlash",
		({ trailingSlash, conflict }) => {
			const generate = () =>
				templateFor("/en/feed.xml", "/en/[name]", 1, 0, {
					staticKind: "endpoint",
					staticPattern: "/[lang]/feed.xml",
					trailingSlash,
				});
			if (conflict) {
				expect(generate).toThrow(
					/cannot preserve Astro route priority/,
				);
				return;
			}
			const template = generate();
			expect(
				template.paths["/en/feed.xml"]?.get?.[
					"x-yc-apigateway-integration"
				],
			).toMatchObject({ type: "object_storage" });
			// The slashless spelling still reaches Astro, which redirects it.
			for (const path of ["/en/{name}/", "/en/{name}"])
				expect(
					template.paths[path]?.["x-yc-apigateway-any-method"]?.[
						"x-yc-apigateway-integration"
					],
					path,
				).toMatchObject({ type: "cloud_functions" });
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

	it("encodes literal braces in a recursive 404 scope", () => {
		const template = templateFor("/", "/api/[id]", 1, 0, {
			recursive404: true,
			notFoundScope: "/docs/{example}",
		});
		for (const path of [
			"/docs/%7Bexample%7D/{_+}",
			"/docs/%7Bexample%7D",
			"/docs/%7Bexample%7D/",
		])
			expect(
				template.paths[path]?.["x-yc-apigateway-any-method"]?.[
					"x-yc-apigateway-integration"
				],
				path,
			).toMatchObject({
				type: "object_storage",
				object: "404.html",
			});
		expect(
			Object.keys(template.paths).filter((path) =>
				path.includes("{example}"),
			),
		).toEqual([]);
	});

	// Astro 7.1.6 regexes for these routes under each trailingSlash policy.
	const catchAllPage = {
		always: String.raw`^\/en(?:\/(.*?))?\/$`,
		ignore: String.raw`^\/en(?:\/(.*?))?\/?$`,
	};
	const feedEndpoint = String.raw`^\/([^/]+?)\/feed\.xml$`;

	it("accepts a literal endpoint that a slash-bound catch-all page cannot match", () => {
		const template = templateFor(
			"/en/feed.xml",
			"/en/[...name]",
			1,
			0,
			{
				staticKind: "endpoint",
				staticPattern: "/[lang]/feed.xml",
				trailingSlash: "always",
				staticRegex: feedEndpoint,
				runtimeRegex: catchAllPage.always,
			},
		);
		expect(
			template.paths["/en/feed.xml"]?.get?.[
				"x-yc-apigateway-integration"
			],
		).toMatchObject({ type: "object_storage" });
		expect(
			template.paths["/en/{name+}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});

	it("rejects the same overlap when Astro matches the URL with both routes", () => {
		expect(() =>
			templateFor("/en/feed.xml", "/en/[...name]", 1, 0, {
				staticKind: "endpoint",
				staticPattern: "/[lang]/feed.xml",
				trailingSlash: "ignore",
				staticRegex: feedEndpoint,
				runtimeRegex: catchAllPage.ignore,
			}),
		).toThrow(/cannot preserve Astro route priority/);
	});

	it("lets a stored endpoint keep a path that a slash-bound empty-rest alias shares", () => {
		const template = templateFor(
			"/en/feed.xml",
			"/en/feed.xml/[...tail]",
			1,
			0,
			{
				staticKind: "endpoint",
				trailingSlash: "always",
				staticRegex: String.raw`^\/en\/feed\.xml$`,
				runtimeRegex: String.raw`^\/en\/feed\.xml(?:\/(.*?))?\/$`,
			},
		);
		expect(
			template.paths["/en/feed.xml"]?.get?.[
				"x-yc-apigateway-integration"
			],
		).toMatchObject({ type: "object_storage" });
		expect(
			template.paths["/en/feed.xml/"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
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
	it.each<{
		html: string;
		required: boolean;
		base?: string;
		site?: string;
		/** The public URL the document is served at. */
		url?: string;
	}>([
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
		{
			html: '<img src="https://cdn.example/_image?w=320">',
			required: false,
		},
		{
			html: '<img src="//cdn.example/_image?w=320">',
			required: false,
		},
		{
			html: '<img src="/blog/_image?w=320">',
			required: false,
		},
		{
			html: '<img srcset="/a.png 1x, /docs/_image?href=b 2x">',
			base: "/docs",
			required: true,
		},
		{
			html: '<img src="/_image?href=x">',
			base: "/docs",
			required: false,
		},
		{
			html: '<meta property="og:image" content="https://example.com/docs/_image?href=x">',
			base: "/docs",
			site: "https://example.com/docs/",
			required: true,
		},
		{
			html: '<img src="//example.com/docs/_image?href=x">',
			base: "/docs",
			site: "https://example.com/docs/",
			required: true,
		},
		{
			html: '<img src="//cdn.example/docs/_image?href=x">',
			base: "/docs",
			site: "https://example.com/docs/",
			required: false,
		},
		{
			html: '<meta property="og:image" content="https://cdn.example/docs/_image?href=x">',
			base: "/docs",
			site: "https://example.com/docs/",
			required: false,
		},
		{
			html: '<img src="_image?href=x">',
			required: true,
		},
		{
			html: '<img src="./_image?href=x">',
			url: "/blog/",
			required: false,
		},
		{
			html: '<img src="../_image?href=x">',
			url: "/blog/",
			required: true,
		},
		{
			html: '<img src="_image?href=x">',
			url: "/blog",
			required: true,
		},
		{
			html: "<img srcset='a.png 1x, _image?href=b 2x'>",
			base: "/docs",
			required: true,
		},
		{
			html: '<img src="_image?href=x">',
			base: "/docs",
			url: "/docs/guide/",
			required: false,
		},
		{
			html: '<img src="_image#top?href=x">',
			required: false,
		},
		{
			html: '<!-- <img src="/_image?href=x"> -->',
			required: false,
		},
		{
			html: '<!-- an image follows --><img src="/_image?href=x">',
			required: true,
		},
		{
			html: '<img alt="<!--" src="/_image?href=x">',
			required: true,
		},
		{
			html: '<script>if (a <!--b) {}</script><img src="/_image?href=x">',
			required: true,
		},
		{
			html: '<base href="/docs/"><img src="_image?href=x">',
			base: "/docs",
			url: "/docs/guide/",
			required: true,
		},
		{
			html: '<base href="https://cdn.example/"><img src="_image?href=x">',
			required: false,
		},
		{
			html: '<!-- <base href="https://cdn.example/"> --><img src="_image?href=x">',
			required: true,
		},
		{
			html: '<textarea><base href="https://cdn.example/"></textarea><img src="_image?href=x">',
			required: true,
		},
		{
			html: '<img alt=\'<base href="https://cdn.example/">\' src="_image?href=x">',
			required: true,
		},
		{
			html: '<base data-note=" href=https://cdn.example/" href="/"><img src="_image?href=x">',
			required: true,
		},
		{
			html: '<BASE HREF="https://cdn.example/"><img src="_image?href=x">',
			required: false,
		},
		{
			html: '<template><base href="https://cdn.example/"></template><img src="/_image?href=x">',
			required: true,
		},
		{
			html: '<img src="/_image&#63;href=x">',
			required: true,
		},
		{
			html: '<noscript><img src="/_image?href=x"></noscript>',
			required: true,
		},
		{
			html: '<base href="/_image?href=x"><p>Text</p>',
			required: false,
		},
		{
			html: '<base href="data:text/plain,test"><img src="_image?href=x">',
			required: true,
		},
		{
			html: '<base href="javascript:void(0)"><img src="_image?href=x">',
			required: true,
		},
		{
			html: '<img srcset="https://cdn.example/a.png?x=1,/_image?href=x 1x">',
			required: false,
		},
		{
			html: '<img src="/_image&#9;?href=x">',
			required: true,
		},
		{
			html: '<template><style-card></style-card></template><base href="/"><img src="_image?href=x">',
			url: "/guide/",
			required: true,
		},
		{
			html: '<style>a{}</style ><base href="/"><img src="_image?href=x">',
			url: "/guide/",
			required: true,
		},
	])(
		"requires the image endpoint only for an actual image request: $html at $url",
		({ html, required, base = "/", site, url }) => {
			expect(
				requiredOnDemandRoutes({
					base,
					site,
					resolvedRoutes: [imageRoute],
					clientDocuments: [
						{
							urls: [url ?? (base === "/" ? "/" : `${base}/`)],
							html,
						},
					],
					hasServerIslands: false,
					hasRuntimeImages: false,
					imageEndpoint: "/_image",
				}),
			).toEqual(required ? [imageRoute] : []);
		},
	);

	const islandRoute = {
		type: "page",
		origin: "internal",
		pattern: "/_server-islands/[name]",
		isPrerendered: false,
	} as IntegrationResolvedRoute;
	it.each([
		{
			name: "page text",
			html: "<p>Astro serves islands from /_server-islands/.</p>",
			hasServerIslands: false,
			required: false,
		},
		{
			name: "escaped example code",
			html: "<pre><code>fetch(&quot;/_server-islands/Card&quot;)</code></pre>",
			hasServerIslands: false,
			required: false,
		},
		{
			name: "generated GET preload",
			html: '<link rel="preload" as="fetch" href="/docs/_server-islands/Card?e=x&amp;p=&amp;s=" crossorigin="anonymous">',
			base: "/docs",
			hasServerIslands: false,
			required: true,
		},
		{
			name: "a preload outside the base",
			html: '<link rel="preload" as="fetch" href="/_server-islands/Card" crossorigin="anonymous">',
			base: "/docs",
			hasServerIslands: false,
			required: false,
		},
		{
			name: "a preload on another origin",
			html: '<link rel="preload" as="fetch" href="https://cdn.example/_server-islands/Card" crossorigin="anonymous">',
			hasServerIslands: false,
			required: false,
		},
		{
			name: "a preload on the site origin",
			html: '<link rel="preload" as="fetch" href="https://example.com/_server-islands/Card" crossorigin="anonymous">',
			site: "https://example.com/",
			hasServerIslands: false,
			required: true,
		},
		{
			name: "a request to another origin",
			html: '<script type="module">let response = await fetch("https://cdn.example/_server-islands/Card/", { method: \'POST\' });</script>',
			hasServerIslands: false,
			required: false,
		},
		{
			name: "a canonical link",
			html: '<link rel="canonical" href="/_server-islands/Card">',
			hasServerIslands: false,
			required: false,
		},
		{
			name: "a custom element named like a link",
			html: '<link-card href="/_server-islands/Card"></link-card>',
			hasServerIslands: false,
			required: false,
		},
		{
			name: "a commented-out preload",
			html: '<!-- <link rel="preload" as="fetch" href="/_server-islands/Card"> -->',
			hasServerIslands: false,
			required: false,
		},
		{
			name: "generated POST request",
			html: '<script type="module" data-astro-rerun data-island-id="a1">let data = {}; let response = await fetch("/_server-islands/Card/", { method: \'POST\' });replaceServerIsland("a1", response);</script>',
			hasServerIslands: false,
			required: true,
		},
		{
			name: "emitted island entries",
			html: "",
			hasServerIslands: true,
			required: true,
		},
	] as Array<{
		name: string;
		html: string;
		base?: string;
		site?: string;
		hasServerIslands: boolean;
		required: boolean;
	}>)(
		"requires the server-island endpoint only with island evidence: $name",
		({ html, base = "/", site, hasServerIslands, required }) => {
			expect(
				requiredOnDemandRoutes({
					base,
					site,
					resolvedRoutes: [islandRoute],
					clientDocuments: [
						{ urls: [base === "/" ? "/" : `${base}/`], html },
					],
					hasServerIslands,
					hasRuntimeImages: false,
					imageEndpoint: "/_image",
				}),
			).toEqual(required ? [islandRoute] : []);
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
		{
			file: "api/report.xml",
			pattern: "/api/[slug]",
			trailingSlash: "always",
			url: "/api/report.xml/",
		},
		{
			file: "api/report.xml",
			pattern: "/api/[slug]",
			trailingSlash: "ignore",
			url: "/api/report.xml",
		},
		{
			file: "feeds/main.xml",
			pattern: "/feeds/[name].xml",
			trailingSlash: "always",
			url: "/feeds/main.xml",
		},
		// An Astro 7.1.6 probe build renders this endpoint's request URL as `/guide.html/`.
		{
			file: "guide.html",
			pattern: "/[page]",
			trailingSlash: "always",
			url: "/guide.html/",
		},
		// Astro escapes `#` in the parameter of the request URL and the emitted name.
		{
			file: "api/a%23b.txt",
			pattern: "/api/[slug].txt",
			trailingSlash: "always",
			url: "/api/a%23b.txt",
		},
	] as const)(
		"projects a prerendered endpoint $file under trailingSlash $trailingSlash",
		(entry) => {
			const { file, trailingSlash, url } = entry;
			const clientDirectory = new URL("file:///build/client/");
			const route = {
				type: "endpoint",
				origin: "project",
				pattern: "pattern" in entry ? entry.pattern : `/${file}`,
				isPrerendered: true,
				patternRegex: /^.*$/,
			} as unknown as IntegrationResolvedRoute;
			const plan = reconcileRoutes({
				base: "/",
				clientDirectory,
				clientFiles: [file],
				clientHtml: new Map(),
				pages: [],
				resolvedRoutes: [route],
				emittedAssets: new Map([
					[
						route.pattern,
						[pathToFileURL(`/build/client/${file}`)],
					],
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

	it.each([
		{
			pathname: "docs/café/",
			file: "docs/café/index.html",
			url: "/docs/caf%C3%A9/",
		},
		// Astro escapes `#` in a parameter; the escape is kept, not doubled.
		{
			pathname: "docs/a%23b/",
			file: "docs/a%23b/index.html",
			url: "/docs/a%23b/",
		},
		{
			pathname: "docs/100%/",
			file: "docs/100%/index.html",
			url: "/docs/100%25/",
		},
	])(
		"publishes the canonical URL of the prerendered page $pathname",
		({ pathname, file, url }) => {
			const clientDirectory = new URL("file:///build/client/");
			const page = {
				type: "page",
				origin: "project",
				pattern: "/docs/[slug]",
				isPrerendered: true,
				patternRegex: /^\/docs\/([^/]+?)\/$/,
			} as unknown as IntegrationResolvedRoute;
			const plan = reconcileRoutes({
				base: "/",
				clientDirectory,
				clientFiles: [file],
				clientHtml: new Map(),
				pages: [{ pathname }],
				resolvedRoutes: [page],
				emittedAssets: new Map([
					[
						page.pattern,
						[pathToFileURL(`/build/client/${file}`)],
					],
				]),
				hasFunction: false,
				trailingSlash: "always",
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

	it.each<{
		name: string;
		file: string;
		html: string;
		/** Astro's page pathname; absent for a public HTML file. */
		pathname?: string;
		trailingSlash: RoutePlan["trailingSlash"];
		required: boolean;
	}>([
		{
			name: "a directory page under trailingSlash never",
			file: "about/index.html",
			html: '<img src="_image?href=x">',
			pathname: "about",
			trailingSlash: "never",
			required: true,
		},
		{
			name: "a directory page under trailingSlash always",
			file: "about/index.html",
			html: '<img src="_image?href=x">',
			pathname: "about/",
			trailingSlash: "always",
			required: false,
		},
		{
			name: "the slashless alias of a page under trailingSlash ignore",
			file: "about/index.html",
			html: '<img src="_image?href=x">',
			pathname: "about/",
			trailingSlash: "ignore",
			required: true,
		},
		{
			name: "a public HTML file",
			file: "embed/widget.html",
			html: '<img src="../_image?href=x">',
			trailingSlash: "always",
			required: true,
		},
	])(
		"resolves a relative image request against $name",
		({ file, html, pathname, trailingSlash, required }) => {
			const clientDirectory = new URL("file:///build/client/");
			const page = {
				type: "page",
				origin: "project",
				pattern: "/about",
				isPrerendered: true,
				patternRegex: /^\/about\/?$/,
			} as unknown as IntegrationResolvedRoute;
			const image = {
				...imageRoute,
				patternRegex: /^\/_image\/?$/,
			} as IntegrationResolvedRoute;
			const plan = reconcileRoutes({
				base: "/",
				clientDirectory,
				clientFiles: [file],
				clientHtml: new Map([[file, html]]),
				pages: pathname === undefined ? [] : [{ pathname }],
				resolvedRoutes: [page, image],
				emittedAssets: new Map(
					pathname === undefined
						? []
						: [[page.pattern, [new URL(file, clientDirectory)]]],
				),
				hasFunction: true,
				trailingSlash,
				hasServerIslands: false,
				hasRuntimeImages: false,
				imageEndpoint: "/_image",
			});
			expect(
				plan.routes.some(
					(route) =>
						route.kind === "on-demand" &&
						route.pattern === "/_image",
				),
			).toBe(required);
		},
	);

	const scanInput = ({
		pattern,
		type = "page",
		file,
		pathname,
		html,
		base = "/",
		trailingSlash = "always",
		recursive404 = false,
	}: {
		pattern: string;
		type?: "page" | "endpoint";
		file: string;
		pathname?: string;
		html: string;
		base?: string;
		trailingSlash?: RoutePlan["trailingSlash"];
		recursive404?: boolean;
	}) => {
		const clientDirectory = new URL("file:///build/client/");
		const route = {
			type,
			origin: "project",
			pattern,
			isPrerendered: true,
			patternRegex: /^.*$/,
		} as unknown as IntegrationResolvedRoute;
		return {
			base,
			clientDirectory,
			clientFiles: [file],
			clientHtml: new Map([[file, html]]),
			pages: pathname === undefined ? [] : [{ pathname }],
			resolvedRoutes: [route, imageRoute],
			emittedAssets: new Map([
				[pattern, [new URL(file, clientDirectory)]],
			]),
			hasFunction: true,
			trailingSlash,
			recursive404,
			hasServerIslands: false,
			hasRuntimeImages: false,
			imageEndpoint: "/_image",
		};
	};
	const scanEvidence = (
		input: Parameters<typeof scanInput>[0],
	) => {
		const evidence = scanInput(input);
		return requiredOnDemandRoutes({
			...evidence,
			clientDocuments: clientDocuments(evidence),
		}).includes(imageRoute);
	};

	it.each([
		{
			name: "a catch-all page emitted at a 404 path",
			pattern: "/[...slug]",
			recursive404: false,
			required: false,
		},
		{
			name: "a nested 404 page without recursive 404 scopes",
			pattern: "/help/404",
			recursive404: false,
			required: false,
		},
		{
			name: "a nested 404 page with recursive 404 scopes",
			pattern: "/help/404",
			recursive404: true,
			required: true,
		},
	])(
		"scans the slashless 404 spelling only where the Gateway serves it: $name",
		({ pattern, recursive404, required }) => {
			expect(
				scanEvidence({
					pattern,
					file: "help/404/index.html",
					pathname: "help/404/",
					html: '<img src="../_image?href=x">',
					recursive404,
				}),
			).toBe(required);
		},
	);

	it("resolves prerendered endpoint HTML against the URL its route serves", () => {
		expect(
			scanEvidence({
				pattern: "/[page]",
				type: "endpoint",
				file: "guide.html",
				html: '<img src="../_image?href=x">',
				base: "/docs",
			}),
		).toBe(true);
	});

	it("appends every path of a large prerendered route to the Manifest projection", () => {
		const count = 500_000;
		const plan: RoutePlan = {
			base: "/",
			trailingSlash: "ignore",
			routes: [
				{
					kind: "prerendered",
					routeKind: "page",
					pattern: "/[id]",
					priority: 0,
					patternRegex: "^.*$",
					paths: Array.from({ length: count }, (_, index) => ({
						url: `/${index}`,
						objectKey: `${index}/index.html`,
						artifactId: "client:primary" as Extract<
							RoutePlan["routes"][number],
							{ kind: "prerendered" }
						>["paths"][number]["artifactId"],
					})),
				},
			],
		};
		expect(manifestRoutes(plan).prerendered).toHaveLength(count);
	});

	it("serves a reconciled plan under a base through the Manifest and Gateway template", () => {
		const clientDirectory = new URL("file:///build/client/");
		const page = {
			type: "page",
			origin: "project",
			pattern: "/about",
			isPrerendered: true,
			patternRegex: /^\/about\/$/,
		} as unknown as IntegrationResolvedRoute;
		const api = {
			type: "endpoint",
			origin: "project",
			pattern: "/api/[id]",
			isPrerendered: false,
			patternRegex: /^\/api\/([^/]+?)\/$/,
		} as unknown as IntegrationResolvedRoute;
		const plan = reconcileRoutes({
			base: "/docs",
			clientDirectory,
			clientFiles: ["about/index.html"],
			clientHtml: new Map([
				["about/index.html", "<p>About</p>"],
			]),
			pages: [{ pathname: "about/" }],
			resolvedRoutes: [page, api],
			emittedAssets: new Map([
				[
					page.pattern,
					[new URL("about/index.html", clientDirectory)],
				],
			]),
			hasFunction: true,
			trailingSlash: "always",
			hasServerIslands: false,
			hasRuntimeImages: false,
			imageEndpoint: "/_image",
		});
		const routes = manifestRoutes(plan);
		const manifest = defineDeploymentManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0-beta.0" },
			target: Targets.ObjectStorageCloudFunctionsTarget,
			modifiers: { apiGateway: true },
			gatewayTemplate: { path: "api-gateway.yaml" },
			base: "/docs",
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
			routes,
		});
		encodeDeploymentManifest(manifest);
		const template = generateApiGatewaySpecificationTemplate(
			manifest,
			plan,
		);
		expect(
			template.paths["/docs/about/"]?.get?.[
				"x-yc-apigateway-integration"
			],
		).toMatchObject({
			type: "object_storage",
			object: "docs/about/index.html",
		});
		expect(
			template.paths["/docs/api/{id}/"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});

	it("parses a document again after its HTML changes", () => {
		const document = { urls: ["/"], html: "<p>No images</p>" };
		const required = () =>
			requiredOnDemandRoutes({
				base: "/",
				resolvedRoutes: [imageRoute],
				clientDocuments: [document],
				hasServerIslands: false,
				hasRuntimeImages: false,
				imageEndpoint: "/_image",
			}).length > 0;
		expect(required()).toBe(false);
		document.html = '<img src="/_image?href=x">';
		expect(required()).toBe(true);
	});

	it.each([
		{
			name: "a normal page at the base",
			pattern: "/",
			url: "/docs/404/",
			scopes: [],
		},
		{
			name: "a 404 page below the base",
			pattern: "/404",
			url: "/docs/404/404/",
			scopes: ["/docs/404"],
		},
	])(
		"classifies 404 pages below a base ending in /404: $name",
		({ pattern, url, scopes }) => {
			const plan: RoutePlan = {
				base: "/docs/404",
				trailingSlash: "always",
				routes: [
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: `/docs/404${pattern === "/" ? "/" : pattern}`,
						priority: 0,
						patternRegex: "^.*$",
						paths: [
							{
								url,
								objectKey: "docs/404/index.html",
								artifactId: "client:primary" as Extract<
									RoutePlan["routes"][number],
									{ kind: "prerendered" }
								>["paths"][number]["artifactId"],
							},
						],
					},
				],
			};
			expect(
				manifestRoutes(plan, true).notFound.map(
					({ scope }) => scope,
				),
			).toEqual(scopes);
		},
	);

	it("rejects an oversized template without comparing every pair of stored paths", () => {
		const count = 40_000;
		const artifactId = "client:primary" as Extract<
			RoutePlan["routes"][number],
			{ kind: "prerendered" }
		>["paths"][number]["artifactId"];
		const paths = Array.from({ length: count }, (_, index) => ({
			url: `/p/${index}`,
			objectKey: `p/${index}/index.html`,
			artifactId,
		}));
		const manifest = defineDeploymentManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0-beta.0" },
			target: Targets.ObjectStorageCloudFunctionsTarget,
			modifiers: { apiGateway: true },
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
				prerendered: paths.map((path) => ({
					kind: "page",
					...path,
				})),
				onDemand: [
					{
						kind: "endpoint",
						pattern: "/api/[id]",
						artifactId: "function:shared",
					},
				],
				notFound: [],
			},
		});
		expect(() =>
			generateApiGatewaySpecificationTemplate(manifest, {
				base: "/",
				trailingSlash: "ignore",
				routes: [
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: "/p/[id]",
						priority: 1,
						patternRegex: "^.*$",
						paths,
					},
					{
						kind: "on-demand",
						routeKind: "endpoint",
						pattern: "/api/[id]",
						priority: 0,
						patternRegex: "^.*$",
						origin: "project",
						artifactId: "function:shared" as Extract<
							RoutePlan["routes"][number],
							{ kind: "on-demand" }
						>["artifactId"],
					},
				],
			}),
		).toThrow(/exceeding the 3.5 MB limit/);
	}, 5_000);

	const recursive404Template = (count: number) => {
		const artifactId = "client:primary" as Extract<
			RoutePlan["routes"][number],
			{ kind: "prerendered" }
		>["paths"][number]["artifactId"];
		const pages = Array.from({ length: count }, (_, index) => ({
			url: `/b/${index}`,
			objectKey: `b/${index}/index.html`,
			artifactId,
		}));
		const notFoundPages = Array.from(
			{ length: count },
			(_, index) => ({
				url: `/b/${index}/404`,
				objectKey: `b/${index}/404/index.html`,
				artifactId,
			}),
		);
		const manifest = defineDeploymentManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0-beta.0" },
			target: Targets.ObjectStorageCloudFunctionsTarget,
			modifiers: { apiGateway: true, recursive404: true },
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
				prerendered: [...pages, ...notFoundPages].map(
					(path) => ({
						kind: "page",
						...path,
					}),
				),
				onDemand: [
					{
						kind: "endpoint",
						pattern: "/api/[id]",
						artifactId: "function:shared",
					},
				],
				notFound: notFoundPages.map((path, index) => ({
					scope: `/b/${index}`,
					...path,
				})),
			},
		});
		return () =>
			generateApiGatewaySpecificationTemplate(manifest, {
				base: "/",
				trailingSlash: "ignore",
				routes: [
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: "/b/[id]",
						priority: 2,
						patternRegex: "^.*$",
						paths: pages,
					},
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: "/b/[id]/404",
						priority: 1,
						patternRegex: "^.*$",
						paths: notFoundPages,
					},
					{
						kind: "on-demand",
						routeKind: "endpoint",
						pattern: "/api/[id]",
						priority: 0,
						patternRegex: "^.*$",
						origin: "project",
						artifactId: "function:shared" as Extract<
							RoutePlan["routes"][number],
							{ kind: "on-demand" }
						>["artifactId"],
					},
				],
			});
	};

	it("rejects an oversized template with many recursive 404 scopes without comparing every scope with every route", () => {
		expect(recursive404Template(3_000)).toThrow(
			/exceeding the 3.5 MB limit/,
		);
	}, 5_000);

	it("keeps each recursive 404 scope's exact paths when no route takes them", () => {
		const template = recursive404Template(2)();
		for (const path of ["/b/0", "/b/0/"])
			expect(Object.keys(template.paths)).toContain(path);
		expect(
			template.paths["/b/0/{_+}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ object: "b/0/404/index.html" });
		expect(
			template.paths["/b/0/404"]?.get?.responses["200"],
		).toMatchObject({ "x-yc-status-mapping": 404 });
	});

	it("serves both root spellings of a 404 scope without a page from the 404 object", () => {
		const artifactId = "client:primary" as Extract<
			RoutePlan["routes"][number],
			{ kind: "prerendered" }
		>["paths"][number]["artifactId"];
		const page = {
			url: "/b/0",
			objectKey: "b/0/index.html",
			artifactId,
		};
		const pageNotFound = {
			url: "/b/0/404",
			objectKey: "b/0/404/index.html",
			artifactId,
		};
		const orphanNotFound = {
			url: "/c/404",
			objectKey: "c/404/index.html",
			artifactId,
		};
		const manifest = defineDeploymentManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0-beta.0" },
			target: Targets.ObjectStorageCloudFunctionsTarget,
			modifiers: { apiGateway: true, recursive404: true },
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
				prerendered: [page, pageNotFound, orphanNotFound].map(
					(path) => ({ kind: "page", ...path }),
				),
				onDemand: [],
				notFound: [
					{ scope: "/b/0", ...pageNotFound },
					{ scope: "/c", ...orphanNotFound },
				],
			},
		});
		const template = generateApiGatewaySpecificationTemplate(
			manifest,
			{
				base: "/",
				trailingSlash: "ignore",
				routes: [
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: "/b/[id]",
						priority: 2,
						patternRegex: "^.*$",
						paths: [page],
					},
					{
						kind: "prerendered",
						routeKind: "page",
						pattern: "/[section]/404",
						priority: 1,
						patternRegex: "^.*$",
						paths: [pageNotFound, orphanNotFound],
					},
				],
			},
		);
		for (const path of ["/c", "/c/"]) {
			const operation =
				template.paths[path]?.["x-yc-apigateway-any-method"];
			expect(
				operation?.["x-yc-apigateway-integration"],
				path,
			).toMatchObject({
				object: "c/404/index.html",
			});
			expect(operation?.responses["200"], path).toMatchObject({
				"x-yc-status-mapping": 404,
			});
		}
		for (const path of ["/b/0", "/b/0/"])
			expect(
				template.paths[path]?.get?.[
					"x-yc-apigateway-integration"
				],
				path,
			).toMatchObject({ object: "b/0/index.html" });
	});

	it("measures the longest 404 fallback without passing every scope as an argument", () => {
		const count = 200_000;
		const artifactId = "client:primary" as Extract<
			RoutePlan["routes"][number],
			{ kind: "prerendered" }
		>["paths"][number]["artifactId"];
		const notFoundPages = Array.from(
			{ length: count },
			(_, index) => ({
				url: `/s/${index}/404`,
				objectKey: `s/${index}/404/index.html`,
				artifactId,
			}),
		);
		const manifest = defineDeploymentManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0-beta.0" },
			target: Targets.ObjectStorageCloudFunctionsTarget,
			modifiers: { apiGateway: true, recursive404: true },
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
				prerendered: [],
				onDemand: [],
				notFound: notFoundPages.map((path, index) => ({
					scope: `/s/${index}`,
					...path,
				})),
			},
		});
		expect(() =>
			generateApiGatewaySpecificationTemplate(manifest, {
				base: "/",
				trailingSlash: "ignore",
				routes: [],
			}),
		).toThrow(/exceeding the 3.5 MB limit/);
	});

	it("counts a recursive 404 page's base element when bounding fallback depths", () => {
		expect(
			scanEvidence({
				pattern: "/404",
				file: "404/index.html",
				pathname: "404/",
				html: '<base href="../../../../"><img src="_image?href=x">',
				base: "/docs",
				recursive404: true,
			}),
		).toBe(true);
	});

	it.each([
		{ recursive404: true, required: true },
		{ recursive404: false, required: false },
	])(
		"resolves a recursive 404 page's relative image request from any missing URL below its scope: recursive404 $recursive404",
		({ recursive404, required }) => {
			expect(
				scanEvidence({
					pattern: "/404",
					file: "404/index.html",
					pathname: "404/",
					html: '<img src="../../_image?href=x">',
					base: "/docs",
					recursive404,
				}),
			).toBe(required);
		},
	);

	it.each([
		{
			name: "a nested 404 page with recursive 404 scopes",
			pattern: "/help/404",
			recursive404: true,
			urls: ["/help/404/", "/help/404"],
		},
		{
			name: "a nested 404 page without recursive 404 scopes",
			pattern: "/help/404",
			recursive404: false,
			urls: ["/help/404/"],
		},
		{
			name: "a catch-all page emitted at a 404 path",
			pattern: "/[...slug]",
			recursive404: true,
			urls: ["/help/404/"],
		},
	])(
		"pairs a 404 document with the URLs the Gateway serves directly: $name",
		({ pattern, recursive404, urls }) => {
			const [document] = clientDocuments(
				scanInput({
					pattern,
					file: "help/404/index.html",
					pathname: "help/404/",
					html: "<p>Not found</p>",
					recursive404,
				}),
			);
			expect(document?.urls).toEqual(urls);
		},
	);

	it("counts backslash separators when bounding recursive 404 fallback depths", () => {
		expect(
			scanEvidence({
				pattern: "/404",
				file: "404/index.html",
				pathname: "404/",
				html: '<img src="..\\..\\..\\_image?href=x">',
				base: "/docs",
				recursive404: true,
			}),
		).toBe(true);
	});

	it.each([
		{ patternRegex: /^\/_image\/?$/, required: true },
		{ patternRegex: /^\/_image$/, required: false },
	])(
		"accepts the image endpoint's slash spelling only where its route matches it: $patternRegex",
		({ patternRegex, required }) => {
			const route = {
				...imageRoute,
				patternRegex,
			} as IntegrationResolvedRoute;
			expect(
				requiredOnDemandRoutes({
					base: "/",
					resolvedRoutes: [route],
					clientDocuments: [
						{ urls: ["/"], html: '<img src="/_image/?href=x">' },
					],
					hasServerIslands: false,
					hasRuntimeImages: false,
					imageEndpoint: "/_image",
				}),
			).toEqual(required ? [route] : []);
		},
	);

	it("assigns each page the file whose route matches its URL under build.format file", () => {
		const clientDirectory = new URL("file:///build/client/");
		const guide = {
			type: "page",
			origin: "project",
			pattern: "/guide",
			isPrerendered: true,
			patternRegex: /^\/guide\/$/,
		} as unknown as IntegrationResolvedRoute;
		const guideIndex = {
			type: "page",
			origin: "project",
			pattern: "/guide/index",
			isPrerendered: true,
			patternRegex: /^\/guide\/index\/$/,
		} as unknown as IntegrationResolvedRoute;
		const plan = reconcileRoutes({
			base: "/",
			clientDirectory,
			clientFiles: ["guide.html", "guide/index.html"],
			clientHtml: new Map(),
			pages: [
				{ pathname: "guide/" },
				{ pathname: "guide/index/" },
			],
			resolvedRoutes: [guide, guideIndex],
			emittedAssets: new Map([
				[
					guide.pattern,
					[new URL("guide.html", clientDirectory)],
				],
				[
					guideIndex.pattern,
					[new URL("guide/index.html", clientDirectory)],
				],
			]),
			hasFunction: false,
			trailingSlash: "always",
			hasServerIslands: false,
			hasRuntimeImages: false,
			imageEndpoint: "/_image",
		});
		expect(
			plan.routes.flatMap((route) =>
				route.kind === "prerendered"
					? route.paths.map(({ url, objectKey }) => [
							url,
							objectKey,
						])
					: [],
			),
		).toEqual([
			["/guide/", "guide.html"],
			["/guide/index/", "guide/index.html"],
		]);
	});
});
