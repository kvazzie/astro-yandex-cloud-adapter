import { describe, expect, it } from "vitest";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IntegrationResolvedRoute } from "astro";

import yandexCloud, {
	type EncodedOptions,
} from "../../packages/adapter/src";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import Hooks from "../../packages/adapter/src/Hooks";
import * as Options from "../../packages/adapter/src/Options";
import { TargetBuild } from "../../packages/adapter/src/TargetBuild";
import { Errors } from "../../packages/adapter/src/mandatory/ArtifactGeneration";
import { Targets } from "../../packages/adapter/src/Options";

const onDemandRoute = {
	type: "page",
	origin: "project",
	params: ["id"],
	segments: [],
	pattern: "/api/[id]",
	patternRegex: /^\/api\/([^/]+?)$/,
	entrypoint: "src/pages/api/[id].ts",
	isPrerendered: false,
	fallbackRoutes: [],
	generate: () => "/api/id",
} satisfies IntegrationResolvedRoute;

async function adapterDescription(options?: EncodedOptions) {
	const hook = yandexCloud(options).hooks["astro:config:done"];
	let description: unknown;

	await hook?.({
		config: {},
		injectTypes: () => {},
		setAdapter: (adapter: unknown) => {
			description = adapter;
		},
	} as never);

	return description;
}

function optionsError(options: unknown): unknown {
	try {
		yandexCloud(options as EncodedOptions);
	} catch (error) {
		return error;
	}
	throw new Error(
		"Expected the adapter to reject invalid options.",
	);
}

