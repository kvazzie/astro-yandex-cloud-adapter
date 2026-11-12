import { execFile } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { PreviewServer } from "astro";
import type * as Astro from "astro";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from "vitest";
import { parse } from "yaml";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const runCommand = promisify(execFile);
let root: string;
let astro: typeof Astro;
let applicationCount = 0;

async function expectBrowserAsset(
	page: string,
	origin: string,
	prefix: string,
) {
	const assetPath = page.match(/src="([^"]+)"/)?.[1];
	expect(assetPath).toMatch(new RegExp(`^${prefix}/_astro/`));
	const asset = await fetch(`${origin}${assetPath}`);
	expect(asset.status).toBe(200);
	expect(asset.headers.get("content-type")).toBe(
		"image/svg+xml",
	);
	expect(await asset.text()).toContain("<svg");
}

async function startPreview(
	fixture: "static" | "static-functions" | "mixed" | "actions",
	target: "object-storage" | "object-storage-functions",
	base = "/",
	configOverrides: Pick<
		Astro.AstroUserConfig,
		"build" | "trailingSlash"
	> = {},
	adapterOptions: {
		apiGateway?: boolean;
		recursive404?: boolean;
	} = {},
): Promise<{
	server: PreviewServer;
	origin: string;
	application: string;
}> {
	const application = join(
		root,
		`application-${applicationCount++}`,
	);
	await cp(
		join(fixtures, fixture, "src"),
		join(application, "src"),
		{
			recursive: true,
		},
	);
	await cp(
		join(fixtures, fixture, "public"),
		join(application, "public"),
		{
			recursive: true,
		},
	);
	await writeFile(
		join(application, "public/preview.mjs"),
		"export const preview = true;\n",
	);
	for (const name of ["hello#world.html", "100%.html"])
		await writeFile(
			join(application, "public", name),
			`<p>${name}</p>`,
		);
	if (adapterOptions.recursive404) {
		await mkdir(join(application, "src/pages/guide"), {
			recursive: true,
		});
		await writeFile(
			join(application, "src/pages/guide/404.astro"),
			"<h1>Guide missing page</h1>",
		);
	}
	if (fixture === "mixed") {
		await cp(
			join(fixtures, "static/src/pages/about.astro"),
			join(application, "src/pages/about.astro"),
		);
	}
	await writeFile(
		join(application, "astro.config.mjs"),
		`import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";
export default defineConfig({
  adapter: yandexCloud({ target: ${JSON.stringify(target)}, apiGateway: ${String(fixture === "mixed" || fixture === "actions")}, ...${JSON.stringify(adapterOptions)} }),
  base: ${JSON.stringify(base)},
  site: "https://fixture.example",
  output: ${JSON.stringify(fixture === "actions" ? "server" : "static")},
  image: { service: passthroughImageService() },
  server: { headers: { "x-preview-header": "configured" } },
  ...${JSON.stringify(configOverrides)},
});
`,
	);
	const config = {
		root: `${application}/`,
		logLevel: "silent" as const,
	};
	await astro.build(config);
	const server = await astro.preview({
		...config,
		server: { host: "127.0.0.1", port: 0 },
	});
	return {
		server,
		origin: `http://127.0.0.1:${server.port}`,
		application,
	};
}

