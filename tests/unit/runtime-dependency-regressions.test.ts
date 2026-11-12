import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
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
				lock.packages["node_modules/beta/node_modules/peer"]
					?.version,
			).toBe("2.0.0");
			expect(lock.packages["node_modules/peer"]?.version).toBe(
				"1.0.0",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(
		[
			{
				rootPeer: true,
				matching: true,
				directPeer: true,
				nested: false,
			},
			{
				rootPeer: false,
				matching: true,
				directPeer: false,
				nested: false,
			},
			{
				rootPeer: true,
				matching: false,
				directPeer: false,
				nested: false,
			},
			{
				rootPeer: true,
				matching: true,
				directPeer: false,
				nested: true,
			},
		].flatMap((options) =>
			["a-peer", "z-peer"].map((peerName) => ({
				...options,
				peerName,
			})),
		),
	)(
		"preserves actual sibling peer identities regardless of discovery order: %j",
		async ({
			rootPeer,
			matching,
			directPeer,
			nested,
			peerName,
		}) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-sibling-peers-"),
			);
			try {
				for (const [name, manifest] of Object.entries({
					"peer-a": { name: peerName, version: "1.0.0" },
					"peer-b": { name: peerName, version: "1.0.0" },
					"shared-a": {
						name: "a-shared",
						version: "1.0.0",
						peerDependencies: { [peerName]: "1.0.0" },
					},
					"shared-b": {
						name: "a-shared",
						version: "1.0.0",
						peerDependencies: { [peerName]: "1.0.0" },
					},
				})) {
					const directory = join(root, "installed", name);
					await mkdir(join(directory, "node_modules"), {
						recursive: true,
					});
					await writeFile(
						join(directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				for (const context of ["a", "b"])
					await symlink(
						join(root, "installed", `peer-${context}`),
						join(
							root,
							"installed",
							`shared-${context}`,
							"node_modules",
							peerName,
						),
						"dir",
					);
				const parents = nested
					? join(root, "node_modules/container/node_modules")
					: join(root, "node_modules");
				if (nested) {
					await mkdir(parents, { recursive: true });
					await writeFile(
						join(root, "node_modules/container/package.json"),
						JSON.stringify({
							name: "container",
							version: "1.0.0",
							dependencies: {
								alpha: "1.0.0",
								beta: "1.0.0",
								[peerName]: "1.0.0",
							},
						}),
					);
					await symlink(
						join(root, "installed/peer-a"),
						join(parents, peerName),
						"dir",
					);
					for (const name of ["alpha", "beta"]) {
						await mkdir(join(root, "node_modules", name));
						await writeFile(
							join(root, "node_modules", name, "package.json"),
							JSON.stringify({ name, version: "1.0.0" }),
						);
					}
				}
				for (const parent of ["alpha", "beta"]) {
					const context =
						parent === "alpha" && !matching ? "b" : "a";
					const directory = join(parents, parent);
					await mkdir(join(directory, "node_modules"), {
						recursive: true,
					});
					await writeFile(
						join(directory, "package.json"),
						JSON.stringify({
							name: parent,
							version: "1.0.0",
							dependencies: {
								"a-shared": "1.0.0",
								[peerName]: "1.0.0",
							},
						}),
					);
					await symlink(
						join(root, "installed", `shared-${context}`),
						join(directory, "node_modules/a-shared"),
						"dir",
					);
					await symlink(
						join(root, "installed", `peer-${context}`),
						join(directory, "node_modules", peerName),
						"dir",
					);
				}
				if (rootPeer)
					await symlink(
						join(
							root,
							nested ? "installed/peer-b" : "installed/peer-a",
						),
						join(root, "node_modules", peerName),
						"dir",
					);
				let previous: string | undefined;
				for (const names of nested
					? [["container"]]
					: [
							["alpha", "beta"],
							["beta", "alpha"],
						]) {
					if (directPeer) names.push(peerName);
					const graph = await resolvePinnedRuntimeDependencies(
						pathToFileURL(`${root}/`),
						new Set(names),
						{ resolve: () => Promise.resolve({}) },
					);
					expect(
						graph.filter(({ name }) => name === "a-shared"),
					).toHaveLength(matching ? 1 : 2);
					expect(
						graph.filter(({ name }) => name === peerName),
					).toHaveLength(matching ? 1 : 2);
					expect(
						graph.find(
							({ location }) =>
								location ===
								(nested
									? "node_modules/container/node_modules/a-shared"
									: "node_modules/a-shared"),
						),
					).toBeDefined();
					if (!matching)
						expect(
							graph.find(
								({ location }) =>
									location ===
									"node_modules/alpha/node_modules/a-shared",
							),
						).toBeDefined();
					const lock = formatNpmLockfile(graph);
					if (previous) expect(lock).toBe(previous);
					previous = lock;
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("does not introduce an absent optional peer through a child's peer context", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-optional-peer-context-"),
		);
		try {
			for (const [directory, manifest] of [
				[
					"node_modules/host",
					{
						name: "host",
						version: "1.0.0",
						dependencies: { renderer: "1.0.0" },
						peerDependencies: { peer: "*" },
						peerDependenciesMeta: { peer: { optional: true } },
					},
				],
				[
					"installed/renderer",
					{
						name: "renderer",
						version: "1.0.0",
						peerDependencies: { peer: "1.0.0" },
					},
				],
				["installed/peer", { name: "peer", version: "1.0.0" }],
			] as const) {
				await mkdir(join(root, directory, "node_modules"), {
					recursive: true,
				});
				await writeFile(
					join(root, directory, "package.json"),
					JSON.stringify(manifest),
				);
			}
			await symlink(
				join(root, "installed/renderer"),
				join(root, "node_modules/host/node_modules/renderer"),
				"dir",
			);
			await symlink(
				join(root, "installed/peer"),
				join(root, "installed/renderer/node_modules/peer"),
				"dir",
			);
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["host"]),
				{ resolve: () => Promise.resolve({}) },
			);
			expect(
				graph.find(({ name }) => name === "peer")?.location,
			).toBe(
				"node_modules/host/node_modules/renderer/node_modules/peer",
			);
			expect(
				graph.find(({ name }) => name === "host")
					?.peerDependencies,
			).toEqual({ peer: "*" });
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

	it.each(["1 || 2", "^2.0.0"])(
		"prefers the locked nested child of an absent variant for %s",
		async (range) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-locked-child-"),
			);
			try {
				for (const name of ["native", "helper"]) {
					await mkdir(join(root, "node_modules", name), {
						recursive: true,
					});
					await writeFile(
						join(root, "node_modules", name, "package.json"),
						JSON.stringify({ name, version: "1.0.0" }),
					);
				}
				await writeFile(
					join(root, "package-lock.json"),
					JSON.stringify({
						packages: {
							"node_modules/native": {
								version: "1.0.0",
								optionalDependencies: { variant: "1.0.0" },
							},
							"node_modules/helper": { version: "1.0.0" },
							"node_modules/variant": {
								version: "1.0.0",
								os: ["darwin"],
								dependencies: { helper: range },
							},
							"node_modules/variant/node_modules/helper": {
								version: "2.0.0",
							},
						},
					}),
				);
				const graph = await resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["native", "helper"]),
					{
						resolve: () => {
							throw new Error("must use the exact lock graph");
						},
					},
				);
				expect(
					graph.find(
						({ location }) =>
							location ===
							"node_modules/variant/node_modules/helper",
					),
				).toMatchObject({ version: "2.0.0", optional: true });
				expect(
					graph.find(
						({ location }) => location === "node_modules/helper",
					),
				).toMatchObject({ version: "1.0.0" });
				expect(
					graph.find(({ name }) => name === "variant"),
				).toMatchObject({ optional: true, os: ["darwin"] });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([true, false])(
		"terminates symlink cycles without banning reusable ancestors (conflicting=%s)",
		async (conflicting) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-cycle-"),
			);
			const edges: [string, string][] = conflicting
				? [
						["a1", "b1"],
						["b1", "a2"],
						["a2", "b2"],
						["b2", "a1"],
					]
				: [
						["a1", "b1"],
						["b1", "a1"],
					];
			try {
				for (const [id, child] of edges) {
					const directory = join(root, "installed", id);
					await mkdir(join(directory, "node_modules"), {
						recursive: true,
					});
					await writeFile(
						join(directory, "package.json"),
						JSON.stringify({
							name: id[0],
							version: `${id[1]}.0.0`,
							dependencies: { [child[0]!]: `${child[1]}.0.0` },
						}),
					);
				}
				for (const [id, child] of edges)
					await symlink(
						join(root, "installed", child),
						join(
							root,
							"installed",
							id,
							"node_modules",
							child[0]!,
						),
						"dir",
					);
				await mkdir(join(root, "node_modules"));
				await symlink(
					join(root, "installed/a1"),
					join(root, "node_modules/a"),
					"dir",
				);
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						"--experimental-strip-types",
						"--max-old-space-size=128",
						"--input-type=module",
						"-e",
						`
import {resolvePinnedRuntimeDependencies} from ${JSON.stringify(pathToFileURL(resolve("packages/adapter/src/conditional/FunctionArtifact/Dependency/index.ts")).href)};
try {
 const graph = await resolvePinnedRuntimeDependencies(new URL(${JSON.stringify(pathToFileURL(`${root}/`).href)}), new Set(['a']), {resolve: () => Promise.resolve({})});
 console.log(graph.map(({name, version}) => name+'@'+version).join(','));
} catch (error) {console.log(error.message);}
`,
					],
					{
						timeout: 2000,
						killSignal: "SIGKILL",
						maxBuffer: 50_000,
					},
				);
				if (conflicting)
					expect(stdout).toMatch(/cannot preserve.*cycle/i);
				else expect(stdout.trim()).toBe("a@1.0.0,b@1.0.0");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([true, false])(
		"does not invent an absent required dependency (peer=%s)",
		async (peer) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-missing-required-"),
			);
			try {
				await mkdir(join(root, "node_modules/plugin"), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules/plugin/package.json"),
					JSON.stringify({
						name: "plugin",
						version: "1.0.0",
						[peer ? "peerDependencies" : "dependencies"]: {
							missing: "^1.0.0",
						},
					}),
				);
				await expect(
					resolvePinnedRuntimeDependencies(
						pathToFileURL(`${root}/`),
						new Set(["plugin"]),
						{
							resolve: (name) => {
								if (name !== "plugin")
									throw new Error(
										"must not select an absent required package from the registry",
									);
								return Promise.resolve({});
							},
						},
					),
				).rejects.toThrow(
					peer
						? /required runtime peer "missing"/
						: /runtime package "missing"/,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		"import {createRequire as make} from 'node:module'; const req = make(import.meta.url); req('nanoid');",
		"import * as mod from 'module'; const req = mod.createRequire(import.meta.url); const alias = req; alias(`nanoid`);",
		"import {createRequire} from 'module'; createRequire(import.meta.url)('nanoid');",
		"const mod = await import('node:module'); const req=mod.createRequire(import.meta.url); req('nanoid');",
		"const {createRequire} = await import('node:module'); const req=createRequire(import.meta.url); req('nanoid');",
		"const {createRequire: make} = await import('module'); const req=make(import.meta.url); req('nanoid');",
		"import * as mod from 'node:module'; const {createRequire: make}=mod; const req=make(import.meta.url); req('nanoid');",
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
		"req.resolve('nanoid', {paths: [otherDirectory]})",
		"const resolve=req.resolve; resolve('nanoid', {paths: [otherDirectory]})",
	])("rejects unaccounted createRequire loading: %s", (load) => {
		const contents = `import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); ${load};`;
		expect(() =>
			findRuntimePackageImports(
				[{ path: "index.js", contents }],
				"install",
			),
		).toThrow(/unresolved dynamic/);
	});

	it("rejects new.target.url as an unaccounted loader scope", () => {
		const contents =
			"import {createRequire} from 'node:module'; function Loader() {const req=createRequire(new.target.url); return req('nanoid');}";
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
