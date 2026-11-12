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
