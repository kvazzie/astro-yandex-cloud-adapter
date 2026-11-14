import { readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build, type AstroInlineConfig } from "astro";
import { beforeAll, describe, expect, it } from "vitest";

import yandexCloud from "./helpers/built-adapter.ts";
import type { EncodedDeploymentManifestV1 } from "../../packages/adapter/src/mandatory/DeploymentManifest/Schema.ts";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const root = join(fixtures, "prerendered-overlap");

/** Builds a public adapter fixture and reads its Manifest and Gateway artifacts. */
async function buildFixture(
	config: AstroInlineConfig = {},
	fixture = "prerendered-overlap",
) {
	const root = join(fixtures, fixture);
	await build({
		root: `${root}/`,
		configFile: false,
		logLevel: "silent",
		trailingSlash: "always",
		adapter: yandexCloud({
			apiGateway: true,
			recursive404: true,
		}),
		...config,
	});
	const manifest = JSON.parse(
		await readFile(join(root, "dist/yandex-cloud.json"), "utf8"),
	) as EncodedDeploymentManifestV1;
	const template = JSON.parse(
		await readFile(
			join(root, "dist/yandex-api-gateway.json"),
			"utf8",
		),
	) as { paths: Record<string, unknown> };
	return { manifest, template };
}

describe.sequential("prerendered page emitter evidence", () => {
	beforeAll(async () => {
		for (const fixture of [
			"prerendered-overlap",
			"prerendered-conflict",
			"prerendered-file-collision",
		]) {
			await symlink(
				join(fixtures, "static/node_modules"),
				join(fixtures, fixture, "node_modules"),
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
		}
	});

	it("keeps a directory page separate from an HTML endpoint when URLs have no trailing slash", async () => {
		const { manifest, template } = await buildFixture(
			{
				trailingSlash: "never",
				build: { format: "directory" },
			},
			"prerendered-file-collision",
		);
		expect(manifest.routes.prerendered).toEqual([
			{
				kind: "page",
				url: "/about",
				objectKey: "about/index.html",
				artifactId: "client:primary",
			},
			{
				kind: "endpoint",
				url: "/about.html",
				objectKey: "about.html",
				artifactId: "client:primary",
			},
		]);
		expect(template.paths["/about"]).toMatchObject({
			get: {
				"x-yc-apigateway-integration": {
					object: "about/index.html",
				},
			},
		});
		expect(template.paths["/about.html"]).toMatchObject({
			get: {
				"x-yc-apigateway-integration": {
					object: "about.html",
				},
			},
		});
		for (const [file, content] of [
			["about/index.html", "About page"],
			["about.html", "Unrelated HTML endpoint"],
		] as const) {
			expect(
				await readFile(
					join(
						fixtures,
						"prerendered-file-collision/dist/client",
						file,
					),
					"utf8",
				),
			).toContain(content);
		}
	});

	it("completes overlapping named and rest pages with exact Client Artifact and Gateway references", async () => {
		const { manifest, template } = await buildFixture();
		expect(manifest.routes.prerendered).toEqual([
			{
				kind: "page",
				url: "/",
				objectKey: "index.html",
				artifactId: "client:primary",
			},
			{
				kind: "page",
				url: "/blog/a/",
				objectKey: "blog/a/index.html",
				artifactId: "client:primary",
			},
			{
				kind: "page",
				url: "/blog/a/404/",
				objectKey: "blog/a/404/index.html",
				artifactId: "client:primary",
			},
			{
				kind: "page",
				url: "/blog/b/",
				objectKey: "blog/b/index.html",
				artifactId: "client:primary",
			},
			{
				kind: "page",
				url: "/blog/b/404/",
				objectKey: "blog/b/404/index.html",
				artifactId: "client:primary",
			},
			{
				kind: "page",
				url: "/blog/nested/item/",
				objectKey: "blog/nested/item/index.html",
				artifactId: "client:primary",
			},
		]);
		expect(Object.keys(template.paths)).toEqual(
			expect.arrayContaining([
				"/",
				"/blog/a/",
				"/blog/b/",
				"/blog/nested/item/",
			]),
		);
		for (const route of manifest.routes.prerendered) {
			expect(template.paths[route.url]).toMatchObject({
				get: {
					"x-yc-apigateway-integration": {
						type: "object_storage",
						object: route.objectKey,
					},
				},
			});
		}
		for (const [file, content] of [
			["index.html", "Ordinary page"],
			["blog/a/index.html", "Named page"],
			["blog/a/404/index.html", "Named custom 404"],
			["blog/b/index.html", "Rest page"],
			["blog/b/404/index.html", "Rest page"],
			["blog/nested/item/index.html", "Rest page"],
		]) {
			expect(
				await readFile(join(root, "dist/client", file!), "utf8"),
			).toContain(content);
		}
	});

	it.each([
		{
			format: "file",
			base: "/docs",
			trailingSlash: "never",
			url: "/docs/blog/b",
			objectKey: "docs/blog/b.html",
			file: "blog/b.html",
			rootUrl: "/docs",
			rootKey: "docs/index.html",
		},
		{
			format: "directory",
			base: "/docs",
			trailingSlash: "ignore",
			url: "/docs/blog/b/",
			objectKey: "docs/blog/b/index.html",
			file: "blog/b/index.html",
			rootUrl: "/docs/",
			rootKey: "docs/index.html",
		},
		{
			format: "preserve",
			base: "/",
			trailingSlash: "never",
			url: "/blog/b",
			objectKey: "blog/b.html",
			file: "blog/b.html",
			rootUrl: "/",
			rootKey: "index.html",
		},
	] as const)(
		"preserves $format output under $base with trailingSlash $trailingSlash",
		async ({
			format,
			base,
			trailingSlash,
			url,
			objectKey,
			file,
			rootUrl,
			rootKey,
		}) => {
			const { manifest, template } = await buildFixture({
				base,
				trailingSlash,
				build: { format },
			});
			expect(manifest.routes.prerendered).toContainEqual({
				kind: "page",
				url,
				objectKey,
				artifactId: "client:primary",
			});
			expect(template.paths[url]).toMatchObject({
				get: {
					"x-yc-apigateway-integration": {
						type: "object_storage",
						object: objectKey,
					},
				},
			});
			expect(
				await readFile(join(root, "dist/client", file), "utf8"),
			).toContain("Rest page");
			expect(manifest.routes.prerendered).toContainEqual({
				kind: "page",
				url: rootUrl,
				objectKey: rootKey,
				artifactId: "client:primary",
			});
			expect(
				manifest.routes.notFound.map(({ scope }) => scope),
			).toEqual([base === "/" ? "/blog/a" : "/docs/blog/a"]);
		},
	);

	it.each(["warn", "ignore"] as const)(
		"preserves Astro's duplicate-path winner with conflict behavior %s",
		async (prerenderConflictBehavior) => {
			const { manifest, template } = await buildFixture(
				{ prerenderConflictBehavior },
				"prerendered-conflict",
			);
			expect(manifest.routes.prerendered).toEqual([
				{
					kind: "page",
					url: "/blog/a/",
					objectKey: "blog/a/index.html",
					artifactId: "client:primary",
				},
			]);
			expect(Object.keys(template.paths)).toEqual(["/blog/a/"]);
			expect(template.paths["/blog/a/"]).toMatchObject({
				get: {
					"x-yc-apigateway-integration": {
						type: "object_storage",
						object: "blog/a/index.html",
					},
				},
			});
			const html = await readFile(
				join(
					fixtures,
					"prerendered-conflict/dist/client/blog/a/index.html",
				),
				"utf8",
			);
			expect(html).toContain("Named conflict winner");
			expect(html).not.toContain("Rest conflict loser");
		},
	);

	it("preserves Astro's error when duplicate generated paths are rejected", async () => {
		let completed = false;
		await expect(
			buildFixture(
				{
					prerenderConflictBehavior: "error",
					integrations: [
						{
							name: "observe-completed-build",
							hooks: {
								"astro:build:done": () => {
									completed = true;
								},
							},
						},
					],
				},
				"prerendered-conflict",
			),
		).rejects.toHaveProperty("name", "PrerenderRouteConflict");
		expect(completed).toBe(false);
		await expect(
			readFile(
				join(
					fixtures,
					"prerendered-conflict/dist/yandex-cloud.json",
				),
			),
		).rejects.toHaveProperty("code", "ENOENT");
	});

	it("fails completion when an ordinary page has no emitter evidence", async () => {
		const adapter = yandexCloud({ apiGateway: true });
		const buildDone = adapter.hooks["astro:build:done"]!;
		adapter.hooks["astro:build:done"] = (options) => {
			options.assets.delete("/");
			return buildDone(options);
		};
		await expect(
			buildFixture({ adapter }),
		).rejects.toHaveProperty(
			"cause.message",
			"Missing Astro page emitter evidence for / (Client Artifact file index.html) in completed-build assets.",
		);
		await expect(
			readFile(join(root, "dist/yandex-cloud.json")),
		).rejects.toHaveProperty("code", "ENOENT");
	});

	it("fails completion when two page routes claim the same emitted file", async () => {
		const adapter = yandexCloud({ apiGateway: true });
		const buildDone = adapter.hooks["astro:build:done"]!;
		adapter.hooks["astro:build:done"] = (options) => {
			const assets = new Map(options.assets);
			assets.set("/blog/[...path]", [
				...assets.get("/blog/[...path]")!,
				...assets.get("/")!,
			]);
			return buildDone({ ...options, assets });
		};
		await expect(
			buildFixture({ adapter }),
		).rejects.toHaveProperty(
			"cause.message",
			"Conflicting Astro page emitter evidence for / (Client Artifact file index.html) in completed-build assets: /blog/[...path], /.",
		);
		await expect(
			readFile(join(root, "dist/yandex-cloud.json")),
		).rejects.toHaveProperty("code", "ENOENT");
	});

	it("does not invent a custom 404 Scope for a rest page matching a higher-priority named 404 pattern", async () => {
		const { manifest } = await buildFixture();
		expect(manifest.routes.notFound).toEqual([
			{
				scope: "/blog/a",
				url: "/blog/a/404/",
				objectKey: "blog/a/404/index.html",
				artifactId: "client:primary",
			},
		]);
	});
});