describe.sequential(
	"preview from an installed adapter tarball",
	() => {
		beforeAll(async () => {
			root = await mkdtemp(
				join(tmpdir(), "astro-yandex-preview-"),
			);
			// The suite builds the adapter first; prepack would rebuild it during other tests.
			await runCommand(
				"npm",
				["pack", "--ignore-scripts", "--pack-destination", root],
				{
					cwd: resolve(
						import.meta.dirname,
						"../../packages/adapter",
					),
				},
			);
			const tarball = (await readdir(root)).find((file) =>
				file.endsWith(".tgz"),
			);
			expect(tarball).toBeDefined();
			const astroPackage = JSON.parse(
				await readFile(
					createRequire(import.meta.url).resolve(
						"astro/package.json",
					),
					"utf8",
				),
			) as { version: string };
			const workspace = parse(
				await readFile(
					resolve(
						import.meta.dirname,
						"../../pnpm-workspace.yaml",
					),
					"utf8",
				),
			) as { overrides: { unifont: string } };
			for (const [name, exports] of [
				[
					"hidden-import-only",
					{ ".": { import: "./index.js" } },
				],
				[
					"hidden-subpath-only",
					{ "./feature": { import: "./index.js" } },
				],
			] as const) {
				const directory = join(root, name);
				await mkdir(directory);
				await writeFile(
					join(directory, "package.json"),
					JSON.stringify({
						name,
						version: "1.0.0",
						type: "module",
						exports,
					}),
				);
				await writeFile(
					join(directory, "index.js"),
					`export default ${JSON.stringify(name)};`,
				);
				await runCommand(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						root,
					],
					{ cwd: directory },
				);
			}
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({
					private: true,
					type: "module",
					dependencies: {
						"@astro-yandex-cloud/adapter": `file:./${tarball!}`,
						astro: astroPackage.version,
						nanoid: "3.3.17",
						"react-dom": "19.2.0",
						react: "19.2.0",
						send: "0.19.0",
						debug: "4.4.3",
						"hidden-import-only": `file:${join(root, "hidden-import-only-1.0.0.tgz")}`,
						"hidden-subpath-only": `file:${join(root, "hidden-subpath-only-1.0.0.tgz")}`,
					},
					// Match the workspace's Astro dependency pin on the supported Node minimum.
					overrides: {
						unifont: workspace.overrides.unifont,
					},
				}),
			);
			await runCommand(
				"npm",
				[
					"install",
					"--engine-strict",
					"--no-audit",
					"--no-fund",
				],
				{
					cwd: root,
					timeout: 120_000,
					env: {
						...process.env,
						SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
					},
				},
			);
			const require = createRequire(join(root, "package.json"));
			astro = (await import(
				pathToFileURL(require.resolve("astro")).href
			)) as typeof Astro;
		});

		afterAll(async () => {
			if (root) await rm(root, { recursive: true, force: true });
		});

		it("delivers peers, nested installed versions, createRequire loads and hidden ESM metadata in a clean install Artifact", async () => {
			const application = join(root, "dependency-graph");
			await mkdir(join(application, "src/pages"), {
				recursive: true,
			});
			await writeFile(
				join(application, "src/pages/graph.ts"),
				`
import {renderToStaticMarkup} from 'react-dom/server';
import send from 'send';
import debug from 'debug';
import hidden from 'hidden-import-only';
import feature from 'hidden-subpath-only/feature';
const {createRequire: make} = await import('node:module');
const req = make(import.meta.url);
export const GET = () => new Response(JSON.stringify({
  peer: renderToStaticMarkup('peer-ok'), send: typeof send, debug: typeof debug,
  id: req('nanoid').nanoid(), hidden, feature,
}));
`,
			);
			await writeFile(
				join(application, "astro.config.mjs"),
				`
import yandexCloud from '@astro-yandex-cloud/adapter';
import {passthroughImageService} from 'astro/config';
export default {output:'server', adapter:yandexCloud({target:'object-storage-functions', apiGateway:true, dependencyStrategy:'install'}), image:{service:passthroughImageService()}};
`,
			);
			await astro.build({
				root: `${application}/`,
				logLevel: "silent",
			});
			const isolated = await mkdtemp(
				join(tmpdir(), "yandex-clean-graph-"),
			);
			try {
				await cp(join(application, "dist/function"), isolated, {
					recursive: true,
				});
				const lockBefore = await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				);
				await runCommand(
					"npm",
					[
						"ci",
						"--production",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
					],
					{ cwd: isolated },
				);
				expect(
					await readFile(
						join(isolated, "package-lock.json"),
						"utf8",
					),
				).toBe(lockBefore);
				const require = createRequire(
					join(isolated, "index.js"),
				);
				expect(
					(require("react/package.json") as { version: string })
						.version,
				).toBe("19.2.0");
				expect(
					(require("debug/package.json") as { version: string })
						.version,
				).toBe("4.4.3");
				const sendRequire = createRequire(
					require.resolve("send"),
				);
				expect(
					(
						sendRequire("debug/package.json") as {
							version: string;
						}
					).version,
				).toBe("2.6.9");
				const lock = JSON.parse(lockBefore) as {
					packages: Record<
						string,
						{
							version: string;
							peerDependencies?: Record<string, string>;
						}
					>;
				};
				expect(
					lock.packages["node_modules/send/node_modules/debug"]
						?.version,
				).toBe("2.6.9");
				expect(
					lock.packages["node_modules/react-dom"]
						?.peerDependencies,
				).toEqual({ react: "19.2.0" });
				const { stdout } = await runCommand(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`
import {handler} from './index.js';
const result = await handler({url:'/graph', httpMethod:'GET', headers:{host:'fixture.example'}}, {getPayload:()=>undefined,getRemainingTimeInMillis:()=>30000});
console.log(JSON.stringify(result));
`,
					],
					{ cwd: isolated },
				);
				const result = JSON.parse(stdout.trim()) as {
					statusCode: number;
					body: string;
				};
				expect(result.statusCode).toBe(200);
				const body = JSON.parse(result.body) as { id: string };
				expect(body).toMatchObject({
					peer: "peer-ok",
					send: "function",
					debug: "function",
					hidden: "hidden-import-only",
					feature: "hidden-subpath-only",
				});
				expect(body.id).toMatch(/^[\w-]{21}$/);
			} finally {
				await rm(isolated, { recursive: true, force: true });
			}
		});

		it("preserves the React peer instance shared by a nested widget and React DOM", async () => {
			const widget = join(root, "peer-widget-source");
			await mkdir(widget);
			await writeFile(
				join(widget, "package.json"),
				JSON.stringify({
					name: "peer-widget",
					version: "1.0.0",
					type: "module",
					exports: "./index.js",
					dependencies: {
						react: "19.2.0",
						"react-dom": "19.2.0",
					},
				}),
			);
			await writeFile(
				join(widget, "index.js"),
				`
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
export const render = () => renderToStaticMarkup(React.createElement(function Widget() {
 const [state] = React.useState('shared-peer');
 return React.createElement('p', null, state);
}));
`,
			);
			await runCommand(
				"npm",
				["pack", "--ignore-scripts", "--pack-destination", root],
				{ cwd: widget },
			);
			const application = join(root, "peer-identity");
			await mkdir(join(application, "src/pages"), {
				recursive: true,
			});
			await writeFile(
				join(application, "package.json"),
				JSON.stringify({
					private: true,
					type: "module",
					dependencies: {
						react: "18.3.1",
						"peer-widget": `file:${join(root, "peer-widget-1.0.0.tgz")}`,
					},
				}),
			);
			await runCommand(
				"npm",
				[
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
				{ cwd: application },
			);
			const original = await runCommand(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"import {render} from 'peer-widget'; console.log(render());",
				],
				{ cwd: application },
			);
			expect(original.stdout.trim()).toBe("<p>shared-peer</p>");
			await writeFile(
				join(application, "src/pages/identity.ts"),
				"import React from 'react'; import {render} from 'peer-widget'; export const GET=()=>new Response(React.version+':'+render());",
			);
			await writeFile(
				join(application, "astro.config.mjs"),
				"import adapter from '@astro-yandex-cloud/adapter'; import {passthroughImageService} from 'astro/config'; export default {output:'server',image:{service:passthroughImageService()},adapter:adapter({target:'object-storage-functions',apiGateway:true,dependencyStrategy:'install'})};",
			);
			await astro.build({
				root: `${application}/`,
				logLevel: "silent",
			});
			const isolated = await mkdtemp(
				join(tmpdir(), "yandex-peer-identity-"),
			);
			try {
				await cp(join(application, "dist/function"), isolated, {
					recursive: true,
				});
				const before = await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				);
				await runCommand(
					"npm",
					[
						"ci",
						"--production",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
					],
					{ cwd: isolated },
				);
				expect(
					await readFile(
						join(isolated, "package-lock.json"),
						"utf8",
					),
				).toBe(before);
				const { stdout } = await runCommand(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`
import {handler} from './index.js';
const result=await handler({url:'/identity',httpMethod:'GET',headers:{host:'fixture.example'}},{getPayload:()=>undefined,getRemainingTimeInMillis:()=>30000});
console.log(JSON.stringify(result));
`,
					],
					{ cwd: isolated },
				);
				expect(
					JSON.parse(stdout.trim()) as unknown,
				).toMatchObject({
					statusCode: 200,
					body: "18.3.1:<p>shared-peer</p>",
				});
				const require = createRequire(
					join(isolated, "index.js"),
				);
				const widgetRequire = createRequire(
					require.resolve("peer-widget"),
				);
				const rendererRequire = createRequire(
					widgetRequire.resolve("react-dom/server"),
				);
				expect(rendererRequire.resolve("react")).toBe(
					widgetRequire.resolve("react"),
				);
			} finally {
				await rm(isolated, { recursive: true, force: true });
			}
		});

		it("rejects a createRequire package load left external by the bundle pipeline", async () => {
			const application = join(root, "bundle-require");
			await mkdir(join(application, "src/pages"), {
				recursive: true,
			});
			await writeFile(
				join(application, "src/pages/id.ts"),
				"import {createRequire} from 'node:module'; const req=createRequire(import.meta.url); export const GET=()=>new Response(req('nanoid').nanoid());",
			);
			await writeFile(
				join(application, "astro.config.mjs"),
				"import adapter from '@astro-yandex-cloud/adapter'; import {passthroughImageService} from 'astro/config'; export default {output:'server',image:{service:passthroughImageService()},adapter:adapter({target:'object-storage-functions',apiGateway:true})};",
			);
			await expect(
				astro.build({
					root: `${application}/`,
					logLevel: "silent",
				}),
			).rejects.toThrow(
				/unresolved runtime package imports.*nanoid/,
			);
		});

		it("builds and previews public HTML filenames containing URL punctuation", async () => {
			const { server, origin, application } = await startPreview(
				"static",
				"object-storage",
			);
			try {
				for (const name of ["hello#world.html", "100%.html"]) {
					expect(
						await readFile(
							join(application, "dist/client", name),
							"utf8",
						),
					).toBe(`<p>${name}</p>`);
					const response = await fetch(
						`${origin}/${encodeURIComponent(name)}`,
					);
					expect(response.status).toBe(200);
					expect(await response.text()).toBe(`<p>${name}</p>`);
				}
			} finally {
				await server.stop();
				await server.closed();
			}
		});

		it("falls through ENOTDIR candidates to the runtime handler for GET and HEAD", async () => {
			const { server, origin, application } = await startPreview(
				"mixed",
				"object-storage-functions",
			);
			try {
				await writeFile(
					join(application, "dist/client/robots.txt"),
					"User-agent: *",
				);
				for (const method of ["GET", "HEAD"]) {
					for (const path of [
						"/robots.txt/child",
						"/robots.txt/",
					]) {
						const response = await fetch(`${origin}${path}`, {
							method,
						});
						expect(response.status).toBe(404);
						const body = await response.text();
						if (method === "HEAD") expect(body).toBe("");
						else expect(body).toContain("404");
					}
				}
			} finally {
				await server.stop();
				await server.closed();
			}
		});

		it.each([
			["object-storage", "/"],
			["object-storage", "/docs"],
			["object-storage-functions", "/"],
			["object-storage-functions", "/docs"],
		] as const)(
			"serves the %s Client Artifact under %s without a Function Artifact until stopped",
			async (target, base) => {
				const { server, origin, application } =
					await startPreview("static", target, base);
				const prefix = base === "/" ? "" : base;
				try {
					const response = await fetch(`${origin}${prefix}/`);
					expect(response.status).toBe(200);
					const page = await response.text();
					expect(page).toContain("<h1>Static fixture</h1>");
					expect(response.headers.get("x-preview-header")).toBe(
						"configured",
					);
					await expectBrowserAsset(page, origin, prefix);
					const about = await fetch(`${origin}${prefix}/about/`);
					expect(about.status).toBe(200);
					expect(await about.text()).toContain(
						"<p>Static about page</p>",
					);
					const endpoint = await fetch(
						`${origin}${prefix}/api/items/a.json`,
					);
					expect(endpoint.status).toBe(200);
					expect(await endpoint.json()).toEqual({ slug: "a" });
					const head = await fetch(`${origin}${prefix}/`, {
						method: "HEAD",
					});
					expect(head.status).toBe(200);
					expect(head.headers.get("content-type")).toBe(
						"text/html; charset=utf-8",
					);
					expect(await head.text()).toBe("");
					await expect(
						readFile(
							join(application, "dist/function/index.js"),
						),
					).rejects.toHaveProperty("code", "ENOENT");
					if (prefix) {
						expect(
							(await fetch(`${origin}/about/`)).status,
						).toBe(404);
						expect(
							(await fetch(`${origin}/docs-other/about/`))
								.status,
						).toBe(404);
					}
				} finally {
					await server.stop();
					await server.closed();
				}
				await expect(
					fetch(`${origin}${prefix}/`),
				).rejects.toThrow();
			},
		);

		it.each(["/", "/docs"])(
			"previews the normal root custom 404 under %s without recursive mode",
			async (base) => {
				const { server, origin } = await startPreview(
					"static",
					"object-storage",
					base,
				);
				const prefix = base === "/" ? "" : base;
				try {
					for (const path of ["/missing", "/404", "/404/"]) {
						const response = await fetch(
							`${origin}${prefix}${path}`,
						);
						expect(response.status).toBe(404);
						expect(await response.text()).toContain(
							"Missing page",
						);
					}
					const head = await fetch(
						`${origin}${prefix}/missing`,
						{ method: "HEAD" },
					);
					expect(head.status).toBe(404);
					expect(await head.text()).toBe("");
					if (prefix)
						expect(
							await (await fetch(`${origin}/outside`)).text(),
						).toBe("Not Found");
				} finally {
					await server.stop();
					await server.closed();
				}
			},
		);

		it("previews nearest recursive 404 pages and explicit 404 URLs without a Function Artifact", async () => {
			const { server, origin } = await startPreview(
				"static",
				"object-storage",
				"/docs",
				{},
				{ apiGateway: true, recursive404: true },
			);
			try {
				for (const path of [
					"/docs/guide/missing",
					"/docs/guide/404",
					"/docs/guide/404/",
				]) {
					const missing = await fetch(`${origin}${path}`);
					expect(missing.status).toBe(404);
					expect(missing.headers.get("content-type")).toBe(
						"text/html; charset=utf-8",
					);
					expect(await missing.text()).toContain(
						"Guide missing page",
					);
				}
				const rootMissing = await fetch(
					`${origin}/docs/elsewhere`,
				);
				expect(rootMissing.status).toBe(404);
				expect(await rootMissing.text()).toContain(
					"Missing page",
				);
				const head = await fetch(
					`${origin}/docs/guide/missing`,
					{ method: "HEAD" },
				);
				expect(head.status).toBe(404);
				expect(head.headers.get("content-type")).toBe(
					"text/html; charset=utf-8",
				);
				expect(await head.text()).toBe("");
				expect(
					await (
						await fetch(`${origin}/docs-other/missing`)
					).text(),
				).toBe("Not Found");
				const existing = await fetch(`${origin}/docs/about/`);
				expect(existing.status).toBe(200);
				expect(await existing.text()).toContain(
					"Static about page",
				);
			} finally {
				await server.stop();
				await server.closed();
			}
		});

		it.each([
			{
				build: "Static-only Build",
				fixture: "static-functions",
				target: "object-storage",
			},
			{
				build: "Runtime Build",
				fixture: "mixed",
				target: "object-storage-functions",
			},
		] as const)(
			"serves file-format Prerendered Routes with trailing slashes in a $build",
			async ({ fixture, target }) => {
				const { server, origin } = await startPreview(
					fixture,
					target,
					"/docs",
					{
						build: { format: "file" },
						trailingSlash: "always",
					},
				);
				try {
					const response = await fetch(`${origin}/docs/about/`);
					expect(response.status).toBe(200);
					expect(await response.text()).toContain(
						"<title>About</title>",
					);
					expect(
						response.headers.get("x-fixture-middleware"),
					).toBeNull();
					const assetPage = await fetch(`${origin}/docs/`);
					expect(assetPage.status).toBe(200);
					await expectBrowserAsset(
						await assetPage.text(),
						origin,
						"/docs",
					);
				} finally {
					await server.stop();
					await server.closed();
				}
			},
		);

		it("serves JavaScript module assets with a browser-compatible content type", async () => {
			const { server, origin } = await startPreview(
				"static",
				"object-storage-functions",
				"/docs",
			);
			try {
				const response = await fetch(
					`${origin}/docs/preview.mjs`,
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe(
					"text/javascript; charset=utf-8",
				);
				expect(await response.text()).toBe(
					"export const preview = true;\n",
				);
			} finally {
				await server.stop();
				await server.closed();
			}
		});

		describe.each(["/", "/docs"])(
			"Runtime Build under %s",
			(base) => {
				let server: PreviewServer;
				let origin: string;
				const prefix = base === "/" ? "" : base;
				beforeAll(async () => {
					({ server, origin } = await startPreview(
						"mixed",
						"object-storage-functions",
						base,
					));
				});
				afterAll(async () => {
					if (server) {
						await server.stop();
						await server.closed();
					}
				});

				it("preserves the local HTTP origin for same-origin runtime POST requests", async () => {
					const response = await fetch(
						`${origin}${prefix}/api/inspect/text?value=first&value=second`,
						{
							method: "POST",
							headers: {
								origin,
								"content-type": "text/plain",
								"x-repeated": "first, second",
								"x-forwarded-host": "attacker.example",
								"x-forwarded-proto": "https",
							},
							body: "hello",
						},
					);
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({
						origin,
						method: "POST",
						pathname: `${prefix}/api/inspect/text`,
						bodyBase64: "aGVsbG8=",
						values: ["first", "second"],
						repeatedHeader: "first, second",
					});
				});

				it.each([
					"DELETE",
					"GET",
					"HEAD",
					"OPTIONS",
					"PATCH",
					"POST",
					"PUT",
				])(
					"passes the %s request method through the generated handler",
					async (method) => {
						const response = await fetch(
							`${origin}${prefix}/api/inspect/method`,
							{
								method,
								headers: { origin },
							},
						);
						expect(response.status).toBe(200);
						expect(
							response.headers.get("x-inspected-method"),
						).toBe(method);
						expect(
							response.headers.get("x-fixture-middleware"),
						).toBe("runtime");
						expect(
							response.headers.get("x-preview-header"),
						).toBe("configured");
						if (method === "HEAD")
							expect(await response.text()).toBe("");
						else
							expect(await response.json()).toMatchObject({
								method,
								origin,
							});
					},
				);

				it("serves Prerendered Routes, browser assets, and public files from the Client Artifact", async () => {
					const response = await fetch(`${origin}${prefix}/`);
					expect(response.status).toBe(200);
					const page = await response.text();
					expect(page).toContain("<h1>Prerendered home</h1>");
					expect(
						response.headers.get("x-fixture-middleware"),
					).toBeNull();
					await expectBrowserAsset(page, origin, prefix);
					const publicFile = await fetch(
						`${origin}${prefix}/public.txt`,
					);
					expect(publicFile.status).toBe(200);
					expect(await publicFile.text()).toBe(
						"public fixture asset\n",
					);
				});

				it("passes binary request and response bodies without changing bytes", async () => {
					const response = await fetch(
						`${origin}${prefix}/api/inspect/binary`,
						{
							method: "POST",
							headers: {
								"content-type": "application/octet-stream",
							},
							body: Uint8Array.from([0, 1, 2, 255]),
						},
					);
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({
						bodyBase64: "AAEC/w==",
					});
					const binary = await fetch(
						`${origin}${prefix}/api/binary`,
					);
					expect(binary.status).toBe(200);
					expect(binary.headers.get("content-type")).toBe(
						"application/octet-stream",
					);
					expect(
						new Uint8Array(await binary.arrayBuffer()),
					).toEqual(Uint8Array.from([0, 1, 2, 255]));
				});

				it("renders an On-demand Route and preserves multiple Set-Cookie headers", async () => {
					const response = await fetch(
						`${origin}${prefix}/runtime`,
					);
					expect(response.status).toBe(200);
					expect(await response.text()).toContain(
						"<title>Runtime</title>",
					);
					expect(
						response.headers.get("x-fixture-middleware"),
					).toBe("runtime");
					expect(response.headers.getSetCookie()).toEqual([
						"runtime=true; Path=/; HttpOnly",
						"second=two; Path=/; SameSite=Strict",
					]);
				});

				it.each([
					["redirect", 307, "/runtime"],
					["empty", 204, null],
				] as const)(
					"preserves %s response status, headers, and empty body",
					async (kind, status, location) => {
						const response = await fetch(
							`${origin}${prefix}/api/response/${kind}`,
							{
								redirect: "manual",
							},
						);
						expect(response.status).toBe(status);
						expect(response.headers.get("location")).toBe(
							location,
						);
						expect(await response.text()).toBe("");
					},
				);

				it("stops listening and resolves closed after serving runtime requests", async () => {
					const closed = server.closed();
					await server.stop();
					await closed;
					await server.closed();
					await expect(
						fetch(`${origin}${prefix}/runtime`),
					).rejects.toThrow();
				});
			},
		);

		it("passes incoming cookies and returns Action cookies over local HTTP", async () => {
			const { server, origin } = await startPreview(
				"actions",
				"object-storage-functions",
				"/docs",
			);
			try {
				const response = await fetch(
					`${origin}/docs/_actions/greet`,
					{
						method: "POST",
						headers: {
							origin,
							"content-type": "application/json",
							cookie: "session=session-123",
						},
						body: JSON.stringify({ name: "Ada" }),
					},
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe(
					"application/json+devalue",
				);
				expect(
					response.headers.get("x-actions-middleware"),
				).toBe("active");
				expect(await response.json()).toEqual([
					{ message: 1, session: 2, middleware: 3 },
					"Hello, Ada",
					"session-123",
					"active",
				]);
				expect(response.headers.getSetCookie()).toEqual([
					"action-first=one; Path=/; HttpOnly",
					"action-second=two; Path=/; SameSite=Lax",
				]);
			} finally {
				await server.stop();
				await server.closed();
			}
		});
	},
);
