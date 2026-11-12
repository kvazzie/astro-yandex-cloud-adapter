import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePinnedRuntimeDependencies } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency";
import { findRuntimePackageImports } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/ImportSpecifier.ts";
import { formatNpmLockfile } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Metadata.ts";
import type { RegistryVersionMetadata } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Registry.ts";

describe("runtime dependency regressions", () => {
	it("discovers installed required peers and skips absent optional peers", async () => {
		const root = await mkdtemp(join(tmpdir(), "yandex-peers-"));
		try {
			for (const name of [
				"renderer",
				"react",
				"optional-peer",
			]) {
				await mkdir(join(root, "node_modules", name), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules", name, "package.json"),
					JSON.stringify({ name, version: "1.0.0" }),
				);
			}
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["renderer"]),
				{
					resolve: (name) =>
						Promise.resolve<RegistryVersionMetadata>(
							name === "renderer"
								? {
										peerDependencies: {
											react: "^1.0.0",
											missing: "*",
											"optional-peer": "^1.0.0",
										},
										peerDependenciesMeta: {
											missing: { optional: true },
											"optional-peer": { optional: true },
										},
									}
								: {},
						),
				},
			);
			expect(graph.map(({ name }) => name).sort()).toEqual([
				"optional-peer",
				"react",
				"renderer",
			]);
			const lock = JSON.parse(formatNpmLockfile(graph)) as {
				packages: Record<string, RegistryVersionMetadata>;
			};
			expect(
				lock.packages["node_modules/renderer"]?.peerDependencies,
			).toEqual({
				react: "1.0.0",
				missing: "*",
				"optional-peer": "1.0.0",
			});
			expect(
				graph.find(({ name }) => name === "optional-peer")
					?.optional,
			).toBe(true);
			expect(
				graph.find(({ name }) => name === "react")?.optional,
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves symlinked installations with distinct peer contexts", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-peer-contexts-"),
		);
		try {
			for (const [parent, version] of [
				["alpha", "1.0.0"],
				["beta", "2.0.0"],
			] as const) {
				const store = join(
					root,
					"node_modules/.pnpm",
					`renderer@1.0.0_peer@${version}`,
					"node_modules",
				);
				for (const [name, manifest] of [
					[
						"renderer",
						{
							name: "renderer",
							version: "1.0.0",
							peerDependencies: { peer: "1 || 2" },
						},
					],
					["peer", { name: "peer", version }],
				] as const) {
					await mkdir(join(store, name), { recursive: true });
					await writeFile(
						join(store, name, "package.json"),
						JSON.stringify(manifest),
					);
				}
				const directory = join(root, "node_modules", parent);
				await mkdir(join(directory, "node_modules"), {
					recursive: true,
				});
				await writeFile(
					join(directory, "package.json"),
					JSON.stringify({
						name: parent,
						version: "1.0.0",
						dependencies: { renderer: "1.0.0" },
					}),
				);
				await symlink(
					join(store, "renderer"),
					join(directory, "node_modules/renderer"),
					"dir",
				);
			}
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["alpha", "beta"]),
				{ resolve: () => Promise.resolve({}) },
			);
			const lock = JSON.parse(formatNpmLockfile(graph)) as {
				packages: Record<string, RegistryVersionMetadata>;
			};
			expect(
				lock.packages["node_modules/renderer"]?.peerDependencies,
			).toEqual({ peer: "1.0.0" });
			expect(
				lock.packages["node_modules/beta/node_modules/renderer"]
					?.peerDependencies,
			).toEqual({ peer: "2.0.0" });
			expect(
				lock.packages[
					"node_modules/beta/node_modules/renderer/node_modules/peer"
				]?.version,
			).toBe("2.0.0");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the locked optional variant version instead of selecting a newer registry version", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-optional-lock-"),
		);
		try {
			await mkdir(join(root, "node_modules/native"), {
				recursive: true,
			});
			await writeFile(
				join(root, "node_modules/native/package.json"),
				JSON.stringify({
					name: "native",
					version: "1.0.0",
					optionalDependencies: { variant: "^1.0.0" },
				}),
			);
			await writeFile(
				join(root, "package-lock.json"),
				JSON.stringify({
					packages: {
						"node_modules/native": {
							version: "1.0.0",
							optionalDependencies: { variant: "^1.0.0" },
						},
						"node_modules/variant": {
							version: "1.2.3",
							os: ["darwin"],
						},
					},
				}),
			);
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["native"]),
				{
					resolve: () => {
						throw new Error(
							"must not reselect a locked version",
						);
					},
				},
			);
			expect(
				graph.find(({ name }) => name === "variant"),
			).toMatchObject({
				version: "1.2.3",
				optional: true,
				os: ["darwin"],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		"import {createRequire as make} from 'node:module'; const req = make(import.meta.url); req('nanoid');",
		"import * as mod from 'module'; const req = mod.createRequire(import.meta.url); const alias = req; alias(`nanoid`);",
		"import {createRequire} from 'module'; createRequire(import.meta.url)('nanoid');",
		"const mod = await import('node:module'); const req=mod.createRequire(import.meta.url); req('nanoid');",
		"import {'createRequire' as make} from 'node:module'; const req=make(import.meta.url); req('nanoid');",
		"import {createRequire} from 'node:module'; const req=createRequire(import.meta.url); const lookup=req.resolve; lookup('nanoid');",
		"import {createRequire} from 'node:module'; const req=createRequire(import.meta.url); function shadow(req) { req(name); } req('nanoid');",
	])(
		"accounts for fixed createRequire loads: %s",
		(contents) => {
			expect([
				...findRuntimePackageImports(
					[{ path: "index.js", contents }],
					"install",
				),
			]).toEqual(["nanoid"]);
		},
	);

	it.each([
		"req(name)",
		"req.resolve(name)",
		"consume(req)",
		"export {req}",
		"const {resolve} = req; resolve(name)",
		"req = other",
	])("rejects unaccounted createRequire loading: %s", (load) => {
		const contents = `import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); ${load};`;
		expect(() =>
			findRuntimePackageImports(
				[{ path: "index.js", contents }],
				"install",
			),
		).toThrow(/unresolved dynamic/);
	});

	it("rejects Node module promises escaping lexical loader analysis", () => {
		const contents =
			"const mod=import('node:module'); mod.then(m => m.createRequire(import.meta.url)(name));";
		expect(() =>
			findRuntimePackageImports(
				[{ path: "index.js", contents }],
				"install",
			),
		).toThrow(/unresolved dynamic/);
	});

	it("does not mistake a shadowed or local createRequire for Node's binding", () => {
		for (const contents of [
			"function createRequire() { return () => {}; } const req = createRequire(); req(name);",
			"import {createRequire} from 'node:module'; function local(createRequire) { const req = createRequire(); req(name); }",
		])
			expect([
				...findRuntimePackageImports(
					[{ path: "index.js", contents }],
					"install",
				),
			]).toEqual([]);
	});

	it("locates import-only and subpath-only installed packages without executing them", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-exports-"),
		);
		try {
			for (const exports of [
				{ ".": { import: "./index.js" } },
				{ "./feature": "./index.js" },
			]) {
				await mkdir(join(root, "node_modules/hidden"), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules/hidden/package.json"),
					JSON.stringify({
						name: "hidden",
						version: "1.0.0",
						exports,
					}),
				);
				await writeFile(
					join(root, "node_modules/hidden/index.js"),
					"throw new Error('must not execute');",
				);
				const graph = await resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["hidden"]),
					{ resolve: () => Promise.resolve({}) },
				);
				expect(graph).toMatchObject([
					{ name: "hidden", version: "1.0.0" },
				]);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