describe("adapter options and routes", () => {
	it.each([
		"function getImage(){return '/cms.png'};export const GET=()=>getImage();",
		"const getImage=()=>'/cms.png';export const GET=()=>getImage();",
		"function getImage$2(){return '/cms.png'};export const GET=()=>getImage$2();",
		"export function GET(getImage){return getImage();}",
	])(
		"does not activate runtime image routes for a local endpoint helper: %s",
		async (source) => {
			const directory = await mkdtemp(
				join(tmpdir(), "local-image-helper-"),
			);
			try {
				const root = pathToFileURL(directory + "/");
				const outDir = new URL("dist/", root);
				const server = new URL("function/", outDir);
				const client = new URL("client/", outDir);
				await mkdir(server, { recursive: true });
				await mkdir(client, { recursive: true });
				const entrypoint = "src/pages/api/demo.ts";
				await writeFile(new URL("endpoint.js", server), source);
				await writeFile(
					new URL("index.js", server),
					`const pageMap=new Map([['${entrypoint}',()=>import('./endpoint.js')]]);const manifest={pageMap};export function handler(){}`,
				);
				const route = {
					...onDemandRoute,
					type: "endpoint" as const,
					params: [],
					pattern: "/api/demo",
					patternRegex: /^\/api\/demo$/,
					entrypoint,
				};
				const imageRoute = {
					...route,
					origin: "internal" as const,
					pattern: "/_image",
					patternRegex: /^\/_image$/,
					entrypoint: "astro:assets",
				};
				const hooks = yandexCloud({
					target: "object-storage-functions",
					apiGateway: false,
				}).hooks;
				await hooks["astro:routes:resolved"]?.({
					routes: [route, imageRoute],
					logger: {} as never,
				});
				await hooks["astro:config:done"]?.({
					config: {
						root,
						outDir,
						base: "/",
						trailingSlash: "ignore",
						build: { server, client },
						image: { endpoint: { route: "/_image" } },
					},
					injectTypes() {},
					setAdapter() {},
				} as never);
				await hooks["astro:build:done"]?.({
					pages: [],
					assets: new Map(),
					logger: { info() {}, warn() {} },
				} as never);
				const manifest = JSON.parse(
					await readFile(
						new URL("yandex-cloud.json", outDir),
						"utf8",
					),
				) as {
					routes: { onDemand: Array<{ pattern: string }> };
				};
				expect(
					manifest.routes.onDemand.map((x) => x.pattern),
				).toEqual(["/api/demo"]);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("defaults includeLocal to false and requires install for explicit local delivery", async () => {
		const decode = Schema.decodeUnknownSync(
			Options.ObjectStorageCloudFunctionsTargetOptions,
		);
		expect(
			decode({
				target: "object-storage-functions",
				dependencyStrategy: "install",
			}).includeLocal,
		).toBe(false);
		expect(
			decode({
				target: "object-storage-functions",
				dependencyStrategy: "install",
				includeLocal: true,
			}).includeLocal,
		).toBe(true);
		await expect(
			adapterDescription({
				target: "object-storage-functions",
				dependencyStrategy: "install",
				includeLocal: true,
			}),
		).resolves.toBeDefined();
		for (const options of [
			{ target: "object-storage-functions", includeLocal: true },
			{ target: "object-storage", includeLocal: true },
			{
				target: "object-storage-functions",
				dependencyStrategy: "install",
				includeLocal: "yes",
			},
		])
			expect(() => yandexCloud(options as never)).toThrow();
	});

	it.each([
		{ kind: "middleware-inline", active: true },
		{ kind: "middleware-alias", active: true },
		{ kind: "middleware-static", active: false },
		{ kind: "actions-inline", active: true },
		{ kind: "actions-alias", active: true },
		{ kind: "actions-static", active: false },
		{ kind: "registered-only", active: false },
		{ kind: "local-call", active: true },
		{ kind: "local-call-renamed", active: true },
		{ kind: "local-unused", active: false },
		{ kind: "local-unrelated", active: false },
	])(
		"discovers runtime image calls for $kind without activating unrelated endpoints",
		async ({ kind, active }) => {
			const directory = await mkdtemp(
				join(tmpdir(), "adapter-image-roots-"),
			);
			try {
				const root = pathToFileURL(directory + "/");
				const outDir = new URL("dist/", root);
				const server = new URL("function/", outDir);
				const client = new URL("client/", outDir);
				await mkdir(server, { recursive: true });
				await mkdir(client, { recursive: true });
				const middleware = kind.startsWith("middleware-");
				const actions = kind.startsWith("actions-");
				const local = kind.startsWith("local-");
				const localName =
					kind === "local-call-renamed" ? "z" : "getImage";
				const calls =
					kind === "local-call" || kind === "local-call-renamed"
						? `export function renderHero(){return ${localName}({});}`
						: kind === "local-unrelated"
							? "function getImage$2(){return {}}; getImage$2();"
							: "";
				const assets = `const config={endpoint:{route:'/_image'},service:{entrypoint:'astro/assets/services/sharp'}};function image(options){return service.getURL(options,config)};const ${localName}=options=>image(options);export {${localName} as getImage};${calls}`;
				await writeFile(new URL("assets.js", server), assets);
				await writeFile(
					new URL("page.js", server),
					"export const page=true;",
				);
				await writeFile(
					new URL("middleware.js", server),
					middleware
						? "import {getImage as image} from './assets.js';export function onRequest(){return image({})}"
						: "export const onRequest=true;",
				);
				await writeFile(
					new URL("actions.js", server),
					actions
						? "import {getImage as image} from './assets.js';export function action(){return image({})}"
						: "export const server={};",
				);
				const runtimeKey = actions ? "actions" : "middleware";
				const loader = kind.endsWith("-alias")
					? `const m=()=>import('./${runtimeKey}.js');`
					: "";
				await writeFile(
					new URL("index.js", server),
					`${loader}const pageMap=new Map([['${onDemandRoute.entrypoint}',()=>import('./${local ? "assets" : "page"}.js')],['registered-only',()=>import('./assets.js')]]);const manifest={pageMap,${runtimeKey}:${kind.endsWith("-alias") ? "m" : `()=>import('./${runtimeKey}.js')`}};export function handler(){}`,
				);

				const imageRoute = {
					...onDemandRoute,
					type: "endpoint" as const,
					origin: "internal" as const,
					params: [],
					pattern: "/_image",
					patternRegex: /^\/_image$/,
					entrypoint: "astro:assets",
				};
				const route = {
					...onDemandRoute,
					isPrerendered: kind.endsWith("-static"),
				};
				const hooks = yandexCloud({
					target: "object-storage-functions",
					apiGateway: true,
				}).hooks;
				await hooks["astro:routes:resolved"]?.({
					routes: [route, imageRoute],
					logger: {} as never,
				});
				await hooks["astro:config:done"]?.({
					config: {
						root,
						outDir,
						base: "/",
						trailingSlash: "ignore",
						build: { server, client },
						image: { endpoint: { route: "/_image" } },
					},
					injectTypes() {},
					setAdapter() {},
				} as never);
				await hooks["astro:build:done"]?.({
					pages: [],
					assets: new Map(),
					logger: { info() {}, warn() {} },
				} as never);
				const manifest = JSON.parse(
					await readFile(
						new URL("yandex-cloud.json", outDir),
						"utf8",
					),
				) as {
					routes: { onDemand: Array<{ pattern: string }> };
				};
				expect(
					manifest.routes.onDemand.some(
						(route) => route.pattern === "/_image",
					),
				).toBe(active);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each(
		["property", "export", "default"].flatMap((kind) =>
			[false, true].map((active) => ({ kind, active })),
		),
	)(
		"uses renamed server-island map evidence through the public hook: %j",
		async ({ kind, active }) => {
			const directory = await mkdtemp(
				join(tmpdir(), "adapter-island-binding-"),
			);
			try {
				const root = pathToFileURL(directory + "/");
				const outDir = new URL("dist/", root);
				const server = new URL("function/", outDir);
				const client = new URL("client/", outDir);
				await mkdir(new URL("chunks/", server), {
					recursive: true,
				});
				await mkdir(client, { recursive: true });
				const entries = active
					? "[['card', () => import('./card.js')]]"
					: "[]";
				const map = `const a = new Map(${entries});`;
				const file =
					kind === "property"
						? "index.js"
						: "chunks/server-island-manifest-minified.js";
				await writeFile(
					new URL(file, server),
					kind === "property"
						? `${map} const manifest = {serverIslandMap: a}; export function handler(){}`
						: kind === "export"
							? `${map} export {a as default};`
							: `export default new Map(${entries});`,
				);
				if (kind !== "property")
					await writeFile(
						new URL("index.js", server),
						"export function handler(){};",
					);
				await writeFile(
					new URL(
						kind === "property" ? "card.js" : "chunks/card.js",
						server,
					),
					"export const card = true;",
				);
				const island = {
					...onDemandRoute,
					type: "endpoint" as const,
					origin: "internal" as const,
					params: ["name"],
					pattern: "/_server-islands/[name]",
					patternRegex: /^\/_server-islands\/([^/]+?)$/,
					entrypoint: "astro:server-islands",
				};
				const hooks = yandexCloud({
					target: "object-storage-functions",
					apiGateway: true,
				}).hooks;
				await hooks["astro:routes:resolved"]?.({
					routes: [onDemandRoute, island],
					logger: {} as never,
				});
				await hooks["astro:config:done"]?.({
					config: {
						root,
						outDir,
						base: "/",
						trailingSlash: "ignore",
						build: { server, client },
						image: { endpoint: { route: "/_image" } },
					},
					injectTypes() {},
					setAdapter() {},
				} as never);
				await hooks["astro:build:done"]?.({
					pages: [],
					assets: new Map(),
					logger: { info() {}, warn() {} },
				} as never);
				const manifest = JSON.parse(
					await readFile(
						new URL("yandex-cloud.json", outDir),
						"utf8",
					),
				) as {
					routes: { onDemand: Array<{ pattern: string }> };
				};
				expect(
					manifest.routes.onDemand.some(
						(route) => route.pattern === island.pattern,
					),
				).toBe(active);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each([
		"chunks/server-island-manifest#part.js",
		"chunks/ordinary?part.js",
		"client%20part.html",
	])(
		"reads raw emitted filename %s through the public build hook",
		async (name) => {
			const directory = await mkdtemp(
				join(tmpdir(), "adapter-raw-emitted-"),
			);
			try {
				const root = pathToFileURL(directory + "/");
				const outDir = new URL("dist/", root);
				const server = new URL("function/", outDir);
				const client = new URL("client/", outDir);
				await mkdir(new URL("chunks/", server), {
					recursive: true,
				});
				await mkdir(client, { recursive: true });
				await writeFile(
					new URL("index.js", server),
					"export function handler() {};",
				);
				await writeFile(
					pathToFileURL(
						join(
							directory,
							name.endsWith(".html")
								? "dist/client"
								: "dist/function",
							name,
						),
					),
					name.endsWith(".html")
						? "<p>static</p>"
						: "export const value = 42;",
				);
				const hooks = yandexCloud({
					target: "object-storage-functions",
					apiGateway: true,
				}).hooks;
				await hooks["astro:routes:resolved"]?.({
					routes: [onDemandRoute],
					logger: {} as never,
				});
				await hooks["astro:config:done"]?.({
					config: {
						root,
						outDir,
						base: "/",
						trailingSlash: "ignore",
						build: { server, client },
						image: { endpoint: { route: "/_image" } },
					},
					injectTypes() {},
					setAdapter() {},
				} as never);
				await hooks["astro:build:done"]?.({
					pages: [],
					assets: new Map(),
					logger: { info() {}, warn() {} },
				} as never);
				const manifest = JSON.parse(
					await readFile(
						new URL("yandex-cloud.json", outDir),
						"utf8",
					),
				) as {
					routes: { onDemand: Array<{ pattern: string }> };
				};
				expect(manifest.routes.onDemand).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ pattern: "/api/[id]" }),
					]),
				);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ route: onDemandRoute, html: "" },
		{
			route: {
				...onDemandRoute,
				origin: "internal" as const,
				pattern: "/_actions/[...path]",
			},
			html: "",
		},
		{
			route: {
				...onDemandRoute,
				origin: "internal" as const,
				pattern: "/_server-islands/[name]",
			},
			html: '<div data-island="/_server-islands/card"></div>',
		},
		{
			route: {
				...onDemandRoute,
				origin: "internal" as const,
				pattern: "/_image",
			},
			html: '<img src="/_image?href=card.png">',
		},
	])(
		"rejects a missing runtime entrypoint for $route.pattern through the public build hook before removing output",
		async ({ route, html }) => {
			const directory = await mkdtemp(
				join(tmpdir(), "adapter-missing-entry-"),
			);
			try {
				const root = pathToFileURL(directory + "/");
				const outDir = new URL("dist/", root);
				const server = new URL("function/", outDir);
				const client = new URL("client/", outDir);
				await mkdir(server, { recursive: true });
				await mkdir(client, { recursive: true });
				const marker = new URL("marker.txt", server);
				await writeFile(marker, "preserve");
				if (html)
					await writeFile(new URL("index.html", client), html);
				const hooks = yandexCloud({
					target: "object-storage-functions",
					apiGateway: true,
				}).hooks;
				await hooks["astro:routes:resolved"]?.({
					routes: [route],
					logger: {} as never,
				});
				await hooks["astro:config:done"]?.({
					config: {
						root,
						outDir,
						base: "/",
						trailingSlash: "ignore",
						build: { server, client },
						image: { endpoint: { route: "/_image" } },
					},
					injectTypes: () => {},
					setAdapter: () => {},
				} as never);
				await expect(
					hooks["astro:build:done"]?.({
						pages: [],
						assets: new Map(),
						logger: { info() {}, warn() {} },
					} as never),
				).rejects.toMatchObject({
					cause: {
						_tag: "InvalidArtifact",
						message:
							"Astro did not emit the expected Function Artifact entrypoint index.js.",
					},
				});
				await expect(access(marker)).resolves.toBeUndefined();
				await expect(
					access(new URL("yandex-cloud.json", outDir)),
				).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("rejects conflicting SSR component identities through the public hook", async () => {
		const hook = yandexCloud().hooks["astro:build:ssr"]!;
		await expect(
			hook({
				manifest: {
					routes: [
						{
							routeData: {
								route: "/injected",
								component: "package/first",
							},
						},
						{
							routeData: {
								route: "/injected",
								component: "package/second",
							},
						},
					],
				},
			} as never),
		).rejects.toMatchObject({
			hook: "astro:build:ssr",
			cause: {
				message:
					"Astro emitted conflicting route module identities for /injected.",
			},
		});
	});

	it("accepts repeated SSR records with the same component identity", async () => {
		const hook = yandexCloud().hooks["astro:build:ssr"]!;
		await expect(
			hook({
				manifest: {
					routes: [
						{
							routeData: {
								route: "/injected",
								component: "package/entry",
							},
						},
						{
							routeData: {
								route: "/injected",
								component: "package/entry",
							},
						},
					],
				},
			} as never),
		).resolves.toBeUndefined();
	});

	it("isolates SSR identities and clears them before a build without SSR", async () => {
		const observed: ReadonlyMap<string, string>[] = [];
		const strategy = TargetBuild.of({
			target: Targets.ObjectStorageTarget,
			astroBuildConfig: () =>
				Effect.succeed({
					build: {
						client: new URL("file:///tmp/client/"),
						server: new URL("file:///tmp/server/"),
						serverEntry: "index.js",
					},
				}),
			astroAdapter: () =>
				Effect.succeed({
					name: "test",
					serverEntrypoint: "test",
					supportedAstroFeatures: {},
				}),
			serverViteConfig: () => Effect.succeed({}),
			generateArtifacts: (build) => {
				observed.push(build.routeComponents);
				// Stop at the collaborator seam, before filesystem reporting.
				return Effect.fail(
					new Errors.InvalidManifest({ message: "observed" }),
				);
			},
		});
		const makeHooks = () =>
			Effect.runSync(
				Hooks.pipe(
					Effect.provide(
						Hooks.Default.pipe(
							Layer.provide(
								Layer.succeed(TargetBuild, strategy),
							),
							Layer.provide(
								Layer.succeed(
									Options.Tag,
									Schema.decodeUnknownSync(Options.Schema)({}),
								),
							),
						),
					),
				),
			);
		const first = makeHooks();
		const second = makeHooks();
		const finish = async (hooks: Hooks) => {
			await Effect.runPromise(
				hooks.configDone({
					config: {},
					injectTypes: () => {},
					setAdapter: () => {},
				} as never),
			);
			await Effect.runPromise(
				hooks
					.buildDone({
						pages: [],
						assets: new Map(),
						logger: {},
					} as never)
					.pipe(Effect.ignore),
			);
		};
		await Effect.runPromise(
			first.buildSsr({
				manifest: {
					routes: [
						{
							routeData: {
								route: "/injected",
								component: "package/entry",
							},
						},
					],
				},
			} as never),
		);
		await finish(first);
		await finish(second);
		await Effect.runPromise(
			first.configSetup({
				config: {},
				updateConfig: () => {},
			} as never),
		);
		await finish(first);
		expect(
			observed.map((components) => [...components]),
		).toEqual([[["/injected", "package/entry"]], [], []]);
	});

	it("defaults to object-storage", () => {
		expect(yandexCloud().name).toBe(
			"@astro-yandex-cloud/adapter",
		);
	});

	it.each([
		{ recursive404: true },
		{
			target: "object-storage",
			apiGateway: false,
			recursive404: true,
		},
		{ target: "object-storage-functions", recursive404: true },
		{
			target: "object-storage-functions",
			apiGateway: false,
			recursive404: true,
		},
	])(
		"rejects recursive 404 without Gateway for current Targets: %j",
		(options) => {
			expect(optionsError(options)).toHaveProperty(
				"cause._tag",
				"ParseError",
			);
		},
	);

	it("rejects unknown targets", () => {
		expect.assertions(2);
		try {
			yandexCloud({ target: "vm" as never });
		} catch (error) {
			expect(error).toHaveProperty(
				"hook",
				"integration:options",
			);
			expect(error).toHaveProperty(
				"cause.message",
				expect.stringMatching(/\["target"\][\s\S]*actual "vm"/),
			);
		}
	});

	it("rejects unknown dependency strategies", () => {
		expect.assertions(2);
		try {
			yandexCloud({
				target: "object-storage-functions",
				dependencyStrategy: "copy" as never,
			});
		} catch (error) {
			expect(error).toHaveProperty(
				"hook",
				"integration:options",
			);
			expect(error).toHaveProperty(
				"cause.message",
				expect.stringMatching(
					/\["dependencyStrategy"\][\s\S]*actual "copy"/,
				),
			);
		}
	});

	it("rejects install dependencies for Object Storage", () => {
		expect(
			optionsError({
				target: "object-storage",
				dependencyStrategy: "install",
			}),
		).toHaveProperty("cause._tag", "ParseError");
	});

	it.each([
		{ dependencyStrategy: "bundle" },
		{ target: "object-storage", dependencyStrategy: "bundle" },
		{ dependencyStrategy: "install" },
		{ functions: "shared" },
		{ target: "object-storage", functions: "shared" },
		{ functions: "separate" },
		{ target: "object-storage", functions: "separate" },
		{
			target: "object-storage-functions",
			functions: "separate",
		},
		{ directOrigin: "https://static.example" },
		{
			target: "object-storage",
			directOrigin: "https://static.example",
		},
		{
			target: "object-storage-functions",
			apiGateway: true,
			directOrigin: "https://static.example",
		},
	])(
		"rejects incompatible options while decoding: %j",
		(options) => {
			expect(optionsError(options)).toHaveProperty(
				"cause._tag",
				"ParseError",
			);
		},
	);

	it.each([
		{ target: "object-storage", function: "shared" },
		{ target: "object-storage-functions", function: "shared" },
	])("rejects unexpected Target options: %j", (options) => {
		expect(optionsError(options)).toHaveProperty(
			"cause._tag",
			"ParseError",
		);
	});

	it.each([
		"not-an-origin",
		"ftp://static.example",
		"https://user:password@static.example",
		"https://static.example/path",
		"https://static.example?query=value",
		"https://static.example#fragment",
	])(
		"rejects invalid direct origins while decoding options: %s",
		(directOrigin) => {
			expect(
				optionsError({
					target: "object-storage-functions",
					directOrigin,
				}),
			).toHaveProperty("cause._tag", "ParseError");
		},
	);

	it.each([
		{
			target: "object-storage-functions",
			dependencyStrategy: "bundle",
			functions: "shared",
		},
		{ apiGateway: true, recursive404: true },
		{
			target: "object-storage-functions",
			apiGateway: true,
			recursive404: true,
			dependencyStrategy: "install",
			functions: "shared",
		},
		{
			target: "object-storage-functions",
			apiGateway: false,
			recursive404: false,
			directOrigin: "http://localhost:8080",
		},
	] satisfies EncodedOptions[])(
		"accepts compatible options: %j",
		(options) => {
			expect(() => yandexCloud(options)).not.toThrow();
		},
	);

	it("embeds the normalized direct origin in the Function runtime config", async () => {
		const hook = yandexCloud({
			target: "object-storage-functions",
			directOrigin: "https://STATIC.EXAMPLE:443/",
		}).hooks["astro:config:setup"];
		let runtimeSource: unknown;

		await hook?.({
			config: {
				vite: {},
				outDir: new URL("file:///tmp/adapter-options/"),
			},
			updateConfig: (patch: {
				vite: { plugins: [{ load: (id: string) => unknown }] };
			}) => {
				runtimeSource = patch.vite.plugins[0].load(
					"\0virtual:yandex-cloud-runtime-config",
				);
			},
		} as never);

		expect(runtimeSource).toContain(
			'export const directOrigin = "https://static.example";',
		);
	});

	it("reports UnsupportedTargetRouteError through the configuration hook", async () => {
		const hooks = yandexCloud().hooks;
		await hooks["astro:routes:resolved"]?.({
			routes: [onDemandRoute],
			logger: {} as never,
		});
		await expect(
			hooks["astro:config:done"]?.({
				config: {},
				injectTypes: () => {},
				setAdapter: () => {},
			} as never),
		).rejects.toMatchObject({
			hook: "astro:config:done",
			cause: {
				_tag: "UnsupportedTargetRouteError",
				target: Targets.ObjectStorageTarget,
				routePatterns: ["/api/[id]"],
				message: expect.stringMatching(
					/cannot serve on-demand routes.*\/api\/\[id\]/,
				) as unknown,
			},
		});
	});

	it("reports all incompatible routes without including prerendered or dormant internal routes", async () => {
		const endpoint: IntegrationResolvedRoute = {
			...onDemandRoute,
			type: "endpoint",
			params: [],
			pattern: "/health",
			patternRegex: /^\/health$/,
			entrypoint: "src/pages/health.ts",
			generate: () => "/health",
		};
		const hooks = yandexCloud().hooks;
		await hooks["astro:routes:resolved"]?.({
			routes: [
				onDemandRoute,
				endpoint,
				{ ...endpoint, isPrerendered: true, pattern: "/static" },
				{
					...endpoint,
					origin: "internal" as const,
					pattern: "/_image",
				},
			],
			logger: {} as never,
		});
		await expect(
			hooks["astro:config:done"]?.({
				config: {},
				injectTypes: () => {},
				setAdapter: () => {},
			} as never),
		).rejects.toMatchObject({
			cause: {
				_tag: "UnsupportedTargetRouteError",
				target: Targets.ObjectStorageTarget,
				routePatterns: ["/api/[id]", "/health"],
			},
		});
	});

	it("preserves an unexpected Astro callback error without classifying it as route incompatibility", async () => {
		const cause = new Error("setAdapter failed");
		const hook = yandexCloud().hooks["astro:config:done"];
		let failure: unknown;
		try {
			await hook?.({
				config: {},
				injectTypes: () => {},
				setAdapter: () => {
					throw cause;
				},
			} as never);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			_tag: "IntegrationHookError",
			hook: "astro:config:done",
		});
		expect((failure as Error).cause).toBe(cause);
	});

	it("keeps route state and Target selection isolated between integrations", async () => {
		const storage = yandexCloud().hooks;
		const functions = yandexCloud({
			target: "object-storage-functions",
			dependencyStrategy: "install",
		}).hooks;
		await storage["astro:routes:resolved"]?.({
			routes: [onDemandRoute],
			logger: {} as never,
		});
		await functions["astro:routes:resolved"]?.({
			routes: [],
			logger: {} as never,
		});
		let description: unknown;
		await functions["astro:config:done"]?.({
			config: {},
			injectTypes: () => {},
			setAdapter: (adapter: unknown) => {
				description = adapter;
			},
		} as never);
		expect(description).toMatchObject({
			adapterFeatures: { buildOutput: "server" },
			supportedAstroFeatures: {
				sharpImageService: { support: "limited" },
			},
		});
		await expect(
			storage["astro:config:done"]?.({
				config: {},
				injectTypes: () => {},
				setAdapter: () => {},
			} as never),
		).rejects.toHaveProperty(
			"cause.message",
			expect.stringContaining("cannot serve on-demand routes"),
		);
	});

	it("clears routes when a new build starts on the same integration", async () => {
		const hooks = yandexCloud().hooks;
		await hooks["astro:routes:resolved"]?.({
			routes: [onDemandRoute],
			logger: {} as never,
		});
		await hooks["astro:config:setup"]?.({
			config: {
				vite: {},
				outDir: new URL("file:///tmp/adapter-state/"),
			},
			updateConfig: () => {},
		} as never);
		let description: unknown;
		await hooks["astro:config:done"]?.({
			config: {},
			injectTypes: () => {},
			setAdapter: (adapter: unknown) => {
				description = adapter;
			},
		} as never);
		expect(description).toMatchObject({
			adapterFeatures: { buildOutput: "static" },
		});
	});

	it("rejects build completion after reset until configuration is recorded again", async () => {
		const hooks = yandexCloud().hooks;
		await hooks["astro:config:done"]?.({
			config: {},
			injectTypes: () => {},
			setAdapter: () => {},
		} as never);
		await hooks["astro:config:setup"]?.({
			config: {
				vite: {},
				outDir: new URL("file:///tmp/adapter-state/"),
			},
			updateConfig: () => {},
		} as never);
		await expect(
			hooks["astro:build:done"]?.({
				pages: [],
				assets: new Map(),
				logger: {},
			} as never),
		).rejects.toHaveProperty(
			"cause.message",
			expect.stringContaining(
				"Astro build completed before adapter configuration was resolved.",
			),
		);
	});

	it("declares only the features supported by the Object Storage Target", async () => {
		expect(await adapterDescription()).toMatchObject({
			adapterFeatures: {
				buildOutput: "static",
				middlewareMode: "classic",
				preserveBuildClientDir: true,
				preserveBuildServerDir: true,
			},
			supportedAstroFeatures: {
				staticOutput: "stable",
				hybridOutput: "unsupported",
				serverOutput: "unsupported",
				sharpImageService: "stable",
				envGetSecret: "stable",
				i18nDomains: "unsupported",
			},
		});
	});

	it("defaults Function Artifacts to bundle and rejects native Sharp", async () => {
		expect(
			await adapterDescription({
				target: "object-storage-functions",
			}),
		).toMatchObject({
			supportedAstroFeatures: {
				staticOutput: "stable",
				hybridOutput: "stable",
				serverOutput: "stable",
				sharpImageService: {
					support: "unsupported",
					message:
						'Sharp is a native runtime dependency and cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install".',
				},
				envGetSecret: "stable",
				i18nDomains: "unsupported",
			},
		});
	});

	it("exposes the artifact-wide install strategy for its follow-up implementation", async () => {
		expect(
			await adapterDescription({
				target: "object-storage-functions",
				dependencyStrategy: "install",
			}),
		).toMatchObject({
			supportedAstroFeatures: {
				sharpImageService: {
					support: "limited",
					message:
						"Sharp and runtime image transformation are experimental in Yandex Cloud Functions.",
				},
			},
		});
	});

	it("rejects blanket noExternal before an install build merges Vite config", async () => {
		const hook = yandexCloud({
			target: "object-storage-functions",
			dependencyStrategy: "install",
		}).hooks["astro:config:setup"];
		await expect(
			hook?.({
				config: { vite: { ssr: { noExternal: true } } },
				updateConfig: () => {},
			} as never),
		).rejects.toHaveProperty(
			"cause.message",
			expect.stringContaining("vite.ssr.noExternal: true"),
		);
	});

	it("keeps runtime package imports external for the install strategy", async () => {
		const hook = yandexCloud({
			target: "object-storage-functions",
			dependencyStrategy: "install",
		}).hooks["astro:build:setup"];
		interface UpdatedServerBuild {
			ssr?: { external?: unknown; noExternal?: unknown };
			build?: { rolldownOptions?: { output?: unknown } };
		}
		let updatedConfig: UpdatedServerBuild | undefined;

		await hook?.({
			target: "server",
			vite: {
				ssr: {
					external: ["nanoid"],
					noExternal: ["bundled-package"],
				},
				build: {
					rolldownOptions: {
						output: [{ entryFileNames: "first.js" }],
					},
				},
			},
			updateConfig: (config: unknown) => {
				updatedConfig = config as UpdatedServerBuild;
			},
		} as never);

		expect(updatedConfig?.ssr?.external).toEqual(["nanoid"]);
		expect(updatedConfig?.ssr?.noExternal).toEqual([
			"bundled-package",
		]);
		expect(
			updatedConfig?.build?.rolldownOptions?.output,
		).toEqual([
			{
				entryFileNames: "first.js",
				chunkFileNames: "chunks/[name]-[hash].js",
			},
		]);
	});

	it("preserves every configured Rolldown output for a Runtime Build", async () => {
		const hook = yandexCloud({
			target: "object-storage-functions",
		}).hooks["astro:build:setup"];
		let updatedConfig: unknown;

		await hook?.({
			target: "server",
			vite: {
				build: {
					rolldownOptions: {
						output: [
							{ entryFileNames: "first.js" },
							{ entryFileNames: "second.js" },
						],
					},
				},
			},
			updateConfig: (config: unknown) => {
				updatedConfig = config;
			},
		} as never);

		expect(updatedConfig).toMatchObject({
			build: {
				rolldownOptions: {
					output: [
						{
							entryFileNames: "first.js",
							chunkFileNames: "chunks/[name]-[hash].js",
						},
						{
							entryFileNames: "second.js",
							chunkFileNames: "chunks/[name]-[hash].js",
						},
					],
				},
			},
		});
	});
});
