import { describe, expect, it } from "vitest";
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
				{ ...endpoint, origin: "internal", pattern: "/_image" },
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
