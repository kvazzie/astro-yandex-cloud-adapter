import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
	realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePinnedRuntimeDependencies } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency";
import { formatNpmLockfile } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Metadata.ts";
import type { RegistryVersionMetadata } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Registry.ts";

function resolveWithLocalSources(
	...args: Parameters<typeof resolvePinnedRuntimeDependencies>
) {
	return resolvePinnedRuntimeDependencies(
		args[0],
		args[1],
		args[2],
		true,
	);
}

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
			const graph = await resolveWithLocalSources(
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
			// The mirror: the later-discovered sibling has the nonmatching peer.
			{
				rootPeer: true,
				matching: false,
				mismatched: "beta",
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
				mismatched: "alpha",
				...options,
				peerName,
			})),
		),
	)(
		"preserves actual sibling peer identities regardless of discovery order: %j",
		async ({
			rootPeer,
			matching,
			mismatched,
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
						parent === mismatched && !matching ? "b" : "a";
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
					const graph = await resolveWithLocalSources(
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
									`node_modules/${mismatched}/node_modules/a-shared`,
							),
						).toBeDefined();
					// Node resolves each consumer's binding from its own location upward.
					const effective = (consumer: string, name: string) => {
						for (let scope = consumer; ;) {
							const found = graph.find(
								({ location }) =>
									location ===
									`${scope ? `${scope}/` : ""}node_modules/${name}`,
							);
							if (found || !scope) return found;
							scope = scope.replace(
								/\/?node_modules\/[^/]+$/,
								"",
							);
						}
					};
					const effectivePeer = (consumer: string) =>
						effective(consumer, peerName);
					for (const parent of ["alpha", "beta"]) {
						const context =
							parent === mismatched && !matching ? "b" : "a";
						const parentLocation = `${nested ? "node_modules/container/" : ""}node_modules/${parent}`;
						const expected = await realpath(
							join(root, "installed", `peer-${context}`),
						);
						// The parent's own dependency edge on the peer.
						expect(
							effectivePeer(parentLocation)?.installedDirectory,
							parent,
						).toBe(expected);
						// The peer that the renderer this parent loads resolves.
						const renderer = effective(
							parentLocation,
							"a-shared",
						);
						expect(renderer, `${parent} a-shared`).toBeDefined();
						expect(
							effectivePeer(renderer!.location)
								?.installedDirectory,
							`${parent} renderer`,
						).toBe(expected);
					}
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
			const graph = await resolveWithLocalSources(
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

	it.each([
		{ shrinkwrap: true, nested: true, accepted: true },
		{ shrinkwrap: false, nested: true, accepted: false },
		{ shrinkwrap: true, nested: false, accepted: false },
	])(
		"validates a published shrinkwrap's children against raw ranges under a conflicting override: %j",
		async ({ shrinkwrap, nested, accepted }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-published-shrinkwrap-"),
			);
			try {
				const leaf = nested
					? "node_modules/carrier/node_modules/leaf"
					: "node_modules/leaf";
				for (const [directory, manifest] of [
					[
						"",
						{
							name: "app",
							version: "1.0.0",
							dependencies: { carrier: "1.0.0" },
							overrides: { leaf: "2.0.0" },
						},
					],
					[
						"node_modules/carrier",
						{
							name: "carrier",
							version: "1.0.0",
							dependencies: { leaf: "^1.0.0" },
						},
					],
					[leaf, { name: "leaf", version: "1.0.0" }],
				] as const) {
					await mkdir(join(root, directory), {
						recursive: true,
					});
					await writeFile(
						join(root, directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				if (shrinkwrap)
					await writeFile(
						join(
							root,
							"node_modules/carrier/npm-shrinkwrap.json",
						),
						JSON.stringify({
							lockfileVersion: 3,
							packages: {
								"": { name: "carrier", version: "1.0.0" },
								"node_modules/leaf": { version: "1.0.0" },
							},
						}),
					);
				const planning = resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["carrier"]),
					{ resolve: () => Promise.resolve({}) },
				);
				if (!accepted) {
					await expect(planning).rejects.toThrow(
						/"leaf" \(required by "carrier" as "\^1\.0\.0"\)/,
					);
					return;
				}
				const graph = await planning;
				expect(
					graph.find(({ name }) => name === "leaf"),
				).toMatchObject({ version: "1.0.0" });
				expect(
					graph.find(({ name }) => name === "carrier")
						?.dependencies,
				).toEqual({ leaf: "1.0.0" });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ shrinkwrap: true, accepted: true },
		{ shrinkwrap: false, accepted: false },
	])(
		"keeps a published shrinkwrap's registry binding out of a local override's provenance: %j",
		async ({ shrinkwrap, accepted }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-shrinkwrap-provenance-"),
			);
			try {
				for (const [directory, manifest] of [
					[
						"",
						{
							name: "app",
							version: "1.0.0",
							dependencies: { carrier: "1.0.0" },
							overrides: { leaf: "file:./fork.tgz" },
						},
					],
					[
						"node_modules/carrier",
						{
							name: "carrier",
							version: "1.0.0",
							dependencies: { leaf: "^1.0.0" },
						},
					],
					[
						"node_modules/carrier/node_modules/leaf",
						{ name: "leaf", version: "1.0.0" },
					],
				] as const) {
					await mkdir(join(root, directory), {
						recursive: true,
					});
					await writeFile(
						join(root, directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				if (shrinkwrap)
					await writeFile(
						join(
							root,
							"node_modules/carrier/npm-shrinkwrap.json",
						),
						JSON.stringify({
							lockfileVersion: 3,
							packages: {
								"": { name: "carrier", version: "1.0.0" },
								"node_modules/leaf": { version: "1.0.0" },
							},
						}),
					);
				const planning = resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["carrier"]),
					{ resolve: () => Promise.resolve({}) },
				);
				if (!accepted) {
					await expect(planning).rejects.toThrow(
						/local runtime package "leaf"/i,
					);
					return;
				}
				const graph = await planning;
				const leaf = graph.find(({ name }) => name === "leaf");
				expect(leaf).toMatchObject({ version: "1.0.0" });
				expect(leaf?.localDirectory).toBeUndefined();
				expect(
					graph.find(({ name }) => name === "carrier")
						?.dependencies,
				).toEqual({ leaf: "1.0.0" });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([".vendor", "file:.vendor"])(
		"requires includeLocal for the dot-prefixed directory requirement %s",
		async (requirement) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-dot-directory-"),
			);
			try {
				for (const [directory, manifest] of [
					[
						"",
						{
							name: "app",
							version: "1.0.0",
							dependencies: { renderer: requirement },
						},
					],
					[
						"node_modules/renderer",
						{ name: "renderer", version: "1.0.0" },
					],
				] as const) {
					await mkdir(join(root, directory), {
						recursive: true,
					});
					await writeFile(
						join(root, directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				await expect(
					resolvePinnedRuntimeDependencies(
						pathToFileURL(`${root}/`),
						new Set(["renderer"]),
						{
							resolve: () =>
								Promise.reject(
									new Error("registry metadata requested"),
								),
						},
					),
				).rejects.toThrow(/local runtime package "renderer"/i);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("lets an ordinary dependency take precedence over a peer of the same name", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-ordinary-over-peer-"),
		);
		try {
			for (const [directory, manifest] of [
				...(["alpha", "beta"] as const).map(
					(name) =>
						[
							`node_modules/${name}`,
							{
								name,
								version: "1.0.0",
								dependencies: { renderer: "^1.0.0" },
							},
						] as const,
				),
				[
					"node_modules/renderer",
					{
						name: "renderer",
						version: "1.0.0",
						dependencies: { host: "^2.0.0" },
						peerDependencies: { host: "^1.0.0" },
					},
				],
				[
					"node_modules/renderer/node_modules/host",
					{ name: "host", version: "2.0.0" },
				],
				[
					"node_modules/host",
					{ name: "host", version: "1.0.0" },
				],
			] as const) {
				await mkdir(join(root, directory), { recursive: true });
				await writeFile(
					join(root, directory, "package.json"),
					JSON.stringify(manifest),
				);
			}
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["alpha", "beta"]),
				{ resolve: () => Promise.resolve({}) },
			);
			expect(
				graph
					.map(({ location, version }) => [location, version])
					.sort(),
			).toEqual([
				["node_modules/alpha", "1.0.0"],
				["node_modules/beta", "1.0.0"],
				["node_modules/renderer", "1.0.0"],
				["node_modules/renderer/node_modules/host", "2.0.0"],
			]);
			expect(
				graph.find(({ name }) => name === "renderer"),
			).toMatchObject({
				dependencies: { host: "2.0.0" },
				peerDependencies: { host: "^1.0.0" },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ peer: false, reuse: false, barrier: false },
		{ peer: false, reuse: true, barrier: false },
		{ peer: true, reuse: false, barrier: false },
		{ peer: true, reuse: true, barrier: false },
		{ peer: false, reuse: false, barrier: true },
	])(
		"protects every lookup scope from later shadowing: %j",
		async ({ peer, reuse, barrier }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-shadowed-edge-"),
			);
			const middle = "node_modules/middle";
			const first = `${middle}/node_modules/p1`;
			const second = `${middle}/node_modules/p2`;
			try {
				const manifests: Record<string, object> = {
					"node_modules/p1": { name: "p1", version: "2.0.0" },
					"node_modules/p2": { name: "p2", version: "2.0.0" },
					[middle]: {
						name: "middle",
						version: "1.0.0",
						dependencies: { p1: "1.0.0", p2: "1.0.0" },
					},
					[first]: {
						name: "p1",
						version: "1.0.0",
						dependencies: {
							[peer ? "renderer" : "shared"]: "1.0.0",
						},
					},
					[second]: {
						name: "p2",
						version: "1.0.0",
						[barrier ? "peerDependencies" : "dependencies"]: {
							shared: "2.0.0",
						},
					},
					[`${first}/node_modules/shared`]: {
						name: "shared",
						version: "1.0.0",
					},
					[`${barrier ? middle : second}/node_modules/shared`]: {
						name: "shared",
						version: "2.0.0",
					},
				};
				if (peer)
					manifests[`${first}/node_modules/renderer`] = {
						name: "renderer",
						version: "1.0.0",
						peerDependencies: { shared: "1.0.0" },
					};
				if (reuse)
					manifests["node_modules/a-early"] = {
						name: "a-early",
						version: "1.0.0",
						dependencies: {
							[peer ? "renderer" : "shared"]: "1.0.0",
						},
					};
				for (const [directory, manifest] of Object.entries(
					manifests,
				)) {
					await mkdir(join(root, directory, "node_modules"), {
						recursive: true,
					});
					await writeFile(
						join(root, directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				if (reuse)
					await symlink(
						join(
							root,
							first,
							"node_modules",
							peer ? "renderer" : "shared",
						),
						join(
							root,
							"node_modules/a-early/node_modules",
							peer ? "renderer" : "shared",
						),
						"dir",
					);
				const graph = await resolveWithLocalSources(
					pathToFileURL(`${root}/`),
					new Set(reuse ? ["a-early", "middle"] : ["middle"]),
					{ resolve: () => Promise.resolve({}) },
				);
				expect(
					graph.find(
						({ name, version }) =>
							name === "shared" && version === "1.0.0",
					)?.location,
				).toBe(
					barrier
						? `${first}/node_modules/shared`
						: "node_modules/shared",
				);
				// p2 resolves its own shared@2.0.0 from its location upward, as Node does.
				const resolvedFrom = (
					consumer: string,
					name: string,
				) => {
					for (let scope = consumer; ;) {
						const found = graph.find(
							({ location }) =>
								location ===
								`${scope ? `${scope}/` : ""}node_modules/${name}`,
						);
						if (found || !scope) return found;
						scope = scope.replace(/\/?node_modules\/[^/]+$/, "");
					}
				};
				expect(resolvedFrom(second, "shared")?.version).toBe(
					"2.0.0",
				);
				if (!barrier)
					expect(
						graph.find(
							({ name, version }) =>
								name === "shared" && version === "2.0.0",
						)?.location,
					).toBe(`${second}/node_modules/shared`);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		"events",
		"buffer",
		"punycode",
		"util",
		"process",
		"@fixture/import-only",
	])(
		"discovers a declared installed package named %s without resolving its exports",
		async (name) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-core-named-package-"),
			);
			try {
				for (const [packageName, manifest] of [
					[
						"host",
						{
							name: "host",
							version: "1.0.0",
							dependencies: { [name]: "^1.0.0" },
						},
					],
					[
						name,
						{
							name,
							version: "1.2.3",
							type: "module",
							exports: { ".": { import: "./index.js" } },
						},
					],
				] as const) {
					await mkdir(join(root, "node_modules", packageName), {
						recursive: true,
					});
					await writeFile(
						join(
							root,
							"node_modules",
							packageName,
							"package.json",
						),
						JSON.stringify(manifest),
					);
				}
				await writeFile(
					join(root, "node_modules", name, "index.js"),
					"throw new Error('must not execute metadata discovery');",
				);
				const graph = await resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["host"]),
					{ resolve: () => Promise.resolve({}) },
				);
				expect(
					graph.find((entry) => entry.name === name)?.version,
				).toBe("1.2.3");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("retains a lock-only events selection without registry reselection", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-locked-core-name-"),
		);
		try {
			const native = {
				version: "1.0.0",
				optionalDependencies: { variant: "1.0.0" },
			};
			await mkdir(join(root, "node_modules/native"), {
				recursive: true,
			});
			await writeFile(
				join(root, "node_modules/native/package.json"),
				JSON.stringify({ name: "native", ...native }),
			);
			await writeFile(
				join(root, "package-lock.json"),
				JSON.stringify({
					packages: {
						"node_modules/native": native,
						"node_modules/variant": {
							version: "1.0.0",
							os: ["darwin"],
							dependencies: { events: "^3.0.0" },
						},
						"node_modules/variant/node_modules/events": {
							version: "3.3.0",
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
							"must use locked events@3.3.0, not registry",
						);
					},
				},
			);
			expect(
				graph.find(({ name }) => name === "events"),
			).toMatchObject({ version: "3.3.0", optional: true });
			expect(
				graph.find(({ name }) => name === "variant"),
			).toMatchObject({ os: ["darwin"], optional: true });
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

	it.each([
		{ hoisted: "registry", installed: "directory" },
		{ hoisted: "local", installed: "directory" },
		{ hoisted: "local", installed: "link" },
	] as const)(
		"uses the nested lock pin when the installed candidate misses an optional edge (hoisted $hoisted $installed)",
		async ({ hoisted, installed }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-optional-pin-"),
			);
			try {
				for (const [name, manifest] of [
					[
						"carrier",
						{
							name: "carrier",
							version: "1.0.0",
							optionalDependencies: { leaf: "2.0.0" },
						},
					],
					["leaf", { name: "leaf", version: "1.0.0" }],
				] as const) {
					const directory =
						name === "leaf" && installed === "link"
							? join(root, "packages/leaf")
							: join(root, "node_modules", name);
					await mkdir(directory, { recursive: true });
					await writeFile(
						join(directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				if (installed === "link")
					await symlink(
						join(root, "packages/leaf"),
						join(root, "node_modules/leaf"),
						"dir",
					);
				// An unrelated hoisted development copy.
				const hoistedLeaf =
					hoisted === "registry"
						? {
								"node_modules/leaf": {
									version: "1.0.0",
									dev: true,
								},
							}
						: installed === "link"
							? {
									"node_modules/leaf": {
										resolved: "packages/leaf",
										link: true,
										dev: true,
									},
									"packages/leaf": {
										name: "leaf",
										version: "1.0.0",
										dev: true,
									},
								}
							: {
									"node_modules/leaf": {
										version: "1.0.0",
										resolved: "file:leaf-1.0.0.tgz",
										dev: true,
									},
								};
				await writeFile(
					join(root, "package-lock.json"),
					JSON.stringify({
						packages: {
							"node_modules/carrier": {
								version: "1.0.0",
								optionalDependencies: { leaf: "2.0.0" },
							},
							...hoistedLeaf,
							// npm skipped this platform-specific copy on this host.
							"node_modules/carrier/node_modules/leaf": {
								version: "2.0.0",
								optional: true,
								os: ["darwin"],
							},
						},
					}),
				);
				const graph = await resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(["carrier"]),
					{
						resolve: () => {
							throw new Error("must use the nested lock pin");
						},
					},
					false,
				);
				expect(
					graph.find(
						({ location }) =>
							location ===
							"node_modules/carrier/node_modules/leaf",
					),
				).toMatchObject({ version: "2.0.0", optional: true });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each(["link", "tarball"] as const)(
		"rejects a compatible local %s candidate for an optional edge without includeLocal",
		async (installed) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-optional-local-"),
			);
			try {
				const leaf =
					installed === "link"
						? join(root, "packages/leaf")
						: join(root, "node_modules/leaf");
				for (const [directory, manifest] of [
					[
						join(root, "node_modules/carrier"),
						{
							name: "carrier",
							version: "1.0.0",
							optionalDependencies: { leaf: "^1.0.0" },
						},
					],
					[leaf, { name: "leaf", version: "1.0.0" }],
				] as const) {
					await mkdir(directory, { recursive: true });
					await writeFile(
						join(directory, "package.json"),
						JSON.stringify(manifest),
					);
				}
				if (installed === "link")
					await symlink(
						leaf,
						join(root, "node_modules/leaf"),
						"dir",
					);
				await writeFile(
					join(root, "package-lock.json"),
					JSON.stringify({
						packages: {
							"node_modules/carrier": {
								version: "1.0.0",
								optionalDependencies: { leaf: "^1.0.0" },
							},
							...(installed === "link"
								? {
										"node_modules/leaf": {
											resolved: "packages/leaf",
											link: true,
										},
										"packages/leaf": {
											name: "leaf",
											version: "1.0.0",
										},
									}
								: {
										"node_modules/leaf": {
											version: "1.0.0",
											resolved: "file:leaf-1.0.0.tgz",
										},
									}),
						},
					}),
				);
				await expect(
					resolvePinnedRuntimeDependencies(
						pathToFileURL(`${root}/`),
						new Set(["carrier"]),
						{
							resolve: () => {
								throw new Error("must not reselect leaf");
							},
						},
						false,
					),
				).rejects.toThrow(/local runtime package "leaf"/i);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ index: true, rejected: true },
		{ index: false, rejected: false },
	])(
		"does not skip a nearer binding without a manifest (index: $index)",
		async ({ index, rejected }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-manifestless-"),
			);
			try {
				const app = join(root, "app");
				await mkdir(join(app, "node_modules/leaf"), {
					recursive: true,
				});
				await writeFile(
					join(app, "package.json"),
					'{"name":"app"}',
				);
				if (index)
					await writeFile(
						join(app, "node_modules/leaf/index.js"),
						"module.exports = 'nearer';",
					);
				await mkdir(join(root, "node_modules/leaf"), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules/leaf/package.json"),
					'{"name":"leaf","version":"1.0.0"}',
				);
				const planning = resolvePinnedRuntimeDependencies(
					pathToFileURL(`${app}/`),
					new Set(["leaf"]),
					{
						resolve: () => Promise.resolve({ version: "1.0.0" }),
					},
				);
				if (rejected)
					await expect(planning).rejects.toThrow(
						/no package\.json/,
					);
				else await expect(planning).resolves.toBeDefined();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each([
		{ imported: false, rejected: false },
		{ imported: true, rejected: true },
	])(
		"defers a manifestless development binding until the runtime needs it (imported: $imported)",
		async ({ imported, rejected }) => {
			const root = await mkdtemp(
				join(tmpdir(), "yandex-manifestless-dev-"),
			);
			try {
				await writeFile(
					join(root, "package.json"),
					JSON.stringify({
						name: "app",
						dependencies: { renderer: "^1.0.0" },
						devDependencies: { tool: "^1.0.0" },
					}),
				);
				await mkdir(join(root, "node_modules/renderer"), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules/renderer/package.json"),
					'{"name":"renderer","version":"1.0.0"}',
				);
				await mkdir(join(root, "node_modules/tool"), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules/tool/index.js"),
					"module.exports = 'tool';",
				);
				const planning = resolvePinnedRuntimeDependencies(
					pathToFileURL(`${root}/`),
					new Set(
						imported ? ["renderer", "tool"] : ["renderer"],
					),
					{
						resolve: () => Promise.resolve({ version: "1.0.0" }),
					},
				);
				if (rejected)
					await expect(planning).rejects.toThrow(
						/"tool" .*no package\.json/,
					);
				else
					expect(
						(await planning).map(({ name }) => name),
					).toEqual(["renderer"]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("skips an incompatible local lock entry before the local-source gate", async () => {
		const root = await mkdtemp(
			join(tmpdir(), "yandex-local-lock-"),
		);
		try {
			for (const [name, version] of [
				["native", "1.0.0"],
				["leaf", "1.0.0"],
			] as const) {
				await mkdir(join(root, "node_modules", name), {
					recursive: true,
				});
				await writeFile(
					join(root, "node_modules", name, "package.json"),
					JSON.stringify({
						name,
						version,
						...(name === "native"
							? { optionalDependencies: { variant: "1.0.0" } }
							: {}),
					}),
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
						// An unrelated hoisted local package that does not satisfy ^2.
						"node_modules/leaf": {
							version: "1.0.0",
							resolved: "file:../leaf",
						},
						"node_modules/variant": {
							version: "1.0.0",
							os: ["darwin"],
							optional: true,
							optionalDependencies: { leaf: "^2" },
						},
					},
				}),
			);
			const graph = await resolvePinnedRuntimeDependencies(
				pathToFileURL(`${root}/`),
				new Set(["native"]),
				{
					resolve: (name, range) =>
						Promise.resolve(
							name === "leaf" && range === "^2"
								? { version: "2.0.0" }
								: { version: "0.0.0" },
						),
				},
				false,
			);
			expect(
				graph.find(({ name }) => name === "leaf"),
			).toMatchObject({ version: "2.0.0", optional: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

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
 const graph = await resolvePinnedRuntimeDependencies(new URL(${JSON.stringify(pathToFileURL(`${root}/`).href)}), new Set(['a']), {resolve: () => Promise.resolve({})}, true);
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
