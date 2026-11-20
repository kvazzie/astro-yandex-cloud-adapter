import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PreviewServerParams } from "astro";
import { expect, it, vi } from "vitest";
import { parseDeploymentManifest as parseManifest } from "@astro-yandex-cloud/deployment-manifest";
import { parseDeploymentManifest } from "../../packages/adapter/src/mandatory/DeploymentManifest";
import preview from "../../packages/adapter/src/.preview.ts";

vi.mock(
	"../../packages/adapter/src/mandatory/DeploymentManifest",
	() => ({
		parseDeploymentManifest: vi.fn(),
	}),
);

it.each(["/", "/docs"])(
	"contains local 404 reads under base %s independently of manifest validation",
	async (base) => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-preview-path-"),
		);
		const outDir = pathToFileURL(`${join(root, "dist")}/`);
		const client = new URL("client/", outDir);
		await mkdir(client, { recursive: true });
		await writeFile(new URL("yandex-cloud.json", outDir), "{}");
		await writeFile(
			new URL("module.wasm", client),
			Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
		);
		await writeFile(
			new URL("secret.html", outDir),
			"outside secret",
		);
		await writeFile(
			new URL("404.html", client),
			"safe fallback",
		);
		await writeFile(
			new URL("robots.txt", client),
			"User-agent: *",
		);
		const prefix = base === "/" ? "" : `${base.slice(1)}/`;
		const url = `${base === "/" ? "" : base}/404/`;
		const manifest = parseManifest({
			schemaVersion: 1,
			adapter: { version: "0.1.0" },
			target: "object-storage",
			modifiers: { apiGateway: false },
			base,
			artifacts: {
				client: { id: "client", path: "client" },
				functions: [],
			},
			routes: {
				prerendered: [
					{
						kind: "page",
						url,
						objectKey: `${prefix}404.html`,
						artifactId: "client",
					},
				],
				onDemand: [],
				notFound: [
					{
						scope: base,
						url,
						objectKey: `${prefix}404.html`,
						artifactId: "client",
					},
				],
			},
		});
		const logError = vi.fn();
		const logger = {
			error: logError,
		} as unknown as PreviewServerParams["logger"];
		try {
			for (const [file, expected] of [
				["404.html", "safe fallback"],
				["../secret.html", "Not Found"],
				[join(root, "dist/secret.html"), "Not Found"],
			]) {
				// Bypass parsing deliberately: this guard must protect the read on its own.
				vi.mocked(parseDeploymentManifest).mockReturnValue({
					...manifest,
					routes: {
						...manifest.routes,
						notFound: [
							{
								...manifest.routes.notFound[0]!,
								objectKey: `${prefix}${file}`,
							},
						],
					},
				});
				const server = await preview({
					outDir,
					client,
					server: new URL("function/", outDir),
					serverEntrypoint: new URL("function/index.js", outDir),
					root: pathToFileURL(`${root}/`),
					host: "127.0.0.1",
					port: 0,
					base,
					logger,
				});
				try {
					const wasm = await fetch(
						`http://127.0.0.1:${server.port}/${prefix}module.wasm`,
					);
					expect(wasm.headers.get("content-type")).toBe(
						"application/wasm",
					);
					const loaded =
						await WebAssembly.instantiateStreaming(wasm);
					expect(loaded.instance).toBeInstanceOf(
						WebAssembly.Instance,
					);
					const response = await fetch(
						`http://127.0.0.1:${server.port}/${prefix}missing`,
					);
					expect(response.status).toBe(404);
					expect(await response.text()).toBe(expected);
					for (const method of ["GET", "HEAD"]) {
						for (const path of [
							"robots.txt/child",
							"robots.txt/",
						]) {
							const miss = await fetch(
								`http://127.0.0.1:${server.port}/${prefix}${path}`,
								{ method },
							);
							expect(miss.status).toBe(404);
							expect(await miss.text()).toBe(
								method === "HEAD" ? "" : expected,
							);
						}
					}
				} finally {
					await server.stop();
					await server.closed();
				}
			}
			expect(logError).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it.each(["missing", "ENOENT", "EACCES"])(
	"only suppresses a missing preview entrypoint, not initialization errors: %s",
	async (kind) => {
		const root = await mkdtemp(
			join(tmpdir(), "preview-startup-"),
		);
		const outDir = pathToFileURL(`${join(root, "dist")}/`);
		const client = new URL("client/", outDir);
		const serverDir = new URL("function/", outDir);
		await mkdir(client, { recursive: true });
		await mkdir(serverDir, { recursive: true });
		await writeFile(new URL("yandex-cloud.json", outDir), "{}");
		await writeFile(
			new URL("package.json", outDir),
			'{"type":"module"}',
		);
		vi.mocked(parseDeploymentManifest).mockReturnValue(
			parseManifest({
				schemaVersion: 1,
				adapter: { version: "0.1.0" },
				target: "object-storage",
				modifiers: { apiGateway: false },
				base: "/",
				artifacts: {
					client: { id: "client", path: "client" },
					functions: [],
				},
				routes: { prerendered: [], onDemand: [], notFound: [] },
			}),
		);
		if (kind !== "missing")
			await writeFile(
				new URL("index.js", serverDir),
				`throw Object.assign(new Error('entrypoint initialization failed'),{code:'${kind}'}); export function handler(){}`,
			);
		let running: Awaited<ReturnType<typeof preview>> | undefined;
		let cause: unknown;
		try {
			try {
				running = await preview({
					outDir,
					client,
					server: serverDir,
					serverEntrypoint: new URL("index.js", serverDir),
					root: pathToFileURL(root + "/"),
					host: "127.0.0.1",
					port: 0,
					base: "/",
					logger: {
						error() {},
					} as unknown as PreviewServerParams["logger"],
				});
			} catch (error) {
				cause = error;
			}
			if (kind === "missing") expect(running).toBeDefined();
			else
				expect(cause).toMatchObject({
					code: kind,
					message: "entrypoint initialization failed",
				});
		} finally {
			if (running) {
				await running.stop();
				await running.closed();
			}
			await rm(root, { recursive: true, force: true });
		}
	},
);
