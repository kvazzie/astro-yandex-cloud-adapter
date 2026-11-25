import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as FunctionArtifact from "../../packages/adapter/src/conditional/FunctionArtifact";
import * as Options from "../../packages/adapter/src/Options";
import type { RoutePlan } from "../../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements";
import { hasRuntimeImageCalls } from "../../packages/adapter/src/mandatory/ArtifactGeneration/RuntimeImageRoutes";
import { validateFunctionEntrypoint } from "../../packages/adapter/src/conditional/FunctionArtifact/Prepare.ts";
import { externalBundledPeers } from "../../packages/adapter/src/conditional/FunctionArtifact/Dependency/Archive.ts";

const directories: string[] = [];
const fixtureRegistries: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		fixtureRegistries
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) =>
						server.close(() => resolve()),
					),
			),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function snapshot(
	directory: string,
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const visit = async (path: string): Promise<void> => {
		for (const entry of await readdir(path, {
			withFileTypes: true,
		})) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				result[relative(directory, child) + "/"] = "directory";
				await visit(child);
			} else if (entry.isSymbolicLink())
				result[relative(directory, child)] =
					"symlink:" + (await readlink(child));
			else
				result[relative(directory, child)] = (
					await readFile(child)
				).toString("base64");
		}
	};
	await visit(directory);
	return result;
}

async function serveFixtureTarballs() {
	const tarballs = new Map<string, Buffer>();
	const registry = createServer((request, response) => {
		const bytes = tarballs.get(request.url ?? "");
		if (bytes) response.end(bytes);
		else response.writeHead(404).end();
	});
	fixtureRegistries.push(registry);
	await new Promise<void>((resolve) =>
		registry.listen(0, "127.0.0.1", resolve),
	);
	const address = registry.address();
	if (!address || typeof address === "string")
		throw new Error("Expected registry port");
	return (filename: string, bytes: Buffer) => {
		tarballs.set("/" + filename, bytes);
		return {
			resolved: `http://127.0.0.1:${address.port}/${filename}`,
			integrity:
				"sha512-" +
				createHash("sha512").update(bytes).digest("base64"),
		};
	};
}

async function seedFixtureTarballCache(
	directory: string,
	entries: { resolved: string }[],
): Promise<string> {
	const cache = join(directory, "npm-cache");
	for (const { resolved } of entries)
		await promisify(execFile)(
			"npm",
			[
				"cache",
				"add",
				resolved,
				"--cache",
				cache,
				"--offline=false",
				"--ignore-scripts",
			],
			{ cwd: directory },
		);
	return cache;
}

async function fixture(parent = tmpdir()) {
	const directory = await mkdtemp(
		join(parent, "astro-function-plan-"),
	);
	directories.push(directory);
	const root = pathToFileURL(directory + "/");
	const outDir = new URL("dist/", root);
	const server = new URL("function/", outDir);
	const client = new URL("client/", outDir);
	await mkdir(server, { recursive: true });
	await mkdir(client, { recursive: true });
	const index = `
const loadFoo = () => import('./foo.js');
const loadBar = () => import('./bar.js');
const pageMap = new Map([['page:foo', loadFoo], ['page:bar', loadBar]]);
const serverIslandMap = new Map([]);
function handler(event, context, previewUrl, policy) { return policy; }
export { handler };
`;
	await writeFile(new URL("index.js", server), index);
	// Astro emits an ESM server; keep runtime checks independent of TMPDIR's package scope.
	await writeFile(
		new URL("package.json", server),
		'{"type":"module"}',
	);
	await writeFile(
		new URL("foo.js", server),
		"export const asset = new URL('./asset.bin', import.meta.url);\n",
	);
	await writeFile(
		new URL("bar.js", server),
		"export const bar = true;\n",
	);
	await writeFile(
		new URL("asset.bin", server),
		Buffer.from([0, 1, 127, 255]),
	);
	await writeFile(
		new URL("404.html", client),
		"<h1>Missing</h1>",
	);
	const build: FunctionArtifact.FunctionArtifactBuild = {
		config: {
			root,
			outDir,
			base: "/",
			build: { server, client },
		},
	};
	const routes: RoutePlan["routes"] = ["foo", "bar"].map(
		(name, priority) => ({
			kind: "on-demand" as const,
			routeKind: "page" as const,
			pattern: `/${name}`,
			priority,
			patternRegex: `^\\/${name}\\/?$`,
			origin: "project",
			artifactId: "function:shared" as Extract<
				RoutePlan["routes"][number],
				{ kind: "on-demand" }
			>["artifactId"],
		}),
	);
	routes.push({
		kind: "prerendered",
		routeKind: "page",
		pattern: "/404",
		priority: 2,
		patternRegex: "^\\/404\\/?$",
		paths: [
			{
				url: "/404",
				objectKey: "404.html",
				artifactId: "client:primary" as Extract<
					RoutePlan["routes"][number],
					{ kind: "prerendered" }
				>["paths"][number]["artifactId"],
			},
		],
	});
	const routePlan: RoutePlan = {
		base: "/",
		trailingSlash: "ignore",
		routes,
	};
	return {
		directory,
		root,
		server,
		client,
		build,
		routePlan,
		index,
	};
}

const settings = {
	dependencyStrategy: "bundle",
	recursive404: true,
} as const;

describe("Function Artifact mutation plans", () => {
	it.each([
		{
			resolved: "https://registry.example.test/child.tgz",
			owned: false,
		},
		{ resolved: "file:node_modules/other.tgz", owned: false },
		{ resolved: "file:node_modules/fork.tgz", owned: true },
		{ resolved: undefined, owned: false },
		{
			resolved: "file:node_modules/fork.tgz",
			owned: true,
			nested: true,
		},
		{
			resolved: "file:node_modules/other.tgz",
			owned: false,
			nested: true,
		},
		{
			resolved: "file:node_modules/fork.tgz",
			owned: false,
			nested: true,
			lockVersion: "2.0.0",
		},
		{
			resolved: "file:fork.tgz",
			owned: true,
			replacement: true,
		},
		{
			resolved: "file:node_modules/fork.tgz",
			owned: false,
			replacement: true,
		},
		{
			resolved: "file:fork.tgz",
			owned: true,
			wildcardOverride: true,
		},
		{
			resolved: "file:node_modules/helper/fork.tgz",
			owned: false,
			wildcardOverride: true,
		},
		{
			resolved: "file:fork.tgz",
			owned: false,
			registryRange: true,
			includeLocal: false,
		},
		{
			resolved: "file:fork.tgz",
			owned: true,
			registryRange: true,
		},
		{
			resolved: "file:fork.tgz",
			owned: false,
			registryRange: true,
			missing: true,
		},
		{
			resolved:
				"git+ssh://git@github.com/example/child.git#0123456789abcdef0123456789abcdef01234567",
			owned: false,
			registryRange: true,
			includeLocal: false,
		},
		{
			resolved:
				"git+ssh://git@github.com/example/child.git#0123456789abcdef0123456789abcdef01234567",
			owned: true,
			registryRange: true,
		},
	])(
		"packs local tarballs only with matching installed source evidence: %j",
		async ({
			resolved,
			owned,
			nested,
			replacement,
			wildcardOverride,
			lockVersion = "1.0.0",
			registryRange,
			includeLocal = true,
			missing,
		}) => {
			const f = await fixture();
			const plugin = {
				name: "plugin",
				version: "1.0.0",
				optionalDependencies: { helper: "^1" },
			};
			const helper = {
				name: "helper",
				version: "1.0.0",
				dependencies: {
					child:
						replacement || registryRange
							? "^1"
							: wildcardOverride
								? "file:./fork.tgz"
								: "file:../fork.tgz",
				},
			};
			const pluginPath = new URL("node_modules/plugin/", f.root);
			const childSlot = nested
				? "node_modules/helper/node_modules/child"
				: "node_modules/child";
			const childPath = new URL(childSlot + "/", f.root);
			if (replacement || wildcardOverride)
				await writeFile(
					new URL("package.json", f.root),
					JSON.stringify({
						overrides: {
							child: wildcardOverride ? "*" : "file:./fork.tgz",
						},
					}),
				);
			await mkdir(pluginPath, { recursive: true });
			await writeFile(
				new URL("package.json", pluginPath),
				JSON.stringify(plugin),
			);
			if (!missing) {
				await mkdir(childPath, { recursive: true });
				await writeFile(
					new URL("package.json", childPath),
					JSON.stringify({ name: "child", version: "1.0.0" }),
				);
				await writeFile(
					new URL("index.js", childPath),
					'module.exports = "installed child";',
				);
			}
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/plugin": plugin,
						"node_modules/helper": helper,
						...(resolved
							? {
									[childSlot]: {
										version: lockVersion,
										resolved,
									},
								}
							: {}),
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import "plugin";${f.index}`,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			expect(result._tag).toBe(owned ? "Right" : "Left");
			if (result._tag === "Left") return;
			const lock = result.right.mutations.find(
				(mutation) =>
					mutation.kind === "writeFile" &&
					mutation.path.pathname.endsWith("package-lock.json"),
			);
			if (lock?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			expect(lock.contents).toContain(".yandex/dependencies/");
			expect(lock.contents).not.toContain(resolved);
		},
	);

	it.each([
		"workspace",
		"standalone",
		"local reference",
		"restored workspace",
	] as const)(
		"uses the verified npm workspace root's overrides and the member's requirements: %s",
		async (mode) => {
			const workspace = await mkdtemp(
				join(tmpdir(), "yandex-npm-workspace-"),
			);
			directories.push(workspace);
			const f = await fixture(workspace);
			const member = relative(workspace, f.directory).replaceAll(
				"\\",
				"/",
			);
			const rootManifest = {
				name: "workspace-root",
				workspaces:
					mode === "restored workspace"
						? [
								"astro-function-plan-*",
								`!{restored,${member}}`,
								"restored",
							]
						: [
								mode === "standalone"
									? "some-other-directory/*"
									: "astro-function-plan-*",
							],
				dependencies: {
					carrier: "^2",
					replacement:
						mode === "local reference"
							? "file:../leaf.tgz"
							: "2.0.0",
				},
				overrides: { "carrier@^1": { leaf: "$replacement" } },
			};
			const application = {
				name: "workspace-member",
				dependencies: { carrier: "^1", replacement: "1.0.0" },
				overrides: { "carrier@^1": { leaf: "$replacement" } },
			};
			const carrier = {
				name: "carrier",
				version: "1.0.0",
				dependencies: { leaf: "^1" },
			};
			const leaf = {
				name: "leaf",
				version:
					mode === "workspace" || mode === "restored workspace"
						? "2.0.0"
						: "1.0.0",
			};
			await writeFile(
				join(workspace, "package.json"),
				JSON.stringify(rootManifest),
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify(application),
			);
			await mkdir(new URL("node_modules/carrier/", f.root), {
				recursive: true,
			});
			await mkdir(new URL("node_modules/leaf/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/carrier/package.json", f.root),
				JSON.stringify(carrier),
			);
			await writeFile(
				new URL("node_modules/leaf/package.json", f.root),
				JSON.stringify(leaf),
			);
			await writeFile(
				join(workspace, "package-lock.json"),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": rootManifest,
						[member]: application,
						"node_modules/workspace-member": {
							link: true,
							resolved: member,
						},
						[`${member}/node_modules/carrier`]: carrier,
						[`${member}/node_modules/leaf`]: leaf,
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import "carrier";${f.index}`,
			);
			const before = await snapshot(workspace);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(workspace)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			if (mode === "local reference") {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("includeLocal");
				return;
			}
			if (result._tag === "Left") throw result.left;
			const lock = result.right.mutations.find(
				(mutation) =>
					mutation.kind === "writeFile" &&
					mutation.path.pathname.endsWith("package-lock.json"),
			);
			if (lock?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			expect(JSON.parse(lock.contents)).toMatchObject({
				packages: {
					"node_modules/leaf": { version: leaf.version },
				},
			});
		},
	);

	it.each(
		["file:../local-child", "link:../local-child"].flatMap(
			(spec) =>
				[false, true].flatMap((installed) =>
					[false, true].map((includeLocal) => ({
						spec,
						installed,
						includeLocal,
					})),
				),
		),
	)(
		"preserves installed local contents below a lock-only optional parent: %j",
		async ({ spec, installed, includeLocal }) => {
			const f = await fixture();
			const plugin = {
				name: "plugin",
				version: "1.0.0",
				optionalDependencies: { helper: "^1" },
			};
			const helper = {
				name: "helper",
				version: "1.0.0",
				dependencies: { child: spec },
			};
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({ dependencies: { plugin: "1.0.0" } }),
			);
			const parent = new URL("node_modules/plugin/", f.root);
			await mkdir(parent, { recursive: true });
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify(plugin),
			);
			await writeFile(
				new URL("index.js", parent),
				"module.exports=require('helper');",
			);
			const helperSource = new URL("registry-helper/", f.root);
			await mkdir(helperSource, { recursive: true });
			await writeFile(
				new URL("package.json", helperSource),
				JSON.stringify(helper),
			);
			await writeFile(
				new URL("index.js", helperSource),
				"module.exports=require('child');",
			);
			const serveTarball = await serveFixtureTarballs();
			const metadata: Record<
				string,
				{ version: string; resolved: string; integrity: string }
			> = {};
			for (const [name, directory] of [
				["plugin", parent],
				["helper", helperSource],
			] as const) {
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						f.directory,
					],
					{ cwd: directory },
				);
				const filename = `${name}-1.0.0.tgz`;
				const bytes = await readFile(
					join(f.directory, filename),
				);
				metadata[name] = {
					version: "1.0.0",
					...serveTarball(filename, bytes),
				};
			}
			if (installed) {
				const child = new URL(
					"node_modules/helper/node_modules/child/",
					f.root,
				);
				await mkdir(child, { recursive: true });
				await writeFile(
					new URL("package.json", child),
					JSON.stringify({ name: "child", version: "1.0.0" }),
				);
				await writeFile(
					new URL("index.js", child),
					"module.exports='exact-local-child';",
				);
			}
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": { dependencies: { plugin: "1.0.0" } },
						"node_modules/plugin": {
							...plugin,
							...metadata.plugin,
						},
						"node_modules/helper": {
							...helper,
							...metadata.helper,
							optional: true,
						},
						"node_modules/helper/node_modules/child": {
							name: "child",
							version: "1.0.0",
							resolved: "file:node_modules/local-child",
						},
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'plugin';${f.index}`,
			);
			const resolve = vi.fn(() =>
				Promise.reject(
					new Error("No registry replacement allowed"),
				),
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			if (!installed || !includeLocal) {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("local");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") return;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			);
			expect(lock).toContain(".yandex/dependencies/");
			expect(lock).not.toContain(
				"file:node_modules/local-child",
			);
			const cache = await seedFixtureTarballCache(
				f.directory,
				Object.values(metadata),
			);
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--include=optional",
					"--offline",
					"--no-audit",
					"--no-fund",
					"--registry=http://127.0.0.1:1",
					"--cache",
					cache,
				],
				{ cwd: f.server },
			);
			const run = await promisify(execFile)(
				process.execPath,
				["-e", "console.log(require('plugin'))"],
				{ cwd: f.server },
			);
			expect(run.stdout.trim()).toBe("exact-local-child");
		},
	);

	it.each(
		(
			[
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const key='runtime';const {[key]:ignored,...copy}=ns;const {runtime:proc=process}=copy;",
				],
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const key=process.env.KEY ?? 'runtime';const {[key]:ignored,...copy}=ns;const {runtime:proc=process}=copy;",
				],
				[
					"export const runtime=process;",
					"import * as ns from './bridge.js';const flag=Math.random()<2;const selected=flag?ns:null;const proc=selected.runtime;",
				],
				[
					"export const runtime=process;",
					"import * as ns from './bridge.js';const selected=globalThis.missing||ns;const proc=selected.runtime;",
				],
				[
					"export const runtime={};",
					"import * as a from './bridge.js';import * as b from './other.js';const flag=Math.random()>2;const selected=flag?a:b;const {runtime:proc=process}=selected;",
				],
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const selected=Math.random()>2?ns:{};const {runtime:proc=process}=selected;",
				],
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const undefined={};const selected=Math.random()>2?ns:undefined;const {runtime:proc=process}=selected;",
				],
				[
					"export * as runtime from './other.js';",
					"import * as a from './bridge.js';import * as b from './process.js';const selected=Math.random()>2?a:b;const {runtime:proc}=selected;",
				],
			] as const
		).flatMap(([bridge, consumer]) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({
					bridge,
					consumer,
					dependencyStrategy,
				}),
			),
		),
	)(
		"never accepts a loader transferred through a namespace without its package: %j",
		async ({ bridge, consumer, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(new URL("bridge.js", f.server), bridge);
			await writeFile(
				new URL("other.js", f.server),
				"export const unrelated=1;",
			);
			await writeFile(
				new URL("process.js", f.server),
				"export const runtime=process;",
			);
			await writeFile(
				new URL("index.js", f.server),
				consumer +
					"export const packageValue=proc.getBuiltinModule('module').createRequire(import.meta.url)('example');" +
					f.index,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			await writeFile(
				new URL("node_modules/example/index.js", f.root),
				'module.exports = "loaded";',
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`const m=await import(${JSON.stringify(new URL("index.js", f.server).href)});process.stdout.write(m.packageValue);`,
				],
				{ cwd: f.directory },
			);
			expect(stdout).toBe("loaded");
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
						{
							resolve: () =>
								Promise.resolve({ version: "1.2.3" }),
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			if (result._tag === "Left") {
				expect(result.left.message).toMatch(
					/example|unresolved dynamic/,
				);
				return;
			}
			expect(dependencyStrategy).toBe("install");
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/example": { version: "1.2.3" },
				},
			});
		},
	);

	it.each(
		(
			[
				[
					"import * as proc from 'node:process';export {proc};",
					"import {proc} from './bridge.js';",
				],
				[
					"const runtime=globalThis.process;export default runtime;",
					"import proc from './bridge.js';",
				],
				[
					"export {runtime as proc} from './origin.js';",
					"import * as ns from './bridge.js';const {proc}=ns;",
				],
				[
					"export * from './origin.js';",
					"import {runtime as proc} from './bridge.js';",
				],
				[
					"export {runtime as proc} from './origin.js';",
					"import * as ns from './bridge.js';const {['proc']:proc}=ns;",
				],
				[
					"export * as ns from './origin.js';",
					"import {ns} from './bridge.js';const proc=ns.runtime;",
				],
				[
					"export const runtime=process;",
					"import {createRequire} from 'node:module';const {runtime:proc}=createRequire(import.meta.url)('./bridge.mjs');",
					"bridge.mjs",
				],
				[
					'const runtime=process;export {runtime as "module.exports"};',
					"import {createRequire} from 'node:module';const proc=createRequire(import.meta.url)('./bridge.mjs');",
					"bridge.mjs",
				],
				[
					'export {runtime as "module.exports"} from "./origin.js";',
					"import {createRequire} from 'node:module';const proc=createRequire(import.meta.url)('./bridge.mjs');",
					"bridge.mjs",
				],
				[
					'const value="ordinary";export {value as "module.exports"};export const runtime=process;',
					"import * as ns from './bridge.js';const proc=ns.runtime;",
				],
				[
					"export const runtime=process;",
					"import {createRequire} from 'node:module';const proc=createRequire(import.meta.url)('./bridge').runtime;",
				],
				[
					"export const runtime=process;export const label='fixture';",
					"import * as ns from './bridge.js';const {label,...copy}=ns;const proc=copy.runtime;",
				],
				[
					"export const runtime=process;",
					"import * as ns from './bridge.js';const {runtime:proc=null}=ns;",
				],
				[
					"export const runtime=process;export const label='fixture';",
					"import * as ns from './bridge.js';const {label,...copy}=ns;const {['runtime']:proc=null}=copy;",
				],
				[
					"export const label='fixture';",
					"import * as ns from './bridge.js';const {missing:proc=process}=ns;",
				],
				[
					"export const runtime=undefined;",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export const runtime=void 0;",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export let runtime={};runtime=undefined;",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"if(false){var runtime={}}export {runtime};",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export * from './ordinary-a.mjs';export * from './ordinary-b.mjs';",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export * from './ordinary-a.mjs?one';export * from './ordinary-a.mjs?two';",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export * from './ordinary-a.mjs#one';export * from './ordinary-a.mjs#two';",
					"import * as ns from './bridge.js';const {runtime:proc=process}=ns;",
				],
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const {...copy}=ns;copy.runtime=undefined;const {runtime:proc=process}=copy;",
				],
				[
					"export * as runtime from './ordinary-a.mjs';",
					"import * as ns from './bridge.js';const {...copy}=ns;copy.runtime=undefined;const {runtime:proc=process}=copy;",
				],
				[
					"export const runtime={};",
					"import * as ns from './bridge.js';const {...copy}=ns;function clear(o){o.runtime=undefined;}clear(copy);const {runtime:proc=process}=copy;",
				],
			] as const
		).flatMap(([bridge, consumer, file]) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({
					bridge,
					consumer,
					file,
					dependencyStrategy,
				}),
			),
		),
	)(
		"tracks process bindings across emitted modules: %j",
		async ({ bridge, consumer, file, dependencyStrategy }) => {
			const f = await fixture();
			const bridgeFile = file ?? "bridge.js";
			for (const ordinaryFile of [
				"ordinary-a.mjs",
				"ordinary-b.mjs",
			])
				await writeFile(
					new URL(ordinaryFile, f.server),
					"export const runtime={};",
				);
			await writeFile(
				new URL("origin.js", f.server),
				`export * from './${bridgeFile}';export const runtime=process;`,
			);
			await writeFile(new URL(bridgeFile, f.server), bridge);
			await writeFile(
				new URL("index.js", f.server),
				consumer +
					"export const packageValue=proc.getBuiltinModule('module').createRequire(import.meta.url)('example');" +
					f.index,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			if (
				bridge.includes('from "./origin.js"') ||
				bridge.includes("./ordinary-a.mjs?") ||
				bridge.includes("./ordinary-a.mjs#") ||
				bridge.startsWith("export * as runtime")
			) {
				await writeFile(
					new URL("node_modules/example/index.js", f.root),
					'module.exports = "interop fixture";',
				);
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"--eval",
						`const m=await import(${JSON.stringify(new URL("index.js", f.server).href)});process.stdout.write(m.packageValue);`,
					],
					{ cwd: f.directory },
				);
				expect(stdout).toBe("interop fixture");
			}
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
						{
							resolve: () =>
								Promise.resolve({ version: "1.2.3" }),
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			if (dependencyStrategy === "bundle") {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("example");
				return;
			}
			if (result._tag === "Left") throw result.left;
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/example": { version: "1.2.3" },
				},
			});
		},
	);

	it.each(
		(
			[
				"import * as ns from './bridge.mjs';",
				"import {createRequire} from 'node:module';const ns=createRequire(import.meta.url)('./bridge.mjs');",
				"import * as bridge from './bridge.mjs';const {...ns}=bridge;",
				"import * as ns from './origin.mjs';",
				"import * as ns from './imported.mjs';",
				"import * as ns from './diamond.mjs';",
				"import * as ns from './same-instance.mjs';",
				"import * as ns from './empty-query.mjs';",
				"import * as ns from './empty-fragment.mjs';",
			] as const
		).flatMap((consumer) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({
					consumer,
					dependencyStrategy,
				}),
			),
		),
	)(
		"keeps a defined ordinary export instead of its loader default: %j",
		async ({ consumer, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("bridge.mjs", f.server),
				'const ordinary={getBuiltinModule(name){return "ordinary:"+name}};export {ordinary as runtime};',
			);
			await writeFile(
				new URL("origin.mjs", f.server),
				"export {runtime} from './bridge.mjs';",
			);
			await writeFile(
				new URL("imported.mjs", f.server),
				"import {runtime as imported} from './bridge.mjs';export const runtime=imported;",
			);
			await writeFile(
				new URL("forward.mjs", f.server),
				"import {runtime as original} from './bridge.mjs';export {original as runtime};",
			);
			await writeFile(
				new URL("diamond.mjs", f.server),
				"export * from './bridge.mjs';export * from './origin.mjs';export * from './forward.mjs';",
			);
			await writeFile(
				new URL("same-instance.mjs", f.server),
				"export * from './bridge.mjs?one#same';export * from '././br%69dge.mjs?one#same';",
			);
			await writeFile(
				new URL("empty-query.mjs", f.server),
				"export * from './bridge.mjs';export * from './bridge.mjs?';",
			);
			await writeFile(
				new URL("empty-fragment.mjs", f.server),
				"export * from './bridge.mjs';export * from './bridge.mjs#';",
			);
			await writeFile(
				new URL("index.js", f.server),
				consumer +
					'const {runtime: proc = process}=ns; const name="custom";export const value=proc.getBuiltinModule(name);' +
					f.index,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy },
					{ resolve },
				),
			);
			expect(resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		["./optional%zz.mjs", "./optional%2Fmodule.mjs"].flatMap(
			(specifier) =>
				(["bundle", "install"] as const).map(
					(dependencyStrategy) => ({
						specifier,
						dependencyStrategy,
					}),
				),
		),
	)(
		"leaves undecodable optional local imports unresolved: %j",
		async ({ specifier, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`async function loadOptional() {
				try {
					const optional = await import(${JSON.stringify(specifier)});
					return optional.runtime;
				} catch {
					return undefined;
				}
			}
			export const optional = loadOptional();
			${f.index}`,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy },
					{ resolve },
				),
			);
			expect(resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		(
			[
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import * as ns from './bridge.mjs';const proc=ns[process.env.RUNTIME_EXPORT];",
					reject: true,
				},
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import {createRequire} from 'node:module';const ns=createRequire(import.meta.url)('./bridge.mjs');const proc=ns[process.env.RUNTIME_EXPORT];",
					reject: true,
				},
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import * as ns from './bridge.mjs';const {...copy}=ns;const proc=copy[process.env.RUNTIME_EXPORT];",
					reject: true,
				},
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import * as ns from './bridge.mjs';const {[process.env.RUNTIME_EXPORT]:proc}=ns;",
					reject: true,
				},
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import * as ns from './bridge.mjs';const {runtime,...copy}=ns;export const data=copy[process.env.RUNTIME_EXPORT];",
					reject: false,
				},
				{
					bridge:
						"export const runtime=process;export const label='fixture';",
					read: "import * as ns from './bridge.mjs';export const data=ns['label'];",
					reject: false,
				},
				{
					bridge: "export * from './other.mjs';",
					read: "import * as ns from './bridge.mjs';const proc=ns[process.env.RUNTIME_EXPORT];",
					reject: true,
				},
				{
					bridge: "export * as group from './other.mjs';",
					read: "import * as ns from './bridge.mjs';const proc=ns[process.env.RUNTIME_EXPORT].runtime;",
					reject: true,
				},
				{
					bridge: "export const label='fixture';",
					read: "import * as ns from './bridge.mjs';export const data=ns[process.env.RUNTIME_EXPORT];",
					reject: false,
				},
			] as const
		).flatMap((example) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({
					...example,
					dependencyStrategy,
				}),
			),
		),
	)(
		"guards unresolved computed reads of module namespaces: %j",
		async ({ bridge, read, reject, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(new URL("bridge.mjs", f.server), bridge);
			await writeFile(
				new URL("other.mjs", f.server),
				"export * from './bridge.mjs';export const runtime=process;",
			);
			await writeFile(
				new URL("index.js", f.server),
				read +
					(reject
						? "proc.getBuiltinModule('module').createRequire(import.meta.url)('example');"
						: "") +
					f.index,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy,
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(result._tag).toBe(reject ? "Left" : "Right");
			if (result._tag === "Left")
				expect(result.left.message).toContain(
					"namespace lookup must use a fixed property",
				);
		},
	);

	it.each(["bundle", "install"] as const)(
		"treats an ordinary CommonJS interop return as distinct from the ESM namespace (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("bridge.mjs", f.server),
				'const value={runtime:{getBuiltinModule(){return "local"}}};export {value as "module.exports"};export const runtime=process;',
			);
			await writeFile(
				new URL("index.js", f.server),
				"import {createRequire} from 'node:module';const {runtime}=createRequire(import.meta.url)('./bridge.mjs');export const getter=runtime.getBuiltinModule;" +
					f.index,
			);
			const before = await snapshot(f.directory);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"rejects a relative runtime require with no retained file (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				"import {createRequire} from 'node:module';createRequire(import.meta.url)('./missing');" +
					f.index,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(result._tag).toBe("Left");
			if (result._tag === "Left")
				expect(result.left.message).toContain("./missing");
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"prefers a retained exact file over a CommonJS .js fallback (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("bridge", f.server),
				"export const runtime={value:1};",
			);
			await writeFile(
				new URL("bridge.js", f.server),
				"export const runtime=process;",
			);
			await writeFile(
				new URL("index.js", f.server),
				"import {createRequire} from 'node:module';const {runtime}=createRequire(import.meta.url)('./bridge'); use(runtime.getBuiltinModule);" +
					f.index,
			);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
		},
	);

	it.each([
		{ version: "1.0.0", shared: false },
		{ version: "2.1.0", shared: false },
		{ version: "2.1.0", shared: true },
	])(
		"uses only compatible workspace children of a lock-only optional parent: %j",
		async ({ version, shared }) => {
			const f = await fixture();
			await mkdir(new URL("node_modules/plugin/", f.root), {
				recursive: true,
			});
			await mkdir(
				new URL("node_modules/helper/node_modules/", f.root),
				{ recursive: true },
			);
			const plugin = {
				name: "plugin",
				version: "1.0.0",
				optionalDependencies: { helper: "^1" },
			};
			await writeFile(
				new URL("node_modules/plugin/package.json", f.root),
				JSON.stringify(plugin),
			);
			const childRoot = new URL("packages/child/", f.root);
			await mkdir(childRoot, { recursive: true });
			const childSlot = shared
				? "node_modules/child"
				: "node_modules/helper/node_modules/child";
			await symlink(
				childRoot,
				new URL(childSlot, f.root),
				"dir",
			);
			await writeFile(
				new URL("package.json", childRoot),
				JSON.stringify({ name: "child", version }),
			);
			await writeFile(
				new URL("index.js", childRoot),
				"module.exports='local contents';",
			);
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/plugin": plugin,
						"node_modules/helper": {
							name: "helper",
							version: "1.0.0",
							optional: true,
							dependencies: {
								child: shared ? "^2" : "workspace:^2",
							},
						},
						[childSlot]: {
							link: true,
							resolved: "packages/child",
						},
						"packages/child": { name: "child", version },
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				"import 'plugin';" +
					(shared ? "import 'child';" : "") +
					f.index,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.resolve({
					version: "2.1.0",
					resolved: "https://example.test/child.tgz",
				}),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal: true,
						},
						{ resolve },
					),
				),
			);
			expect(resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
			if (version === "1.0.0") {
				expect(result._tag).toBe("Left");
				return;
			}
			if (result._tag === "Left") throw result.left;
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			if (lock?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			expect(lock.contents).toContain(".yandex/dependencies");
			expect(lock.contents).not.toContain(
				"https://example.test/child.tgz",
			);
			if (shared) {
				expect(
					JSON.parse(lock.contents) as unknown,
				).toMatchObject({
					packages: { "node_modules/child": { version } },
				});
				expect(lock.contents).not.toContain(
					"node_modules/helper/node_modules/child",
				);
			}
		},
	);

	it.each(["bundle", "install"] as const)(
		"preserves ordinary namespace members alongside process exports (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("bridge.js", f.server),
				"export * from './other.js';export const ordinary={getBuiltinModule(){return 'local'}};",
			);
			await writeFile(
				new URL("other.js", f.server),
				"export * from './bridge.js';export const runtime=process;export const ordinary=process;",
			);
			await writeFile(
				new URL("index.js", f.server),
				"import * as ns from './bridge.js';export const data=[ns.ordinary.getBuiltinModule('custom'),ns.runtime.env];" +
					f.index,
			);
			const before = await snapshot(f.directory);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		(["bundle", "install"] as const).flatMap(
			(dependencyStrategy) =>
				(["import", "dynamic import", "require"] as const).map(
					(loader) => ({ dependencyStrategy, loader }),
				),
		),
	)(
		"accounts for extensionless emitted ES modules ($loader, $dependencyStrategy)",
		async ({ dependencyStrategy, loader }) => {
			const f = await fixture();
			await writeFile(
				new URL("runtime-helper", f.server),
				"import 'example';export const ready=true;",
			);
			await writeFile(
				new URL("opaque-asset", f.server),
				Buffer.from([0, 255, 1, 0]),
			);
			await writeFile(
				new URL("index.js", f.server),
				{
					import: "import './runtime-helper';",
					"dynamic import": "await import('./runtime-helper');",
					require:
						"import {createRequire} from 'node:module'; createRequire(import.meta.url)('./runtime-helper');",
				}[loader] + f.index,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
						{
							resolve: () =>
								Promise.resolve({ version: "1.2.3" }),
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(result._tag).toBe(
				dependencyStrategy === "bundle" ? "Left" : "Right",
			);
			if (result._tag === "Left")
				expect(result.left.message).toContain("example");
			else {
				const lock = result.right.mutations.find(
					(m) =>
						m.kind === "writeFile" &&
						m.path.pathname.endsWith("package-lock.json"),
				);
				expect(
					lock?.kind === "writeFile" &&
						JSON.parse(lock.contents),
				).toMatchObject({
					packages: {
						"node_modules/example": { version: "1.2.3" },
					},
				});
			}
		},
	);

	it.each([
		"new URL",
		"import.meta.resolve",
		"require.resolve",
	] as const)(
		"keeps a parseable extensionless text asset through %s",
		async (operation) => {
			const f = await fixture();
			const contents = "require(theme)";
			await writeFile(new URL("template", f.server), contents);
			const preamble =
				'import { readFileSync } from "node:fs"; import { createRequire } from "node:module";';
			const target =
				operation === "new URL"
					? 'new URL("./template", import.meta.url)'
					: operation === "import.meta.resolve"
						? 'new URL(import.meta.resolve("./template"))'
						: 'createRequire(import.meta.url).resolve("./template")';
			await writeFile(
				new URL("index.js", f.server),
				`${preamble} export const text = readFileSync(${target}, "utf8");\n${f.index}`,
			);
			const check = async (cwd: string) => {
				const result = await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						'import { text } from "./index.js"; console.log(text);',
					],
					{ cwd },
				);
				expect(result.stdout.trim()).toBe(contents);
			};
			await check(fileURLToPath(f.server));
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
				}),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "extensionless-text-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			await check(isolated);
		},
	);

	it.each([
		{ file: "optional", dynamic: true, accepted: true },
		{
			file: "nested/esm/optional",
			dynamic: true,
			accepted: true,
		},
		{
			file: "nested/optional",
			dynamic: true,
			accepted: true,
			source: "module.exports = ;",
		},
		{
			file: "nested/optional",
			dynamic: true,
			accepted: true,
			source: "export const ready = true;",
			manifest: "{",
		},
		{
			file: "nested/optional",
			dynamic: false,
			accepted: false,
			source: "export const ready = true;",
			manifest: "{",
			rejection: /in JSON at position/,
		},
		{ file: "optional", dynamic: false, accepted: false },
		{ file: "optional.mjs", dynamic: true, accepted: false },
	])(
		"preserves an optional extensionless import fallback ($file, dynamic: $dynamic, manifest: $manifest)",
		async ({
			file,
			dynamic,
			accepted,
			source: contents = "export const broken = ;",
			manifest = '{"type":"commonjs"}',
			rejection = /Unexpected token/,
		}) => {
			const f = await fixture();
			if (file.startsWith("nested/")) {
				await mkdir(new URL("nested/esm/", f.server), {
					recursive: true,
				});
				await writeFile(
					new URL("nested/package.json", f.server),
					manifest,
				);
				await writeFile(
					new URL("nested/esm/package.json", f.server),
					'{"type":"module"}',
				);
			}
			await writeFile(new URL(file, f.server), contents);
			const request = JSON.stringify("./" + file);
			const source = dynamic
				? `export async function observe() { try { const loaded = await import(${request}); return loaded.default; } catch (error) { if (!(error instanceof SyntaxError) && error?.code !== "ERR_INVALID_PACKAGE_CONFIG") throw error; return "fallback"; } }`
				: `import ${request};`;
			await writeFile(
				new URL("index.js", f.server),
				source + f.index,
			);
			const check = async (cwd: string) => {
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						'import { observe } from "./index.js"; console.log(await observe());',
					],
					{ cwd },
				);
				expect(stdout.trim()).toBe("fallback");
			};
			if (accepted) await check(fileURLToPath(f.server));
			const before = await snapshot(f.directory);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
				}),
			);
			if (!accepted) {
				await expect(planning).rejects.toThrow(rejection);
				expect(await snapshot(f.directory)).toEqual(before);
				return;
			}
			const plan = await planning;
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "optional-extensionless-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			await check(isolated);
		},
	);

	const ordinaryRequire = 'module.exports = require("example");';
	// The nodejs22 runtime classifies an extensionless require target by its syntax.
	// Node 26 applies the package type instead, so only an older host can witness it.
	const hostRequireMatchesRuntime =
		Number(process.versions.node.split(".")[0]) < 26;
	const aliasedRequire =
		'const load = require; module.exports = load("example");';
	it.each([
		{
			metadata: { type: "commonjs" },
			syntax: "wrapper return",
			source: `${ordinaryRequire} return;`,
		},
		{
			metadata: { type: "commonjs" },
			syntax: "ordinary require",
			source: ordinaryRequire,
		},
		{
			metadata: {},
			syntax: "wrapper return",
			source: `${ordinaryRequire} return;`,
		},
		{
			metadata: {},
			syntax: "ordinary require",
			source: ordinaryRequire,
		},
		{
			metadata: {},
			syntax: "aliased require",
			source: aliasedRequire,
		},
		{
			metadata: {},
			syntax: "var redeclaration",
			source:
				'var require = module.require.bind(module); module.exports = require("example");',
		},
		{
			directory: "vendor/node_modules/demo/",
			syntax: "aliased require",
			source: aliasedRequire,
		},
		{
			directory: "",
			loader: "require",
			syntax: "aliased require",
			source: aliasedRequire,
		},
		{
			directory: "",
			loader: "import then require",
			syntax: "aliased require",
			source: aliasedRequire,
		},
		{
			metadata: { type: "commonjs" },
			file: "helper.js",
			syntax: "aliased require",
			source: aliasedRequire,
		},
		{
			metadata: {},
			file: "helper.js",
			syntax: "aliased require",
			source: aliasedRequire,
		},
	])(
		"rejects a CommonJS module ($directory$file, $metadata, $loader, $syntax)",
		async ({
			directory = "nested/",
			metadata,
			loader = "import",
			file = "optional",
			source,
		}) => {
			const f = await fixture();
			await mkdir(new URL(directory, f.server), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", f.server),
				'{"type":"module"}',
			);
			if (metadata)
				await writeFile(
					new URL(`${directory}package.json`, f.server),
					JSON.stringify(metadata),
				);
			await writeFile(
				new URL(`${directory}${file}`, f.server),
				source,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			await writeFile(
				new URL("node_modules/example/index.js", f.root),
				'module.exports = "loaded";',
			);
			await writeFile(
				new URL("index.js", f.server),
				{
					import: `export async function observe() { return (await import("./${directory}${file}")).default; }`,
					require: `import { createRequire } from "node:module"; export function observe() { return createRequire(import.meta.url)("./${directory}${file}"); }`,
					"import then require": `import { createRequire } from "node:module"; export async function observe() { try { await import("./${directory}${file}"); } catch (error) { if (!(error instanceof ReferenceError)) throw error; } return createRequire(import.meta.url)("./${directory}${file}"); }`,
				}[loader] + `\n${f.index}`,
			);
			if (loader === "import" || hostRequireMatchesRuntime) {
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						'import { observe } from "./index.js"; console.log(await observe());',
					],
					{ cwd: fileURLToPath(f.server) },
				);
				expect(stdout.trim()).toBe("loaded");
			}
			const before = await snapshot(f.directory);
			await expect(
				Effect.runPromise(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
					),
				),
			).rejects.toThrow(
				`unsupported CommonJS module at ${directory}${file}.`,
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		...[
			'const __filename = "entry";',
			"let require;",
			"const { nested: [module] } = { nested: [] };",
			"class exports {}",
		].map((declaration) => ({
			directory: "nested/",
			manifest: "{}",
			declaration,
		})),
		{
			directory: "vendor/node_modules/demo/",
			manifest: '{"type":"module"}',
			declaration: "/* explicit ESM scope */",
		},
	])(
		"loads an extensionless file in $directory as ESM ($manifest, $declaration)",
		async ({ directory, manifest, declaration }) => {
			const f = await fixture();
			await mkdir(new URL(directory, f.server), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", f.server),
				'{"type":"module"}',
			);
			await writeFile(
				new URL(`${directory}package.json`, f.server),
				manifest,
			);
			await writeFile(
				new URL(`${directory}shadowing`, f.server),
				`${declaration} globalThis.example = import("example");`,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			await writeFile(
				new URL("node_modules/example/index.js", f.root),
				'module.exports = "loaded";',
			);
			await writeFile(
				new URL("index.js", f.server),
				`export async function observe() { await import("./${directory}shadowing"); return (await globalThis.example).default; }\n${f.index}`,
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import { observe } from "./index.js"; console.log(await observe());',
				],
				{ cwd: fileURLToPath(f.server) },
			);
			expect(stdout.trim()).toBe("loaded");
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: () => Promise.resolve({ version: "1.2.3" }),
					},
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			const lock = plan.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/example": { version: "1.2.3" },
				},
			});
		},
	);

	it.each(
		["process", "node:process"].flatMap((specifier) =>
			[false, true].flatMap((namespace) =>
				(["bundle", "install"] as const).map(
					(dependencyStrategy) => ({
						specifier,
						namespace,
						dependencyStrategy,
					}),
				),
			),
		),
	)(
		"rejects direct process object reexports across emitted modules: %j",
		async ({ specifier, namespace, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("bridge.js", f.server),
				namespace
					? `export * as proc from '${specifier}';`
					: `export {default as proc} from '${specifier}';`,
			);
			await writeFile(
				new URL("index.js", f.server),
				`import {proc} from './bridge.js';proc.getBuiltinModule('module').createRequire(import.meta.url)('node:path');${f.index}`,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(result).toMatchObject({ _tag: "Left" });
			if (result._tag === "Left")
				expect(result.left.message).toContain(
					"Node loader re-exports cannot be tracked across modules",
				);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([false, true])(
		"preserves a nested helper's absent optional peer across a hoist barrier (conflict: %s)",
		async (conflict) => {
			const f = await fixture();
			const manifests = {
				"node_modules/alpha": {
					name: "alpha",
					version: "1.0.0",
					dependencies: { helper: "1.0.0", shared: "1.0.0" },
				},
				"node_modules/alpha/node_modules/helper": {
					name: "helper",
					version: "1.0.0",
					peerDependencies: { shared: "^1", host: "^1" },
					peerDependenciesMeta: { host: { optional: true } },
				},
				"node_modules/alpha/node_modules/shared": {
					name: "shared",
					version: "1.0.0",
				},
				"node_modules/shared": {
					name: "shared",
					version: "2.0.0",
				},
				"node_modules/beta": {
					name: "beta",
					version: "1.0.0",
					...(conflict
						? { dependencies: { host: "2.0.0" } }
						: {}),
				},
				...(conflict
					? {
							"node_modules/beta/node_modules/host": {
								name: "host",
								version: "2.0.0",
							},
						}
					: {}),
			};
			for (const [path, manifest] of Object.entries(manifests)) {
				const directory = new URL(path + "/", f.root);
				await mkdir(directory, { recursive: true });
				await writeFile(
					new URL("package.json", directory),
					JSON.stringify(manifest),
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`import 'alpha';import 'beta';import 'shared';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (_name, version) =>
							Promise.resolve({ version }),
					},
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			const lock = plan.mutations.find(
				(mutation) =>
					mutation.kind === "writeFile" &&
					mutation.path.pathname.endsWith("package-lock.json"),
			);
			if (lock?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			const { packages } = JSON.parse(lock.contents) as {
				packages: Record<string, unknown>;
			};
			expect(
				packages["node_modules/alpha/node_modules/helper"],
			).toMatchObject({
				peerDependencies: { host: "^1", shared: "1.0.0" },
			});
			expect(packages).not.toHaveProperty("node_modules/host");
			expect(packages).not.toHaveProperty(
				"node_modules/alpha/node_modules/host",
			);
			if (conflict)
				expect(
					packages["node_modules/beta/node_modules/host"],
				).toMatchObject({ version: "2.0.0" });
		},
	);

	it.each([
		"absent-compatible",
		"absent-incompatible",
		"unreserved",
		"inherited",
	])(
		"preserves explicit optional peer absence when an optional helper needs a peer (%s)",
		async (mode) => {
			const f = await fixture();
			const reserved = mode.startsWith("absent-");
			const plugin = {
				name: "plugin",
				version: "1.0.0",
				optionalDependencies: { helper: "^1" },
				...(reserved
					? {
							peerDependencies: {
								host: mode === "absent-compatible" ? "^1" : "^2",
							},
							peerDependenciesMeta: { host: { optional: true } },
						}
					: {}),
			};
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					dependencies: {
						plugin: "1.0.0",
						...(mode === "inherited" ? { host: "2.0.0" } : {}),
					},
				}),
			);
			const directory = new URL("node_modules/plugin/", f.root);
			await mkdir(directory, { recursive: true });
			await writeFile(
				new URL("package.json", directory),
				JSON.stringify(plugin),
			);
			if (mode === "inherited") {
				const host = new URL("node_modules/host/", f.root);
				await mkdir(host, { recursive: true });
				await writeFile(
					new URL("package.json", host),
					JSON.stringify({ name: "host", version: "2.0.0" }),
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`${mode === "inherited" ? "import 'host';" : ""}import 'plugin';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (name, range) =>
								Promise.resolve(
									name === "plugin"
										? plugin
										: name === "helper"
											? {
													version: "1.0.0",
													peerDependencies: { host: "^1" },
												}
											: {
													version:
														range === "2.0.0"
															? "2.0.0"
															: "1.0.0",
												},
								),
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			if (reserved) {
				expect(result).toMatchObject({
					_tag: "Left",
					left: { _tag: "UnresolvedDependency" },
				});
				if (result._tag === "Left")
					expect(result.left.message).toContain("host");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") return;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as { packages: Record<string, { version?: string }> };
			expect(
				lock.packages[
					mode === "inherited"
						? "node_modules/plugin/node_modules/host"
						: "node_modules/host"
				]?.version,
			).toBe("1.0.0");
			if (mode === "inherited")
				expect(lock.packages["node_modules/host"]?.version).toBe(
					"2.0.0",
				);
		},
	);

	it.each(
		["parent", "alias-first"].flatMap((importMode) =>
			[false, true].flatMap((registryOverride) =>
				[false, true].map((includeLocal) => ({
					importMode,
					registryOverride,
					includeLocal,
				})),
			),
		),
	)(
		"uses the nested binding owner's override context independently of visit order: %j",
		async ({ importMode, registryOverride, includeLocal }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies:
						importMode === "parent"
							? { parent: "1.0.0" }
							: { a: "npm:child@1.0.0", z: "npm:parent@1.0.0" },
					...(registryOverride
						? {
								overrides: {
									[importMode === "parent" ? "parent" : "z"]: {
										leaf: "1.0.0",
									},
								},
							}
						: {}),
				}),
			);
			for (const [path, name, deps] of [
				[
					"parent",
					"parent",
					{ child: "1.0.0", leaf: "github:owner/leaf#main" },
				],
				["parent/node_modules/child", "child", { leaf: "^1" }],
				["parent/node_modules/leaf", "leaf", {}],
			] as const) {
				const dir = new URL(`node_modules/${path}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({
						name,
						version: "1.0.0",
						dependencies: deps,
					}),
				);
				await writeFile(
					new URL("index.js", dir),
					name === "leaf"
						? "module.exports={value:'selected-local'};"
						: name === "child"
							? "module.exports=require('leaf');"
							: "const leaf=require('leaf');module.exports=leaf.value+':'+(leaf===require('child'));",
				);
			}
			if (importMode === "alias-first") {
				await symlink(
					new URL(
						"node_modules/parent/node_modules/child/",
						f.root,
					),
					new URL("node_modules/a", f.root),
					"dir",
				);
				await symlink(
					new URL("node_modules/parent/", f.root),
					new URL("node_modules/z", f.root),
					"dir",
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`import '${importMode === "parent" ? "parent" : "a"}';${f.index}`,
			);

			const metadata: Record<
				string,
				{
					version: string;
					resolved?: string;
					integrity?: string;
				}
			> = {};
			if (includeLocal && !registryOverride) {
				for (const name of ["parent", "child"]) {
					const dir = join(
						f.directory,
						"node_modules/parent",
						name === "child" ? "node_modules/child" : "",
					);
					await promisify(execFile)(
						"npm",
						[
							"pack",
							"--ignore-scripts",
							"--pack-destination",
							f.directory,
						],
						{ cwd: dir },
					);
					const tarball = join(f.directory, `${name}-1.0.0.tgz`);
					metadata[name] = {
						version: "1.0.0",
						resolved: pathToFileURL(tarball).href,
						integrity:
							"sha512-" +
							createHash("sha512")
								.update(await readFile(tarball))
								.digest("base64"),
					};
				}
			}
			const resolve = vi.fn((name: string, version: string) =>
				Promise.resolve({ ...metadata[name], version }),
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			if (!registryOverride && !includeLocal) {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("includeLocal");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") return;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			);
			if (registryOverride)
				expect(lock).not.toContain(".yandex/dependencies/");
			else expect(lock).toContain(".yandex/dependencies/");
			if (!registryOverride) {
				// Run outside the fixture so module resolution cannot fall back to source packages.
				const isolated = await mkdtemp(
					join(tmpdir(), "artifact-install-"),
				);
				directories.push(isolated);
				await cp(f.server, isolated, { recursive: true });
				await promisify(execFile)(
					"npm",
					[
						"ci",
						"--offline",
						"--no-audit",
						"--no-fund",
						"--registry=http://127.0.0.1:1",
					],
					{ cwd: isolated },
				);
				const expression =
					importMode === "parent"
						? "console.log(require('parent'))"
						: "console.log(require('a').value)";
				const run = await promisify(execFile)(
					process.execPath,
					["-e", expression],
					{ cwd: isolated },
				);
				expect(run.stdout.trim()).toBe(
					importMode === "parent"
						? "selected-local:true"
						: "selected-local",
				);
			}
		},
	);

	it.each(["parent", "leaf"])(
		"uses a registry override for a root Git binding reached through %s",
		async (imported) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					dependencies: {
						parent: "1.0.0",
						leaf: "github:owner/leaf#main",
					},
					overrides: { leaf: "1.0.0" },
				}),
			);
			for (const name of ["parent", "leaf"]) {
				const dir = new URL(`node_modules/${name}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({
						name,
						version: "1.0.0",
						...(name === "parent"
							? { dependencies: { leaf: "^1" } }
							: {}),
					}),
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`import '${imported}';${f.index}`,
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (_name: string, version: string) =>
							Promise.resolve({ version }),
					},
				),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
		},
	);

	it.each(
		[
			"hoisted",
			"hoisted-alias",
			"override",
			"app-bundle-list",
			"app-bundle-all",
		].flatMap((mode) =>
			(mode.startsWith("app-bundle")
				? ["github:owner/leaf#main"]
				: [
						"github:owner/leaf#main",
						"https://example.test/leaf.tgz",
						"file:../leaf",
						"workspace:*",
					]
			).flatMap((spec) =>
				[false, true].map((includeLocal) => ({
					mode,
					spec,
					includeLocal,
				})),
			),
		),
	)(
		"preserves installed binding provenance across runtime edges: %j",
		async ({ mode, spec, includeLocal }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: {
						parent: "1.0.0",
						...(mode === "hoisted" ||
						mode.startsWith("app-bundle")
							? { leaf: spec }
							: mode === "hoisted-alias"
								? { "local-leaf": spec }
								: {}),
					},
					...(mode === "app-bundle-list"
						? { bundleDependencies: ["leaf"] }
						: mode === "app-bundle-all"
							? { bundleDependencies: true }
							: {}),
					...(mode === "override"
						? { overrides: { leaf: spec } }
						: {}),
				}),
			);
			for (const [name, manifest] of Object.entries({
				parent: {
					version: "1.0.0",
					dependencies: { leaf: "^1" },
				},
				leaf: { version: "1.0.0" },
			})) {
				const dir = new URL(`node_modules/${name}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({ name, ...manifest }),
				);
				await writeFile(
					new URL("index.js", dir),
					name === "parent"
						? "module.exports=require('leaf');"
						: "module.exports='exact-local';",
				);
			}
			if (mode === "hoisted-alias")
				await symlink(
					new URL("node_modules/leaf/", f.root),
					new URL("node_modules/local-leaf", f.root),
					"dir",
				);
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';${f.index}`,
			);
			const leafRegistry = vi.fn(() =>
				Promise.reject(
					new Error(
						"Registry substitution for selected local leaf",
					),
				),
			);

			let parentMetadata: {
				version: string;
				resolved?: string;
				integrity?: string;
			} = { version: "1.0.0" };
			if (includeLocal) {
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						f.directory,
					],
					{ cwd: join(f.directory, "node_modules/parent") },
				);
				const tarball = join(f.directory, "parent-1.0.0.tgz");
				parentMetadata = {
					version: "1.0.0",
					resolved: pathToFileURL(tarball).href,
					integrity:
						"sha512-" +
						createHash("sha512")
							.update(await readFile(tarball))
							.digest("base64"),
				};
			}
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{
							resolve: (name: string, version: string) =>
								name === "leaf"
									? leafRegistry()
									: Promise.resolve({
											...parentMetadata,
											version,
										}),
						},
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			if (!includeLocal) {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("includeLocal");
				return;
			}
			expect(result._tag).toBe("Right");
			expect(leafRegistry).not.toHaveBeenCalled();
			if (result._tag !== "Right") return;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			);
			expect(lock).toContain(".yandex/dependencies/");
			// Run outside the fixture so module resolution cannot fall back to source packages.
			const isolated = await mkdtemp(
				join(tmpdir(), "artifact-install-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--offline",
					"--no-audit",
					"--no-fund",
					"--registry=http://127.0.0.1:1",
				],
				{ cwd: isolated },
			);
			const executed = await promisify(execFile)(
				process.execPath,
				["-e", "console.log(require('parent'))"],
				{ cwd: isolated },
			);
			expect(executed.stdout.trim()).toBe("exact-local");
		},
	);

	it.each([
		{
			spec: "github:owner/parent#main",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "git+https://example.test/parent.git#abcdef",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "owner/parent#v1.0.0",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "git+ssh://git@example.test/parent.git#main",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "https://github.com/owner/parent#main",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "github:owner/parent#semver:^3",
			key: "parent@^1",
			leaf: "1.0.0",
		},
		{
			spec: "github:owner/parent#semver:^1",
			key: "parent@^1",
			leaf: "2.0.0",
		},
		{
			spec: "github:owner/parent#main",
			key: "parent",
			leaf: "2.0.0",
		},
		{
			spec: "github:owner/parent#main",
			key: "parent@^1",
			field: "devDependencies",
			leaf: "1.0.0",
		},
		{
			spec: "github:owner/parent#main",
			key: "parent@^1",
			field: "peerDependencies",
			leaf: "1.0.0",
		},
		{ spec: "next", key: "parent@^1", leaf: "2.0.0" },
		{ spec: "file:../parent", key: "parent@^1", leaf: "2.0.0" },
	])(
		"matches Git override qualifiers without widening commit/tag requirements: %j",
		async ({ spec, key, leaf, field = "dependencies" }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					[field]: { parent: spec },
					overrides: { [key]: { leaf: "2.0.0" } },
				}),
			);
			for (const [name, manifest] of Object.entries({
				parent: {
					version: "1.0.0",
					dependencies: { leaf: "^1" },
				},
				leaf: { version: leaf },
			})) {
				const dir = new URL(`node_modules/${name}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({ name, ...manifest }),
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';${f.index}`,
			);
			const resolve = vi.fn((_name: string, version: string) =>
				Promise.resolve({ version }),
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{
						...settings,
						dependencyStrategy: "install",
						includeLocal: true,
					},
					{ resolve },
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as {
				packages: Record<
					string,
					{
						version?: string;
						dependencies?: Record<string, string>;
					}
				>;
			};
			const entries = Object.entries(lock.packages).filter(
				([path]) => path.endsWith("node_modules/leaf"),
			);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.[1].version).toBe(leaf);
		},
	);

	it.each([
		{
			rule: { leaf: "2.0.0" },
			key: "parent@^1",
			accepted: true,
		},
		{
			rule: { ".": "~1.2.0", leaf: "2.0.0" },
			key: "parent@^1",
			accepted: false,
		},
		{
			rule: { leaf: "2.0.0" },
			key: "parent@*",
			accepted: false,
		},
	])(
		"applies the matched override range without a replacement value: $key $rule",
		async ({ rule, key, accepted }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { carrier: "1.0.0" },
					overrides: { [key]: rule },
				}),
			);
			for (const [name, manifest] of Object.entries({
				carrier: {
					version: "1.0.0",
					dependencies: { parent: "~1.2.0" },
				},
				parent: { version: "1.9.0" },
			})) {
				const dir = new URL(`node_modules/${name}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({ name, ...manifest }),
				);
			}
			await writeFile(
				new URL("index.js", f.server),
				`import 'carrier';${f.index}`,
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (_name: string, version: string) =>
								Promise.resolve({ version }),
						},
					),
				),
			);
			if (!accepted) {
				expect(result._tag).toBe("Left");
				return;
			}
			if (result._tag === "Left") throw result.left;
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/parent": { version: "1.9.0" },
				},
			});
		},
	);

	it.each([
		"file:../host",
		"link:../host",
		"workspace:*",
		"github:owner/host#main",
		"https://example.test/host.tgz",
	])(
		"classifies installed runtime peers before plugin dev requirements: %s",
		async (dev) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { plugin: "1.0.0", host: "^1" },
				}),
			);
			for (const [name, manifest] of Object.entries({
				plugin: {
					version: "1.0.0",
					peerDependencies: { host: "^1" },
					devDependencies: { host: dev },
				},
				host: { version: "1.0.0" },
			})) {
				const dir = new URL(`node_modules/${name}/`, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({ name, ...manifest }),
				);
			}
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/plugin": {
							version: "1.0.0",
							peerDependencies: { host: "^1" },
						},
						"node_modules/host": {
							version: "1.0.0",
							resolved: "https://registry.example/host.tgz",
							integrity: "sha512-host",
						},
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'plugin';${f.index}`,
			);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{ resolve },
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			);
			expect(JSON.parse(lock) as unknown).toMatchObject({
				packages: {
					"node_modules/host": {
						version: "1.0.0",
						resolved: "https://registry.example/host.tgz",
						integrity: "sha512-host",
					},
				},
			});
			expect(lock).not.toContain(".yandex/dependencies");
		},
	);

	it.each(
		["file:../host", "workspace:*"].flatMap((dev) =>
			[false, true].map((peer) => ({ dev, peer })),
		),
	)(
		"retains the application's dev-local runtime source boundary: %j",
		async ({ dev, peer }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					devDependencies: { host: dev },
					...(peer ? { peerDependencies: { host: "^1" } } : {}),
				}),
			);
			await mkdir(new URL("node_modules/host/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/host/package.json", f.root),
				JSON.stringify({ name: "host", version: "1.0.0" }),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'host';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: () =>
								Promise.reject(
									new Error("Unexpected registry lookup"),
								),
						},
					),
				),
			);
			expect(result._tag).toBe("Left");
			if (result._tag === "Left")
				expect(result.left.message).toContain("includeLocal");
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		{ includeLocal: false, ancestorPnpm: false },
		{ includeLocal: true, ancestorPnpm: false },
		{ includeLocal: true, ancestorPnpm: true },
	])(
		"honors the root dev tarball over the production range: %j",
		async ({ includeLocal, ancestorPnpm }) => {
			let ancestor: string | undefined;
			if (ancestorPnpm) {
				ancestor = await mkdtemp(
					join(tmpdir(), "unrelated-pnpm-"),
				);
				directories.push(ancestor);
				await mkdir(join(ancestor, "node_modules"));
				await writeFile(
					join(ancestor, "node_modules", ".modules.yaml"),
					"layoutVersion: 5\n",
				);
			}
			const f = await fixture(ancestor);
			const parent = new URL("node_modules/parent/", f.root);
			const resolved = "file:../parent-2.0.0.tgz";
			await mkdir(parent, { recursive: true });
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify({
					name: "parent",
					version: "2.0.0",
					main: "index.cjs",
				}),
			);
			await writeFile(
				new URL("index.cjs", parent),
				'module.exports = "local parent";',
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					dependencies: { parent: "^1" },
					devDependencies: { parent: resolved },
				}),
			);
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/parent": {
							version: "2.0.0",
							resolved,
						},
					},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import "parent";${f.index}`,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			if (!includeLocal) {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toContain("includeLocal");
				return;
			}
			if (result._tag === "Left") throw result.left;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			);
			expect(lock).toContain(".yandex/dependencies");
			expect(lock).not.toContain(resolved);
			// Run outside the fixture so module resolution cannot fall back to source packages.
			const isolated = await mkdtemp(
				join(tmpdir(), "artifact-install-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--offline",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				["-e", 'process.stdout.write(require("parent"))'],
				{ cwd: isolated },
			);
			expect(stdout).toBe("local parent");
		},
	);

	it.each([
		{
			requirement: "file:../child.tgz",
			version: "1.0.0-beta.1",
			accepted: true,
		},
		{
			requirement: "file:../child.tgz",
			version: "1.0.0",
			accepted: true,
		},
		{
			requirement: "workspace:^1",
			version: "1.0.0-beta.1",
			accepted: false,
		},
	])(
		"pins exact local versions under the declared constraint: %j",
		async ({ requirement, version, accepted }) => {
			const f = await fixture();
			const parent = new URL("node_modules/parent/", f.root);
			const child = new URL("node_modules/child/", parent);
			await mkdir(child, { recursive: true });
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					dependencies: { parent: "file:../parent.tgz" },
				}),
			);
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify({
					name: "parent",
					version: "1.0.0",
					dependencies: { child: requirement },
				}),
			);
			await writeFile(
				new URL("package.json", child),
				JSON.stringify({ name: "child", version }),
			);
			await writeFile(
				new URL("index.js", child),
				'module.exports = "local";',
			);
			await writeFile(
				new URL("index.js", f.server),
				`import "parent";${f.index}`,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal: true,
						},
						{ resolve },
					),
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			expect(resolve).not.toHaveBeenCalled();
			expect(result._tag).toBe(accepted ? "Right" : "Left");
			if (!accepted || result._tag === "Left") return;
			const lock = result.right.mutations.find(
				(mutation) =>
					mutation.kind === "writeFile" &&
					mutation.path.pathname.endsWith("package-lock.json"),
			);
			if (lock?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			const { packages } = JSON.parse(lock.contents) as {
				packages: Record<
					string,
					{ version: string; resolved?: string }
				>;
			};
			const local = Object.entries(packages).find(([path]) =>
				path.endsWith("node_modules/child"),
			);
			expect(local?.[1].version).toBe(version);
			expect(local?.[1].resolved).toContain(
				".yandex/dependencies/",
			);
		},
	);

	it.each(
		[
			'import "data:text/javascript,export default 1";',
			'import " data:text/javascript,export default 1";',
			'import "data:text/javascript,export default 10 % 3#fragment";',
			'import.meta.resolve("data:text/javascript,export * from %27node:module%27");',
			'await import("data:text/javascript,export default 1");',
			'export {default as inlineValue} from "data:text/javascript,export default 1";',
			`import "data:text/javascript;base64,${Buffer.from("export default 1").toString("base64")}";`,
			'import "data:text/javascript,import%20%27node:path%27;export%20default%201";',
		].flatMap((source) =>
			["bundle", "install"].map((dependencyStrategy) => ({
				source,
				dependencyStrategy: dependencyStrategy as
					"bundle" | "install",
			})),
		),
	)(
		"keeps inline data modules outside npm package planning: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}${f.index}`,
			);
			const resolve = vi.fn(() =>
				Promise.reject(new Error("Unexpected registry lookup")),
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy },
					{ resolve },
				),
			);
			expect(resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const pkg = JSON.parse(
				await readFile(
					new URL("package.json", f.server),
					"utf8",
				),
			) as { dependencies?: Record<string, string> };
			expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
			expect(
				await readFile(new URL("index.js", f.server), "utf8"),
			).toContain("data:text/javascript");
		},
	);

	it.each(
		[
			"import proc from 'node:process';export const env=proc.env;",
			"const p=typeof process==='object'?process:{};export const env=p.env;",
			"const {env}=typeof process==='object'?process:{};export {env};",
			"function observe(process){const p=typeof process==='object'?process:{};p.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');}",
			"function run(p=process){return p.env}run();",
			"function run(p=process){var p={};var p={env:'ok'};return p.env}run();",

			"function run({env}=process){return env}run();",
			"function run(process,p=process){p.getBuiltinModule('module').createRequire(import.meta.url)('local-helper')}",
			"function run(p=process){var p={getBuiltinModule(){return {createRequire(){return ()=>{}}}}};p.getBuiltinModule('module').createRequire(import.meta.url)('local-helper')}run();",
			"import * as proc from 'process';export {proc};",
			"let p=process;p=process;export const env=p.env;",
			"let p=process;p=globalThis.process;export const env=p.env;",
			"let env;({env}=process);export {env};",
			"function observe(process){let p;p=process;p.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');}",
			"function observe(globalThis){let p;p=globalThis.process;p.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');}",
			"const process={env:{}};let p;p=process;export {p};",
			"function observe(process){process.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');}",
			"function observe(globalThis){globalThis.process.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');}",
			"const process={getBuiltinModule(){return {createRequire(){return ()=>{}}}}};process.getBuiltinModule('module').createRequire(import.meta.url)('local-helper');",
			"process.getBuiltinModule('fs');",
			"typeof process.getBuiltinModule;",
			"export const {env}=process;",
			"const p=process;consume(p);",
			"function inspect(Object){return Object.prototype.toString.call(process)}",
			"const p=globalThis.process || {};export {p as runtimeProcess};",
			"const isNode=typeof process!=='undefined' && Object.prototype.toString.call(process)==='[object process]';",
			"const hrtime=typeof process === 'object' && 'hrtime' in process && typeof process.hrtime.bigint === 'function' ? process.hrtime : undefined;",
			"const hasStdout=typeof process === 'object' && process !== null && typeof process.stdout === 'object' && process.stdout !== null;",
			"const p=globalThis.process || {}; const args=p.argv || []; const env=p.env || {};",
			"const p=globalThis.process ?? {}; const args=p.argv || [];",
			"const {env}=process;export const value=env.NODE_ENV;",
		].flatMap((source) =>
			["bundle", "install"].map((dependencyStrategy) => ({
				source,
				dependencyStrategy: dependencyStrategy as
					"bundle" | "install",
			})),
		),
	)(
		"keeps builtin process observations and shadowed bindings ordinary: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				source + f.index,
			);
			const before = await snapshot(f.directory);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([200, 401])(
		"uses project scoped registry and credentials without public fallback (HTTP %s)",
		async (status) => {
			const f = await fixture();
			const requests: Array<{
				url: string;
				authorized: boolean;
			}> = [];
			const registry = createServer((req, res) => {
				requests.push({
					url: req.url ?? "",
					authorized:
						req.headers.authorization ===
						"Bearer fixture-private-token",
				});
				if (
					status !== 200 ||
					req.headers.authorization !==
						"Bearer fixture-private-token"
				) {
					res.writeHead(401);
					res.end("{}");
					return;
				}
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						name: "@corp/example",
						"dist-tags": { latest: "1.0.0" },
						versions: {
							"1.0.0": {
								name: "@corp/example",
								version: "1.0.0",
								dist: {
									tarball: registryUrl + "/example.tgz",
									integrity: "sha512-private",
								},
							},
						},
					}),
				);
			});
			await new Promise<void>((resolve) =>
				registry.listen(0, "127.0.0.1", resolve),
			);
			const address = registry.address();
			if (!address || typeof address === "string")
				throw new Error("Expected registry port");
			const registryUrl = `http://127.0.0.1:${address.port}`;
			const defaultRequests: string[] = [];
			const defaultRegistry = createServer((req, res) => {
				defaultRequests.push(req.url ?? "");
				res.writeHead(404);
				res.end("{}");
			});
			await new Promise<void>((resolve) =>
				defaultRegistry.listen(0, "127.0.0.1", resolve),
			);
			try {
				const defaultAddress = defaultRegistry.address();
				if (
					!defaultAddress ||
					typeof defaultAddress === "string"
				)
					throw new Error("Expected default registry port");
				const defaultUrl = `http://127.0.0.1:${defaultAddress.port}/`;
				vi.stubEnv("npm_config_registry", defaultUrl);
				vi.stubEnv("NPM_CONFIG_REGISTRY", defaultUrl);
				vi.stubEnv("npm_config_offline", "false");
				vi.stubEnv("NPM_CONFIG_OFFLINE", "false");
				const npmrc = `registry=${defaultUrl}\n@corp:registry=${registryUrl}/\n//127.0.0.1:${address.port}/:_authToken=fixture-private-token\n`;
				await mkdir(
					new URL("node_modules/@corp/example/", f.root),
					{ recursive: true },
				);
				await writeFile(new URL(".npmrc", f.root), npmrc);
				await writeFile(
					new URL("package.json", f.root),
					JSON.stringify({
						name: "app",
						dependencies: { "@corp/example": "1.0.0" },
					}),
				);
				await writeFile(
					new URL(
						"node_modules/@corp/example/package.json",
						f.root,
					),
					JSON.stringify({
						name: "@corp/example",
						version: "1.0.0",
					}),
				);
				await writeFile(
					new URL("index.js", f.server),
					`import '@corp/example';${f.index}`,
				);
				const before = await snapshot(f.directory);
				const result = await Effect.runPromise(
					Effect.either(
						FunctionArtifact.planPreparation(
							f.build,
							f.routePlan,
							{ ...settings, dependencyStrategy: "install" },
						),
					),
				);
				expect(defaultRequests).toEqual([]);
				expect(requests.length).toBeGreaterThan(0);
				expect(requests.every((x) => x.authorized)).toBe(true);
				expect(await snapshot(f.directory)).toEqual(before);
				if (status !== 200) {
					expect(result._tag).toBe("Left");
					if (result._tag === "Left")
						expect(result.left.message).not.toContain(
							"fixture-private-token",
						);
					return;
				}
				expect(result._tag).toBe("Right");
				if (result._tag !== "Right") throw result.left;
				await Effect.runPromise(
					FunctionArtifact.applyPreparation(result.right),
				);
				const lock = await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				);
				expect(lock).not.toContain("fixture-private-token");
				expect(JSON.parse(lock) as unknown).toMatchObject({
					packages: {
						"node_modules/@corp/example": {
							version: "1.0.0",
							resolved: registryUrl + "/example.tgz",
							integrity: "sha512-private",
						},
					},
				});
				expect(
					await readFile(new URL(".npmrc", f.root), "utf8"),
				).toBe(npmrc);
			} finally {
				await Promise.all(
					[registry, defaultRegistry].map(
						(server) =>
							new Promise<void>((resolve, reject) =>
								server.close((error) =>
									error ? reject(error) : resolve(),
								),
							),
					),
				);
			}
		},
	);

	// npm (arborist OverrideSet) gives a rule without "." its key range; "*" keeps the requested range.
	it.each([
		{ key: "helper@^1", dot: false, range: "^1" },
		{ key: "helper@^1", dot: true, range: "^1" },
		{ key: "helper@*", dot: false, range: "~1.2.0" },
	])(
		"applies npm's edge range when an optional parent's override selects children ($key, dot rule: $dot)",
		async ({ key, dot, range }) => {
			const f = await fixture();
			await mkdir(new URL("node_modules/root-parent/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					overrides: {
						[key]: {
							...(dot ? { ".": "^1" } : {}),
							leaf: "2.0.0",
						},
					},
				}),
			);
			await writeFile(
				new URL("node_modules/root-parent/package.json", f.root),
				JSON.stringify({
					name: "root-parent",
					version: "1.0.0",
					optionalDependencies: { helper: "~1.2.0" },
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'root-parent';${f.index}`,
			);
			const resolve = vi.fn((name: string, range: string) =>
				Promise.resolve(
					name === "helper"
						? {
								version: range === "~1.2.0" ? "1.2.5" : "1.9.0",
								dependencies: { leaf: "^1" },
							}
						: {
								version:
									name === "root-parent" ? "1.0.0" : "2.0.0",
							},
				),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{ resolve },
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as { packages: Record<string, unknown> };
			expect(lock.packages["node_modules/helper"]).toMatchObject(
				{
					version: range === "~1.2.0" ? "1.2.5" : "1.9.0",
					dependencies: { leaf: "2.0.0" },
				},
			);
			expect(resolve).toHaveBeenCalledWith("helper", range);
		},
	);

	it.each(
		[
			"github:owner/example#main",
			"git+https://example.test/example.git",
			"https://example.test/example.tgz",
			"owner/example#main",
			"./example.tgz",
		].flatMap((requirement) =>
			[false, true].map((includeLocal) => ({
				requirement,
				includeLocal,
			})),
		),
	)(
		"keeps non-registry installed sources behind includeLocal: %j",
		async ({ requirement, includeLocal }) => {
			const f = await fixture();
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { example: requirement },
				}),
			);
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				JSON.stringify({
					name: "example",
					version: "1.0.0",
					type: "module",
					files: ["index.js"],
				}),
			);
			await writeFile(
				new URL("node_modules/example/index.js", f.root),
				"export default 'installed-private-code';",
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const resolve = vi.fn(() =>
				Promise.resolve({
					version: "1.0.0",
					resolved: "https://registry.example/wrong.tgz",
				}),
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal,
						},
						{ resolve },
					),
				),
			);
			expect(resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
			if (!includeLocal) {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected non-registry source rejection",
					);
				expect(result.left.message).toContain("includeLocal");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") throw result.left;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as {
				packages: Record<
					string,
					{ resolved: string; integrity: string }
				>;
			};
			expect(
				lock.packages["node_modules/example"]?.resolved,
			).toMatch(/^file:\.yandex\/dependencies\/.*\.tgz$/);
			expect(
				lock.packages["node_modules/example"]?.integrity,
			).toMatch(/^sha512-/);
		},
	);

	it.each([
		{
			label: "shrinkwrap only",
			appPath: "",
			locks: [["npm-shrinkwrap.json", "2.1.0"]],
		},
		{
			label: "shrinkwrap before package lock",
			appPath: "",
			locks: [
				["npm-shrinkwrap.json", "2.1.0"],
				["package-lock.json", "2.2.0"],
			],
		},
		{
			label: "package lock fallback",
			appPath: "",
			locks: [["package-lock.json", "2.1.0"]],
		},
		{
			label: "ancestor shrinkwrap",
			appPath: "workspace/",
			locks: [["npm-shrinkwrap.json", "2.1.0"]],
		},
		{
			label: "nearest package lock before ancestor shrinkwrap",
			appPath: "workspace/",
			locks: [
				["workspace/package-lock.json", "2.1.0"],
				["npm-shrinkwrap.json", "2.2.0"],
			],
		},
		{
			label: "nearest shrinkwrap before ancestor package lock",
			appPath: "workspace/",
			locks: [
				["workspace/npm-shrinkwrap.json", "2.1.0"],
				["package-lock.json", "2.2.0"],
			],
		},
	] as const)(
		"retains optional pins using npm lock precedence: $label",
		async ({ appPath, locks }) => {
			const f = await fixture();
			const appRoot = new URL(appPath, f.root);
			const build = {
				...f.build,
				config: { ...f.build.config, root: appRoot },
			};
			await mkdir(new URL("node_modules/example/", appRoot), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", appRoot),
				JSON.stringify({ name: "app" }),
			);
			await writeFile(
				new URL("node_modules/example/package.json", appRoot),
				JSON.stringify({
					name: "example",
					version: "1.2.3",
					optionalDependencies: { child: "^2" },
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';\n${f.index}`,
			);
			for (const [path, version] of locks) {
				const file = new URL(path, f.root);
				const prefix = relative(
					fileURLToPath(new URL(".", file)),
					fileURLToPath(appRoot),
				);
				const location = (name: string) =>
					join(prefix, "node_modules", name)
						.split("\\")
						.join("/");
				await writeFile(
					file,
					JSON.stringify({
						lockfileVersion: 3,
						packages: {
							[location("example")]: {
								version: "1.2.3",
								optionalDependencies: { child: "^2" },
							},
							[location("child")]: {
								version,
								resolved: `https://registry.example/child-${version}.tgz`,
								integrity: `sha512-child-${version}`,
								os: ["darwin"],
							},
						},
					}),
				);
			}
			const before = await snapshot(f.directory);
			const resolve = vi.fn((name: string, version: string) =>
				Promise.resolve({
					name,
					version: name === "child" ? "2.2.0" : version,
				}),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{ resolve },
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as { packages: Record<string, unknown> };
			expect(lock.packages["node_modules/child"]).toMatchObject({
				version: "2.1.0",
				optional: true,
				resolved: "https://registry.example/child-2.1.0.tgz",
				integrity: "sha512-child-2.1.0",
				os: ["darwin"],
			});
			expect(
				lock.packages["node_modules/example"],
			).toMatchObject({
				optionalDependencies: { child: "2.1.0" },
			});
			expect(resolve).not.toHaveBeenCalled();
			for (const [path] of locks)
				expect(
					(await readFile(new URL(path, f.root))).toString(
						"base64",
					),
				).toBe(before[path]);
		},
	);

	it.each([
		{
			label: "inactive dependency scope",
			dependencies: "^1",
			optional: "^2",
			parentVersion: "2.0.0",
			leafVersion: "1.0.0",
			scope: "parent@^1",
			allowed: true,
		},
		{
			label: "active optional scope",
			dependencies: "^1",
			optional: "^2",
			parentVersion: "2.0.0",
			leafVersion: "2.0.0",
			scope: "parent@^2",
			allowed: true,
		},
		{
			label: "conflicting active optional scope",
			dependencies: "^1",
			optional: "^2",
			parentVersion: "2.0.0",
			leafVersion: "1.0.0",
			scope: "parent@^2",
			allowed: false,
		},
		{
			label: "dependency fallback",
			dependencies: "^1",
			optional: undefined,
			parentVersion: "1.0.0",
			leafVersion: "1.0.0",
			scope: "parent@^2",
			allowed: true,
		},
		{
			label: "optional fallback",
			dependencies: undefined,
			optional: "^2",
			parentVersion: "2.0.0",
			leafVersion: "1.0.0",
			scope: "parent@^1",
			allowed: true,
		},
		{
			label: "active dev scope over production",
			dependencies: "^1",
			dev: "^2",
			parentVersion: "2.0.0",
			leafVersion: "2.0.0",
			scope: "parent@^2",
			allowed: true,
		},
		{
			label: "active dev scope over optional",
			optional: "^1",
			dev: "^2",
			parentVersion: "2.0.0",
			leafVersion: "2.0.0",
			scope: "parent@^2",
			allowed: true,
		},
		{
			label: "pnpm production scope over dev",
			dependencies: "^1",
			dev: "file:../parent-2.0.0.tgz",
			pnpm: true,
			parentVersion: "1.0.0",
			leafVersion: "2.0.0",
			scope: "parent@^1",
			allowed: true,
		},
		{
			label: "installed version fallback",
			dependencies: undefined,
			optional: undefined,
			parentVersion: "2.0.0",
			leafVersion: "1.0.0",
			scope: "parent@^1",
			allowed: true,
		},
	])(
		"selects root overrides from the effective requirement: $label",
		async ({
			dependencies,
			optional,
			dev,
			pnpm,
			parentVersion,
			leafVersion,
			scope,
			allowed,
		}) => {
			const f = await fixture();
			await mkdir(
				new URL(
					"node_modules/parent/node_modules/leaf/",
					f.root,
				),
				{ recursive: true },
			);
			if (pnpm)
				await writeFile(
					new URL("node_modules/.modules.yaml", f.root),
					"layoutVersion: 5\n",
				);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					...(dependencies
						? { dependencies: { parent: dependencies } }
						: {}),
					...(optional
						? { optionalDependencies: { parent: optional } }
						: {}),
					...(dev ? { devDependencies: { parent: dev } } : {}),
					overrides: { [scope]: { leaf: "2.0.0" } },
				}),
			);
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				JSON.stringify({
					name: "parent",
					version: parentVersion,
					dependencies: { leaf: "^1" },
				}),
			);
			await writeFile(
				new URL(
					"node_modules/parent/node_modules/leaf/package.json",
					f.root,
				),
				JSON.stringify({ name: "leaf", version: leafVersion }),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';${f.index}`,
			);
			const before = await snapshot(fileURLToPath(f.server));
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (name, version) =>
								Promise.resolve({ name, version }),
						},
					),
				),
			);
			if (!allowed) {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected effective optional override conflict",
					);
				expect(result.left.message).toContain("leaf");
				expect(await snapshot(fileURLToPath(f.server))).toEqual(
					before,
				);
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") throw result.left;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/parent": {
						version: parentVersion,
						dependencies: { leaf: leafVersion },
					},
					"node_modules/leaf": { version: leafVersion },
				},
			});
		},
	);

	it.each(
		[false, true].flatMap((localParent) =>
			[false, true].flatMap((hoisted) =>
				[false, true].map((overridden) => ({
					localParent,
					hoisted,
					overridden,
				})),
			),
		),
	)(
		"keeps bundled descendants and external peers in their original ownership: %j",
		async ({ localParent, hoisted, overridden }) => {
			const f = await fixture();
			if (overridden)
				await writeFile(
					new URL("package.json", f.root),
					JSON.stringify({
						name: "app",
						overrides: {
							"internal-child": "2.0.0",
							"internal-grand": "2.0.0",
							shared: "2.0.0",
						},
					}),
				);
			const parent = new URL(
				localParent
					? "packages/parent/"
					: "node_modules/parent/",
				f.root,
			);
			const child = new URL(
				"node_modules/internal-child/",
				parent,
			);
			await mkdir(child, { recursive: true });
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify({
					name: "parent",
					version: "1.0.0",
					type: "module",
					main: "index.js",
					dependencies: { "internal-child": "1.0.0" },
					bundleDependencies: ["internal-child"],
				}),
			);
			await writeFile(
				new URL("index.js", parent),
				'import child from "internal-child";export default child;',
			);
			await writeFile(
				new URL("package.json", child),
				JSON.stringify({
					name: "internal-child",
					version: "1.0.0",
					type: "module",
					main: "index.js",
					dependencies: { "internal-grand": "1.0.0" },
					peerDependencies: { shared: "^1" },
				}),
			);
			await writeFile(
				new URL("index.js", child),
				'import grand from "internal-grand";import shared from "shared";export default grand+shared;',
			);
			const grand = new URL(
				"node_modules/internal-grand/",
				hoisted ? parent : child,
			);
			await mkdir(grand, { recursive: true });
			await writeFile(
				new URL("package.json", grand),
				JSON.stringify({
					name: "internal-grand",
					version: "1.0.0",
					type: "module",
					main: "index.js",
				}),
			);
			await writeFile(
				new URL("index.js", grand),
				'export default "unpublished bundled content";',
			);
			if (localParent) {
				await mkdir(new URL("node_modules/", f.root), {
					recursive: true,
				});
				await symlink(
					parent,
					new URL("node_modules/parent", f.root),
					"dir",
				);
			}
			const archives = new URL("archives/", f.root);
			await mkdir(archives, { recursive: true });
			await promisify(execFile)(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--pack-destination",
					fileURLToPath(archives),
					"--json",
				],
				{ cwd: parent },
			);
			await writeFile(
				new URL("index.js", f.server),
				`import value from 'parent';${f.index.replace("return policy;", "return value;")}`,
			);
			const shared = new URL("node_modules/shared/", f.root);
			await mkdir(shared, { recursive: true });
			await writeFile(
				new URL("package.json", shared),
				JSON.stringify({
					name: "shared",
					version: overridden ? "2.0.0" : "1.0.0",
					type: "module",
					main: "index.js",
				}),
			);
			await writeFile(
				new URL("index.js", shared),
				'export default " with external peer";',
			);
			await promisify(execFile)(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--pack-destination",
					fileURLToPath(archives),
					"--json",
				],
				{ cwd: shared },
			);
			const resolve = vi.fn((name: string) =>
				name === "shared"
					? Promise.resolve({
							version: overridden ? "2.0.0" : "1.0.0",
							resolved: new URL(
								`shared-${overridden ? "2.0.0" : "1.0.0"}.tgz`,
								archives,
							).href,
						})
					: name === "parent"
						? Promise.resolve({
								version: "1.0.0",
								resolved: new URL("parent-1.0.0.tgz", archives)
									.href,
							})
						: Promise.reject(
								new Error(
									`Bundled ${name} is unpublished; never fetch registry code`,
								),
							),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{
						...settings,
						dependencyStrategy: "install",
						includeLocal: localParent,
					},
					{ resolve },
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-bundled-child-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				["ci", "--offline", "--no-audit", "--no-fund"],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe(
				"unpublished bundled content with external peer",
			);
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
			expect(JSON.parse(lock) as unknown).toMatchObject({
				packages: {
					"node_modules/parent": {
						bundleDependencies: ["internal-child"],
					},
					"node_modules/parent/node_modules/internal-child": {
						version: "1.0.0",
						inBundle: true,
					},
				},
			});
			expect(
				(
					JSON.parse(lock) as {
						packages: Record<string, unknown>;
					}
				).packages,
			).not.toHaveProperty("node_modules/internal-child");
			expect(
				resolve.mock.calls.map(([name]) => name),
			).not.toContain("internal-child");
			expect(
				resolve.mock.calls.map(([name]) => name),
			).not.toContain("internal-grand");
			expect(
				(
					JSON.parse(lock) as {
						packages: Record<string, unknown>;
					}
				).packages[
					hoisted
						? "node_modules/parent/node_modules/internal-grand"
						: "node_modules/parent/node_modules/internal-child/node_modules/internal-grand"
				],
			).toMatchObject({ version: "1.0.0", inBundle: true });
		},
	);

	it("executes the explicitly overridden installed version after a clean offline install", async () => {
		const f = await fixture();
		const archives = new URL("archives/", f.root);
		await mkdir(archives, { recursive: true });
		const metadata = new Map<string, object>();
		for (const manifest of [
			{
				name: "parent",
				version: "1.0.0",
				dependencies: { leaf: "^1" },
			},
			{ name: "leaf", version: "2.0.0" },
		]) {
			const source = new URL(
				`node_modules/${manifest.name}/`,
				f.root,
			);
			await mkdir(source, { recursive: true });
			await writeFile(
				new URL("package.json", source),
				JSON.stringify({
					...manifest,
					type: "module",
					main: "index.js",
				}),
			);
			await writeFile(
				new URL("index.js", source),
				manifest.name === "parent"
					? 'export {default} from "leaf";'
					: 'export default "overridden version executed";',
			);
			await promisify(execFile)(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--pack-destination",
					fileURLToPath(archives),
					"--json",
				],
				{ cwd: source },
			);
			metadata.set(manifest.name, {
				...manifest,
				resolved: new URL(
					`${manifest.name}-${manifest.version}.tgz`,
					archives,
				).href,
			});
		}
		await writeFile(
			new URL("package.json", f.root),
			JSON.stringify({
				name: "app",
				dependencies: { parent: "1.0.0", replacement: "2.0.0" },
				overrides: { parent: { leaf: "$replacement" } },
			}),
		);
		await writeFile(
			new URL("index.js", f.server),
			`import value from 'parent';${f.index.replace("return policy;", "return value;")}`,
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name) =>
						Promise.resolve(metadata.get(name)!),
				},
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const isolated = await mkdtemp(
			join(tmpdir(), "runtime-overridden-install-"),
		);
		directories.push(isolated);
		await cp(f.server, isolated, { recursive: true });
		const lock = await readFile(
			join(isolated, "package-lock.json"),
			"utf8",
		);
		await promisify(execFile)(
			"npm",
			["ci", "--offline", "--no-audit", "--no-fund"],
			{ cwd: isolated },
		);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"import {handler} from './index.js';process.stdout.write(await handler());",
			],
			{ cwd: isolated },
		);
		expect(stdout).toBe("overridden version executed");
		expect(
			await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			),
		).toBe(lock);
	});

	it("rejects conflicting effective overrides even when npm aliases share one installed directory", async () => {
		const f = await fixture();
		const parent = new URL(
			"node_modules/.pnpm/parent@1/node_modules/parent/",
			f.root,
		);
		await mkdir(new URL("node_modules/leaf/", parent), {
			recursive: true,
		});
		await writeFile(
			new URL("package.json", parent),
			JSON.stringify({
				name: "parent",
				version: "1.0.0",
				dependencies: { leaf: "^1" },
			}),
		);
		await writeFile(
			new URL("node_modules/leaf/package.json", parent),
			JSON.stringify({ name: "leaf", version: "2.0.0" }),
		);
		await symlink(
			parent,
			new URL("node_modules/a", f.root),
			"dir",
		);
		await symlink(
			parent,
			new URL("node_modules/b", f.root),
			"dir",
		);
		await writeFile(
			new URL("package.json", f.root),
			JSON.stringify({
				name: "app",
				dependencies: { a: "npm:parent@1", b: "npm:parent@1" },
				overrides: {
					a: { leaf: "2.0.0" },
					b: { leaf: "3.0.0" },
				},
			}),
		);
		await writeFile(
			new URL("index.js", f.server),
			`import 'a';import 'b';${f.index}`,
		);
		const result = await Effect.runPromise(
			Effect.either(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (_name, version) =>
							Promise.resolve({ version }),
					},
				),
			),
		);
		expect(result._tag).toBe("Left");
		if (result._tag !== "Left")
			throw new Error(
				"Expected conflicting effective override rejection",
			);
		expect(result.left.message).toContain("leaf");
	});

	it.each([
		...[false, true].flatMap((withChild) =>
			[false, true].map((contextual) => ({
				withChild,
				contextual,
				conflicting: false,
			})),
		),
		{ withChild: true, contextual: true, conflicting: true },
	])(
		"reconciles a locked helper reference to an installed direct root: %j",
		async ({ withChild, contextual, conflicting }) => {
			const f = await fixture();
			const archives = new URL("archives/", f.root);
			await mkdir(archives, { recursive: true });
			const manifests = [
				{
					name: "carrier",
					version: "1.0.0",
					optionalDependencies: { helper: "1.0.0" },
				},
				{
					name: "helper",
					version: "1.0.0",
					dependencies: { leaf: "1.0.0" },
				},
				{
					name: "leaf",
					version: "1.0.0",
					...(withChild
						? { dependencies: { child: "1.0.0" } }
						: {}),
				},
				...(withChild
					? [{ name: "child", version: "1.0.0" }]
					: []),
			];
			const serveTarball = await serveFixtureTarballs();
			const packages: Record<
				string,
				{ resolved: string; integrity: string }
			> = {};
			for (const manifest of manifests) {
				const location =
					manifest.name === "child"
						? "node_modules/leaf/node_modules/child"
						: `node_modules/${manifest.name}`;
				const source = new URL(
					manifest.name === "helper"
						? "archive-sources/helper/"
						: location + "/",
					f.root,
				);
				await mkdir(source, { recursive: true });
				await writeFile(
					new URL("package.json", source),
					JSON.stringify({
						...manifest,
						type: "module",
						main: "index.js",
					}),
				);
				await writeFile(
					new URL("index.js", source),
					manifest.name === "carrier"
						? 'export {default} from "helper";'
						: manifest.name === "helper"
							? 'export {default} from "leaf";'
							: manifest.name === "child"
								? 'export default "installed child";'
								: withChild
									? 'import child from "child";export default {value:child};'
									: 'export default {value:"installed leaf"};',
				);
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						fileURLToPath(archives),
						"--json",
					],
					{ cwd: source },
				);
				const filename = `${manifest.name}-${manifest.version}.tgz`;
				packages[location] = {
					...manifest,
					...serveTarball(
						filename,
						await readFile(new URL(filename, archives)),
					),
					...(manifest.name === "leaf" && withChild
						? { dependencies: { child: "2.0.0" } }
						: {}),
				};
			}
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({ lockfileVersion: 3, packages }),
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { carrier: "1.0.0", leaf: "1.0.0" },
					...(contextual
						? {
								overrides: {
									carrier: {
										helper: {
											leaf: conflicting
												? { child: "2.0.0" }
												: { unused: "2.0.0" },
										},
									},
								},
							}
						: {}),
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import carrier from 'carrier';import leaf from 'leaf';${f.index.replace("return policy;", "return String(carrier===leaf)+':'+leaf.value;")}`,
			);
			const resolve = vi.fn(() =>
				Promise.reject(
					new Error("All sources must retain their lock pins"),
				),
			);
			const before = await snapshot(fileURLToPath(f.server));
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{ resolve },
					),
				),
			);
			if (conflicting) {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected conflicting installed child rejection",
					);
				expect(result.left.message).toContain("child");
				expect(await snapshot(fileURLToPath(f.server))).toEqual(
					before,
				);
				expect(resolve).not.toHaveBeenCalled();
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right") throw result.left;
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-reconciled-install-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			const cache = await seedFixtureTarballCache(
				f.directory,
				Object.values(packages),
			);
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--offline",
					"--no-audit",
					"--no-fund",
					"--cache",
					cache,
				],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe(
				withChild
					? "true:installed child"
					: "true:installed leaf",
			);
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
			expect(resolve).not.toHaveBeenCalled();
		},
	);

	it.each(["hoistable", "blocked", "distinct"])(
		"preserves installed module identity or rejects sibling splitting (%s)",
		async (layout) => {
			const f = await fixture();
			const archives = new URL("archives/", f.root);
			await mkdir(archives, { recursive: true });
			const common = new URL(
				"node_modules/.pnpm/shared@1/node_modules/shared/",
				f.root,
			);
			const rootVersion =
				layout === "hoistable" ? "1.0.0" : "2.0.0";
			const manifests = [
				{
					name: "a",
					version: "1.0.0",
					dependencies: { shared: "1.0.0" },
				},
				{
					name: "b",
					version: "1.0.0",
					dependencies: { shared: "1.0.0" },
				},
				{ name: "shared", version: "1.0.0" },
				...(layout === "hoistable"
					? []
					: [{ name: "shared", version: "2.0.0" }]),
			];
			const metadata = new Map<string, object>();
			for (const manifest of manifests) {
				const directory =
					manifest.name === "shared" &&
					manifest.version === "1.0.0"
						? common
						: new URL(`node_modules/${manifest.name}/`, f.root);
				await mkdir(directory, { recursive: true });
				await writeFile(
					new URL("package.json", directory),
					JSON.stringify({
						...manifest,
						type: "module",
						main: "index.js",
					}),
				);
				await writeFile(
					new URL("index.js", directory),
					manifest.name === "shared"
						? `export default {version:${JSON.stringify(manifest.version)}};`
						: 'export {default} from "shared";',
				);
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						fileURLToPath(archives),
						"--json",
					],
					{ cwd: directory },
				);
				metadata.set(manifest.name + "@" + manifest.version, {
					...manifest,
					resolved: new URL(
						`${manifest.name}-${manifest.version}.tgz`,
						archives,
					).href,
				});
			}
			if (layout === "hoistable")
				await symlink(
					common,
					new URL("node_modules/shared", f.root),
					"dir",
				);
			for (const name of ["a", "b"]) {
				const parent = new URL(`node_modules/${name}/`, f.root);
				await mkdir(new URL("node_modules/", parent), {
					recursive: true,
				});
				if (layout === "distinct")
					await cp(
						common,
						new URL("node_modules/shared/", parent),
						{ recursive: true },
					);
				else
					await symlink(
						common,
						new URL("node_modules/shared", parent),
						"dir",
					);
			}
			const observe =
				'import a from "a";import b from "b";import root from "shared";process.stdout.write(`${a===b}:${root.version}`);';
			const original = await promisify(execFile)(
				process.execPath,
				["--input-type=module", "--eval", observe],
				{ cwd: f.root },
			);
			expect(original.stdout).toBe(
				`${layout !== "distinct"}:${rootVersion}`,
			);
			await writeFile(
				new URL("index.js", f.server),
				`import a from 'a';import b from 'b';import root from 'shared';${f.index.replace("return policy;", "return String(a===b)+':'+root.version;")}`,
			);
			const before = await snapshot(fileURLToPath(f.server));
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (name, version) =>
								Promise.resolve(
									metadata.get(name + "@" + version)!,
								),
						},
					),
				),
			);
			if (result._tag === "Left") {
				expect(layout).toBe("blocked");
				expect(result.left.message).toContain("shared");
				expect(await snapshot(fileURLToPath(f.server))).toEqual(
					before,
				);
				return;
			}
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-singleton-install-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				["ci", "--offline", "--no-audit", "--no-fund"],
				{ cwd: isolated },
			);
			const installed = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(installed.stdout).toBe(original.stdout);
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
		},
	);

	it.each(
		["conflicting", "equivalent", "unrelated"].flatMap(
			(policy) =>
				[false, true].flatMap((deep) =>
					[false, true].map((cyclic) => ({
						policy,
						deep,
						cyclic,
					})),
				),
		),
	)(
		"checks effective descendants before reusing one installed package: %j",
		async ({ policy, deep, cyclic }) => {
			const f = await fixture();
			const shared = new URL(
				"node_modules/.pnpm/shared@1/node_modules/shared/",
				f.root,
			);
			await mkdir(new URL("node_modules/", shared), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", shared),
				JSON.stringify({
					name: "shared",
					version: "1.0.0",
					dependencies: {
						...(deep ? { bridge: "1.0.0" } : {}),
						...(cyclic ? { shared: "1.0.0" } : {}),
					},
					...(!deep
						? { optionalDependencies: { leaf: "^1" } }
						: {}),
				}),
			);
			if (deep) {
				const bridge = new URL("node_modules/bridge/", shared);
				await mkdir(bridge, { recursive: true });
				await writeFile(
					new URL("package.json", bridge),
					JSON.stringify({
						name: "bridge",
						version: "1.0.0",
						optionalDependencies: { leaf: "^1" },
					}),
				);
			}
			if (cyclic)
				await symlink(
					shared,
					new URL("node_modules/shared", shared),
					"dir",
				);
			for (const name of ["a", "b"]) {
				const parent = new URL(`node_modules/${name}/`, f.root);
				await mkdir(new URL("node_modules/", parent), {
					recursive: true,
				});
				await writeFile(
					new URL("package.json", parent),
					JSON.stringify({
						name,
						version: "1.0.0",
						dependencies: { shared: "1.0.0" },
					}),
				);
				await symlink(
					shared,
					new URL("node_modules/shared", parent),
					"dir",
				);
			}
			const leafRules = (version: string) =>
				deep ? { bridge: { leaf: version } } : { leaf: version };
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { a: "1.0.0", b: "1.0.0" },
					overrides:
						policy === "unrelated"
							? {
									leaf: "2.0.0",
									a: { unrelated: "3.0.0" },
									b: { unused: "4.0.0" },
								}
							: {
									a: { shared: leafRules("2.0.0") },
									b: {
										shared: leafRules(
											policy === "conflicting"
												? "3.0.0"
												: "2.0.0",
										),
									},
								},
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'a';import 'b';${f.index}`,
			);
			const before = await snapshot(fileURLToPath(f.server));
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (_name, version) =>
								Promise.resolve({ version }),
						},
					),
				),
			);
			if (policy === "conflicting") {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected conflicting shared dependency rejection",
					);
				expect(result.left.message).toContain("shared");
				expect(await snapshot(fileURLToPath(f.server))).toEqual(
					before,
				);
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right")
				throw new Error(
					"Expected equivalent installed context reuse",
				);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as { packages: Record<string, { version?: string }> };
			expect(
				Object.keys(lock.packages).filter((path) =>
					path.endsWith("node_modules/shared"),
				),
			).toEqual(["node_modules/shared"]);
			expect(
				Object.entries(lock.packages)
					.filter(([path]) => path.endsWith("node_modules/leaf"))
					.map(([, entry]) => entry.version),
			).toEqual(["2.0.0"]);
		},
	);

	it.each([
		{ overrides: { leaf: { ".": "2.0.0" } }, allowed: true },
		{ overrides: { leaf: "$selected" }, allowed: true },
		{
			overrides: { "parent@^1": { leaf: "2.0.0" } },
			allowed: true,
		},
		{
			overrides: { carrier: { parent: { leaf: "2.0.0" } } },
			allowed: true,
		},
		{ overrides: { "leaf@^1": "2.0.0" }, allowed: true },
		{
			overrides: { "parent@^3": { leaf: "2.0.0" } },
			allowed: false,
		},
		{ overrides: { "leaf@^3": "2.0.0" }, allowed: false },
		{
			overrides: { unrelated: { leaf: "2.0.0" } },
			allowed: false,
		},
	])(
		"applies only matching root override rules in the dependency ancestry: %j",
		async ({ overrides, allowed }) => {
			const f = await fixture();
			for (const [name, manifest] of Object.entries({
				carrier: {
					version: "1.0.0",
					dependencies: { parent: "^1" },
				},
				parent: {
					version: "1.0.0",
					dependencies: { leaf: "^1" },
					overrides: { leaf: "2.0.0" },
				},
				leaf: { version: "2.0.0" },
			})) {
				const source = new URL(`node_modules/${name}/`, f.root);
				await mkdir(source, { recursive: true });
				await writeFile(
					new URL("package.json", source),
					JSON.stringify({ name, ...manifest }),
				);
			}
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { carrier: "1.0.0", selected: "2.0.0" },
					overrides,
				}),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'carrier';${f.index}`,
			);
			const plan = FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (_name, version) =>
						Promise.resolve({ version }),
				},
			);
			const result = await Effect.runPromise(
				Effect.either(plan),
			);
			if (!allowed) {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected incompatible installed package rejection",
					);
				expect(result.left.message).toContain("leaf");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right")
				throw new Error("expected override plan");
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: { "node_modules/leaf": { version: "2.0.0" } },
			});
		},
	);

	it.each([false, true])(
		"honors an explicit application override without accepting an unoverridden mismatch (%s)",
		async (overridden) => {
			const f = await fixture();
			await mkdir(
				new URL(
					"node_modules/parent/node_modules/leaf/",
					f.root,
				),
				{ recursive: true },
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					...(overridden
						? { overrides: { leaf: "2.0.0" } }
						: {}),
				}),
			);
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				JSON.stringify({
					name: "parent",
					version: "1.0.0",
					dependencies: { leaf: "^1" },
				}),
			);
			await writeFile(
				new URL(
					"node_modules/parent/node_modules/leaf/package.json",
					f.root,
				),
				JSON.stringify({ name: "leaf", version: "2.0.0" }),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';${f.index}`,
			);
			const plan = FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name, version) =>
						Promise.resolve({
							version,
							...(name === "parent"
								? { dependencies: { leaf: "^1" } }
								: {}),
						}),
				},
			);
			if (!overridden) {
				const result = await Effect.runPromise(
					Effect.either(plan),
				);
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected incompatible installed package rejection",
					);
				expect(result.left.message).toContain("leaf");
				return;
			}
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(
					await Effect.runPromise(plan),
				),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/parent": {
						dependencies: { leaf: "2.0.0" },
					},
					"node_modules/leaf": { version: "2.0.0" },
				},
			});
		},
	);

	it.each([
		"unbundled",
		"bundled",
		"bundled BOM",
		"undeclared bundled peer",
	] as const)(
		"validates the required peers of an absent optional package (%s)",
		async (mode) => {
			const bundledHelper = mode !== "unbundled";
			const bundlePeerOnly = mode === "undeclared bundled peer";
			const f = await fixture();
			const archives = new URL("archives/", f.root);
			await mkdir(archives, { recursive: true });
			const manifests = [
				{
					name: "example",
					version: "1.0.0",
					type: "module",
					main: "index.js",
					optionalDependencies: { helper: "^2" },
				},
				{
					name: "helper",
					version: "2.0.0",
					type: "module",
					main: "index.js",
					...(bundlePeerOnly
						? {}
						: { peerDependencies: { absent: "^3" } }),
					...(bundledHelper
						? {
								dependencies: { "bundled-child": "1.0.0" },
								optionalDependencies: {
									"bundled-child": "1.0.0",
								},
								bundleDependencies: ["bundled-child"],
							}
						: {}),
				},
				{
					name: "absent",
					version: "3.0.0",
					type: "module",
					main: "index.js",
				},
			];
			const metadata = new Map<string, object>();
			for (const manifest of manifests) {
				const source = new URL(
					manifest.name === "example"
						? "node_modules/example/"
						: `packages/${manifest.name}/`,
					f.root,
				);
				await mkdir(source, { recursive: true });
				await writeFile(
					new URL("package.json", source),
					JSON.stringify(manifest),
				);
				await writeFile(
					new URL("index.js", source),
					manifest.name === "example"
						? 'export {value} from "helper";'
						: manifest.name === "helper"
							? bundledHelper
								? 'import peer from "absent";import child from "bundled-child";export const value=peer+child;'
								: 'import value from "absent";export {value};'
							: 'export default "required peer delivered";',
				);
				if (manifest.name === "helper" && bundledHelper) {
					const child = new URL(
						"node_modules/bundled-child/",
						source,
					);
					await mkdir(child, { recursive: true });
					await writeFile(
						new URL("package.json", child),
						(mode === "bundled BOM" ? "\uFEFF" : "") +
							JSON.stringify({
								name: "bundled-child",
								version: "1.0.0",
								type: "module",
								main: "index.js",
								...(bundlePeerOnly
									? { peerDependencies: { absent: "^3" } }
									: {}),
							}),
					);
					await writeFile(
						new URL("index.js", child),
						bundlePeerOnly
							? 'export {default} from "absent";'
							: 'export default " bundled";',
					);
				}
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						fileURLToPath(archives),
						"--json",
					],
					{ cwd: source },
				);
				metadata.set(manifest.name, {
					...manifest,
					resolved: new URL(
						`${manifest.name}-${manifest.version}.tgz`,
						archives,
					).href,
				});
			}
			await writeFile(
				new URL("index.js", f.server),
				`import {value} from 'example';${f.index.replace("return policy;", "return value;")}`,
			);
			const resolve = vi.fn((name: string) => {
				const selected = metadata.get(name);
				if (!selected)
					throw new Error(`Bundled ${name} must not be fetched`);
				return Promise.resolve(selected);
			});
			const planning = FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{ resolve },
			);
			if (bundlePeerOnly) {
				const before = await snapshot(f.directory);
				await expect(
					Effect.runPromise(planning),
				).rejects.toThrow(/bundled.*needs external peer absent/);
				expect(await snapshot(f.directory)).toEqual(before);
				expect(
					resolve.mock.calls.map(([name]) => name),
				).not.toContain("bundled-child");
				return;
			}
			const plan = await Effect.runPromise(planning);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-required-peer-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--include=optional",
					"--offline",
					"--no-audit",
					"--no-fund",
				],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe(
				bundledHelper
					? "required peer delivered bundled"
					: "required peer delivered",
			);
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
			expect(JSON.parse(lock)).toMatchObject({
				packages: {
					"node_modules/absent": { version: "3.0.0" },
					"node_modules/helper": {
						peerDependencies: { absent: "3.0.0" },
					},
				},
			});
			if (bundledHelper) {
				const helper = (
					JSON.parse(lock) as {
						packages: Record<
							string,
							{
								dependencies?: object;
								optionalDependencies?: object;
							}
						>;
					}
				).packages["node_modules/helper"];
				expect(helper?.optionalDependencies).toMatchObject({
					"bundled-child": "1.0.0",
				});
				expect(helper?.dependencies ?? {}).not.toHaveProperty(
					"bundled-child",
				);
			}
		},
	);

	it.each([false, true])(
		"shares compatible registry-only peer contexts and rejects incompatible sibling requirements (%s)",
		async (conflicting) => {
			const f = await fixture();
			const archives = new URL("archives/", f.root);
			await mkdir(archives, { recursive: true });
			const entries = new Map<string, object>();
			for (const [path, manifest, code] of [
				[
					"node_modules/absent/",
					{ name: "absent", version: "1.0.0" },
					'export default {version:"root"};',
				],
				[
					"node_modules/example/",
					{
						name: "example",
						version: "1.0.0",
						optionalDependencies: { helper: "^2", other: "^2" },
					},
					'import a from "helper";import b from "other";export default a===b;',
				],
				[
					"packages/helper/",
					{
						name: "helper",
						version: "2.0.0",
						peerDependencies: { absent: "^3" },
					},
					'export {default} from "absent";',
				],
				[
					"packages/other/",
					{
						name: "other",
						version: "2.0.0",
						peerDependencies: {
							absent: conflicting ? "^4" : "^3",
						},
					},
					'export {default} from "absent";',
				],
				[
					"packages/peer/",
					{ name: "absent", version: "3.0.0" },
					"export default {};",
				],
				[
					"packages/peer-four/",
					{ name: "absent", version: "4.0.0" },
					"export default {};",
				],
			] as const) {
				const dir = new URL(path, f.root);
				await mkdir(dir, { recursive: true });
				await writeFile(
					new URL("package.json", dir),
					JSON.stringify({
						...manifest,
						type: "module",
						main: "index.js",
					}),
				);
				await writeFile(new URL("index.js", dir), code);
				await promisify(execFile)(
					"npm",
					[
						"pack",
						"--ignore-scripts",
						"--pack-destination",
						fileURLToPath(archives),
						"--json",
					],
					{ cwd: dir },
				);
				entries.set(`${manifest.name}@${manifest.version}`, {
					...manifest,
					resolved: new URL(
						`${manifest.name}-${manifest.version}.tgz`,
						archives,
					).href,
				});
			}
			await writeFile(
				new URL("index.js", f.server),
				`import value from 'example';import root from 'absent';${f.index.replace("return policy;", 'return String(value)+":"+root.version;')}`,
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{
							resolve: (name, range) =>
								Promise.resolve(
									entries.get(
										`${name}@${range.startsWith("^") ? range.slice(1) + ".0.0" : range}`,
									)!,
								),
						},
					),
				),
			);
			if (conflicting) {
				expect(result._tag).toBe("Left");
				if (result._tag !== "Left")
					throw new Error(
						"Expected incompatible peer rejection",
					);
				expect(result.left.message).toContain("absent");
				return;
			}
			expect(result._tag).toBe("Right");
			if (result._tag !== "Right")
				throw new Error("Expected compatible peer plan");
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-registry-peer-singleton-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--include=optional",
					"--offline",
					"--no-audit",
					"--no-fund",
				],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe("true:root");
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
		},
	);

	it("does not require an unrelated local dev version for a registry-only parent", async () => {
		const f = await fixture();
		const local = new URL("packages/leaf-dev/", f.root);
		await mkdir(local, { recursive: true });
		await writeFile(
			new URL("package.json", local),
			JSON.stringify({ name: "leaf" }),
		);
		await mkdir(new URL("node_modules/carrier/", f.root), {
			recursive: true,
		});
		await symlink(
			local,
			new URL("node_modules/leaf", f.root),
			"dir",
		);
		await writeFile(
			new URL("node_modules/carrier/package.json", f.root),
			JSON.stringify({
				name: "carrier",
				version: "1.0.0",
				optionalDependencies: { helper: "^1" },
			}),
		);
		await writeFile(
			new URL("package.json", f.root),
			JSON.stringify({
				name: "app",
				devDependencies: { leaf: "workspace:*" },
			}),
		);
		await writeFile(
			new URL("index.js", f.server),
			`import 'carrier';${f.index}`,
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name, range) =>
						Promise.resolve(
							name === "carrier"
								? {
										version: "1.0.0",
										optionalDependencies: { helper: "^1" },
									}
								: name === "helper"
									? {
											version: "1.0.0",
											dependencies: { leaf: "^2" },
										}
									: {
											version:
												range === "^2" ? "2.0.0" : "1.0.0",
										},
						),
				},
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const lock = JSON.parse(
			await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			),
		) as { packages: Record<string, unknown> };
		expect(
			lock.packages["node_modules/helper/node_modules/leaf"],
		).toMatchObject({ version: "2.0.0" });
		expect(lock.packages).not.toHaveProperty(
			"node_modules/leaf",
		);
	});

	it.each([false, true])(
		"links a dependency executable before its parent's postinstall (string bin: %s)",
		async (stringBin) => {
			const f = await fixture();
			const parent = new URL("packages/parent/", f.root);
			const tool = new URL("packages/generator/", f.root);
			await mkdir(parent, { recursive: true });
			await mkdir(tool, { recursive: true });
			await mkdir(new URL("node_modules/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify({
					name: "parent",
					version: "1.0.0",
					type: "module",
					main: "index.js",
					files: ["index.js"],
					dependencies: { "tool-alias": "workspace:*" },
					scripts: {
						postinstall: stringBin ? "generator" : "generate",
					},
				}),
			);
			await writeFile(
				new URL("index.js", parent),
				'export {default} from "./generated.cjs";',
			);
			await writeFile(
				new URL("package.json", tool),
				JSON.stringify({
					name: "@scope/generator",
					version: "1.0.0",
					files: ["cli.cjs"],
					bin: stringBin ? "cli.cjs" : { generate: "cli.cjs" },
				}),
			);
			await writeFile(
				new URL("cli.cjs", tool),
				`#!/usr/bin/env node
require('node:fs').writeFileSync('generated.cjs', 'module.exports = "generated by dependency executable";');
`,
			);
			await symlink(
				parent,
				new URL("node_modules/parent", f.root),
				"dir",
			);
			await symlink(
				tool,
				new URL("node_modules/tool-alias", f.root),
				"dir",
			);
			await writeFile(
				new URL("index.js", f.server),
				`import local from 'parent';${f.index.replace("return policy;", "return local;")}`,
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{
						...settings,
						dependencyStrategy: "install",
						includeLocal: true,
					},
					{
						resolve: () =>
							Promise.reject(
								new Error(
									"Do not substitute local runtime sources",
								),
							),
					},
				),
			);
			await expect(
				access(new URL("generated.cjs", parent)),
			).rejects.toMatchObject({ code: "ENOENT" });
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "runtime-dependency-bin-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				[
					"ci",
					"--ignore-scripts=false",
					"--bin-links=true",
					"--offline",
					"--no-audit",
					"--no-fund",
				],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe("generated by dependency executable");
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
			await expect(
				access(new URL("generated.cjs", parent)),
			).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.each([false, true])(
		"does not select an unrelated local dev binding during placement (versioned: %s)",
		async (versioned) => {
			const f = await fixture();
			const local = new URL("packages/leaf-dev/", f.root);
			await mkdir(local, { recursive: true });
			await writeFile(
				new URL("package.json", local),
				JSON.stringify({
					name: "leaf",
					...(versioned ? { version: "1.0.0" } : {}),
				}),
			);
			await writeFile(
				new URL("index.js", local),
				"throw new Error('Do not execute unrelated dev code');",
			);
			await mkdir(
				new URL(
					"node_modules/parent/node_modules/leaf/",
					f.root,
				),
				{ recursive: true },
			);
			await symlink(
				local,
				new URL("node_modules/leaf", f.root),
				"dir",
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { parent: "1.0.0" },
					devDependencies: { leaf: "workspace:*" },
				}),
			);
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				JSON.stringify({
					name: "parent",
					version: "1.0.0",
					dependencies: { leaf: "^2" },
				}),
			);
			await writeFile(
				new URL(
					"node_modules/parent/node_modules/leaf/package.json",
					f.root,
				),
				JSON.stringify({ name: "leaf", version: "2.0.0" }),
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';${f.index}`,
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name, version) =>
							Promise.resolve({
								version,
								...(name === "parent"
									? { dependencies: { leaf: "^2" } }
									: {}),
							}),
					},
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as { packages: Record<string, unknown> };
			expect(
				lock.packages["node_modules/parent/node_modules/leaf"],
			).toMatchObject({ version: "2.0.0" });
			expect(lock.packages).not.toHaveProperty(
				"node_modules/leaf",
			);
			expect(
				await readFile(new URL("package.json", local), "utf8"),
			).toBe(
				JSON.stringify({
					name: "leaf",
					...(versioned ? { version: "1.0.0" } : {}),
				}),
			);
		},
	);

	it.each(
		[false, true].flatMap((installed) =>
			[false, true].map((locked) => ({ installed, locked })),
		),
	)(
		"keeps incompatible transitive bindings separate only for uninstalled parents: %j",
		async ({ installed, locked }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'carrier';import 'leaf';${f.index}`,
			);
			const entries = {
				carrier: {
					version: "1.0.0",
					optionalDependencies: { helper: "^1" },
				},
				leaf: { version: "1.0.0" },
				helper: {
					version: "1.0.0",
					dependencies: { leaf: "^2" },
				},
			};
			for (const name of [
				"carrier",
				"leaf",
				...(installed ? ["helper"] : []),
			]) {
				await mkdir(new URL(`node_modules/${name}/`, f.root), {
					recursive: true,
				});
				await writeFile(
					new URL(`node_modules/${name}/package.json`, f.root),
					JSON.stringify({
						name,
						...entries[name as keyof typeof entries],
					}),
				);
			}
			if (locked)
				await writeFile(
					new URL("package-lock.json", f.root),
					JSON.stringify({
						lockfileVersion: 3,
						packages: Object.fromEntries(
							Object.entries(entries)
								.filter(
									([name]) => name !== "helper" || installed,
								)
								.map(([name, entry]) => [
									`node_modules/${name}`,
									entry,
								]),
						),
					}),
				);
			const registry = {
				resolve: vi.fn((name: string, range: string) =>
					Promise.resolve(
						name === "leaf"
							? { version: range === "^2" ? "2.0.0" : "1.0.0" }
							: entries[name as "carrier" | "helper"],
					),
				),
			};
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						registry,
					),
				),
			);
			expect(result._tag).toBe(installed ? "Left" : "Right");
			if (result._tag === "Left") {
				expect(result.left.message).toMatch(/leaf/);
				return;
			}
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/leaf": { version: "1.0.0" },
					"node_modules/helper/node_modules/leaf": {
						version: "2.0.0",
					},
					"node_modules/helper": {
						dependencies: { leaf: "2.0.0" },
					},
				},
			});
			expect(registry.resolve).toHaveBeenCalledWith(
				"leaf",
				"^2",
			);
		},
	);

	it.each(["locked", "registry"])(
		"preserves executable declarations from %s metadata",
		async (from) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';${f.index}`,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				JSON.stringify({ name: "example", version: "1.0.0" }),
			);
			const entry = {
				version: "1.0.0",
				bin: { generate: "bin/cli.js" },
			};
			if (from === "locked")
				await writeFile(
					new URL("package-lock.json", f.root),
					JSON.stringify({
						lockfileVersion: 3,
						packages: { "node_modules/example": entry },
					}),
				);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: () =>
							from === "locked"
								? Promise.reject(
										new Error(
											"Unexpected registry lookup with a lock entry",
										),
									)
								: Promise.resolve(entry),
					},
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/example": {
						bin: { generate: "bin/cli.js" },
					},
				},
			});
		},
	);

	it.each(["locked", "registry"])(
		"preserves the install-script flag from %s metadata",
		async (from) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';${f.index}`,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				JSON.stringify({ name: "example", version: "1.0.0" }),
			);
			const entry = { version: "1.0.0", hasInstallScript: true };
			if (from === "locked")
				await writeFile(
					new URL("package-lock.json", f.root),
					JSON.stringify({
						lockfileVersion: 3,
						packages: { "node_modules/example": entry },
					}),
				);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: () =>
							from === "locked"
								? Promise.reject(
										new Error(
											"Unexpected registry lookup with a lock entry",
										),
									)
								: Promise.resolve(entry),
					},
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/example": { hasInstallScript: true },
				},
			});
		},
	);

	it("runs a local package postinstall only during clean artifact installation", async () => {
		const f = await fixture();
		const source = new URL("packages/example/", f.root);
		await mkdir(source, { recursive: true });
		await mkdir(new URL("node_modules/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("package.json", source),
			JSON.stringify({
				name: "example",
				version: "1.0.0",
				type: "module",
				main: "index.js",
				files: ["index.js", "install.cjs"],
				scripts: {
					prepack: "node -e 'process.exit(91)'",
					prepare: "node -e 'process.exit(92)'",
					postinstall: "node install.cjs",
				},
			}),
		);
		await writeFile(
			new URL("index.js", source),
			'export {default} from "./generated.js";',
		);
		await writeFile(
			new URL("install.cjs", source),
			`require('node:fs').writeFileSync('generated.js', 'export default "generated on install";');`,
		);
		await symlink(
			source,
			new URL("node_modules/example", f.root),
			"dir",
		);
		await writeFile(
			new URL("index.js", f.server),
			`import local from 'example';${f.index.replace("return policy;", "return local;")}`,
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{
					...settings,
					dependencyStrategy: "install",
					includeLocal: true,
				},
				{
					resolve: () =>
						Promise.reject(
							new Error("Local source must not query registry"),
						),
				},
			),
		);
		await expect(
			access(new URL("generated.js", source)),
		).rejects.toMatchObject({ code: "ENOENT" });
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const isolated = await mkdtemp(
			join(tmpdir(), "local-install-script-"),
		);
		directories.push(isolated);
		await cp(f.server, isolated, { recursive: true });
		const lock = await readFile(
			join(isolated, "package-lock.json"),
			"utf8",
		);
		await promisify(execFile)(
			"npm",
			[
				"ci",
				"--ignore-scripts=false",
				"--offline",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: isolated },
		);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"import {handler} from './index.js';process.stdout.write(await handler());",
			],
			{ cwd: isolated },
		);
		expect(stdout).toBe("generated on install");
		expect(
			await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			),
		).toBe(lock);
		await expect(
			access(new URL("generated.js", source)),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([false, true])(
		"keeps an absent local workspace peer optional only when declared optional (%s)",
		async (optional) => {
			const f = await fixture();
			const source = new URL("packages/example/", f.root);
			await mkdir(source, { recursive: true });
			await mkdir(new URL("node_modules/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("package.json", source),
				JSON.stringify({
					name: "example",
					version: "1.0.0",
					type: "module",
					main: "index.js",
					peerDependencies: { peer: "workspace:*" },
					...(optional
						? {
								peerDependenciesMeta: {
									peer: { optional: true },
								},
							}
						: {}),
				}),
			);
			await writeFile(
				new URL("index.js", source),
				'export default "no optional peer needed";',
			);
			await symlink(
				source,
				new URL("node_modules/example", f.root),
				"dir",
			);
			await writeFile(
				new URL("index.js", f.server),
				`import local from 'example';${f.index.replace("return policy;", "return local;")}`,
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal: true,
						},
						{
							resolve: () =>
								Promise.reject(
									new Error(
										"Do not resolve an absent optional peer from registry",
									),
								),
						},
					),
				),
			);
			expect(result._tag).toBe(optional ? "Right" : "Left");
			if (result._tag === "Left") {
				expect(result.left.message).toMatch(/peer/);
				return;
			}
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(result.right),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "optional-local-peer-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				["ci", "--offline", "--no-audit", "--no-fund"],
				{ cwd: isolated },
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(stdout).toBe("no optional peer needed");
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
		},
	);

	it("does not reuse equal-version alias lock metadata with a different package identity", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import 'runtime-alias';${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			JSON.stringify({
				name: "app",
				dependencies: { "runtime-alias": "npm:real-b@1.2.3" },
			}),
		);
		await mkdir(new URL("node_modules/runtime-alias/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("node_modules/runtime-alias/package.json", f.root),
			JSON.stringify({ name: "real-b", version: "1.2.3" }),
		);
		await writeFile(
			new URL("package-lock.json", f.root),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"node_modules/runtime-alias": {
						name: "real-a",
						version: "1.2.3",
						resolved: "https://registry.example/real-a.tgz",
						integrity: "sha512-wrong",
					},
				},
			}),
		);
		const registry = {
			resolve: vi.fn((name: string, version: string) =>
				Promise.resolve({
					name,
					version,
					resolved: "https://registry.example/real-b.tgz",
					integrity: "sha512-correct",
				}),
			),
		};
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				registry,
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		expect(
			JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			),
		).toMatchObject({
			packages: {
				"node_modules/runtime-alias": {
					name: "real-b",
					version: "1.2.3",
					resolved: "https://registry.example/real-b.tgz",
					integrity: "sha512-correct",
				},
			},
		});
		expect(registry.resolve).toHaveBeenCalledWith(
			"real-b",
			"1.2.3",
		);
	});

	it("keeps distinct local contents with equal package names and versions", async () => {
		const f = await fixture();
		await mkdir(new URL("node_modules/", f.root), {
			recursive: true,
		});
		for (const name of ["alpha", "beta"]) {
			const parent = new URL(`packages/${name}/`, f.root);
			const leaf = new URL(`packages/${name}-leaf/`, f.root);
			await mkdir(new URL("node_modules/", parent), {
				recursive: true,
			});
			await mkdir(leaf, { recursive: true });
			await writeFile(
				new URL("package.json", parent),
				JSON.stringify({
					name,
					version: "1.0.0",
					type: "module",
					main: "index.js",
					dependencies: { leaf: "workspace:*" },
				}),
			);
			await writeFile(
				new URL("index.js", parent),
				'export {default} from "leaf";',
			);
			await writeFile(
				new URL("package.json", leaf),
				JSON.stringify({
					name: "leaf",
					version: "1.0.0",
					type: "module",
					main: "index.js",
				}),
			);
			await writeFile(
				new URL("index.js", leaf),
				`export default ${JSON.stringify(name)};`,
			);
			await symlink(
				leaf,
				new URL("node_modules/leaf", parent),
				"dir",
			);
			await symlink(
				parent,
				new URL(`node_modules/${name}`, f.root),
				"dir",
			);
		}
		await writeFile(
			new URL("index.js", f.server),
			`import alpha from 'alpha';import beta from 'beta';${f.index.replace("return policy;", "return alpha + ':' + beta;")}`,
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{
					...settings,
					dependencyStrategy: "install",
					includeLocal: true,
				},
				{
					resolve: () =>
						Promise.reject(
							new Error("Local sources must not query registry"),
						),
				},
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const isolated = await mkdtemp(
			join(tmpdir(), "distinct-local-content-"),
		);
		directories.push(isolated);
		await cp(f.server, isolated, { recursive: true });
		const lock = await readFile(
			join(isolated, "package-lock.json"),
			"utf8",
		);
		await promisify(execFile)(
			"npm",
			["ci", "--offline", "--no-audit", "--no-fund"],
			{ cwd: isolated },
		);
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				"import {handler} from './index.js';process.stdout.write(await handler());",
			],
			{ cwd: isolated },
		);
		expect(stdout).toBe("alpha:beta");
		expect(
			await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			),
		).toBe(lock);
	});

	it.each([false, true])(
		"installs exact local contents outside the project when includeLocal is true (transitive=%s)",
		async (transitive) => {
			const f = await fixture();
			const source = new URL("packages/example/", f.root);
			await mkdir(source, { recursive: true });
			await mkdir(new URL("node_modules/", f.root), {
				recursive: true,
			});
			const manifest = JSON.stringify({
				name: "example",
				version: "1.0.0",
				type: "module",
				main: "index.js",
				files: ["index.js"],
				...(transitive
					? { dependencies: { "local-leaf": "workspace:*" } }
					: {}),
				scripts: {
					prepack: "node -e 'process.exit(91)'",
					prepare: "node -e 'process.exit(92)'",
				},
			});
			await writeFile(new URL("package.json", source), manifest);
			await writeFile(
				new URL("private.txt", source),
				"not published",
			);
			await writeFile(
				new URL("index.js", source),
				transitive
					? 'import leaf from "local-leaf";export default leaf;'
					: 'export default "exact local contents";',
			);
			if (transitive) {
				const leaf = new URL("packages/leaf/", f.root);
				await mkdir(leaf, { recursive: true });
				await writeFile(
					new URL("package.json", leaf),
					JSON.stringify({
						name: "local-leaf",
						version: "1.0.0",
						type: "module",
						main: "index.js",
					}),
				);
				await writeFile(
					new URL("index.js", leaf),
					'export default "exact local contents";',
				);
				await symlink(
					leaf,
					new URL("node_modules/local-leaf", f.root),
					"dir",
				);
			}
			await symlink(
				source,
				new URL("node_modules/example", f.root),
				"dir",
			);
			await writeFile(
				new URL("index.js", f.server),
				`import local from 'example';
${f.index.replace("return policy;", "return local;")}`,
			);
			const before = await snapshot(join(f.directory, "dist"));
			const registry = {
				resolve: vi.fn(() =>
					Promise.reject(
						new Error("Local content must not query registry"),
					),
				),
			};
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{
						...settings,
						dependencyStrategy: "install",
						includeLocal: true,
					},
					registry,
				),
			);
			expect(await snapshot(join(f.directory, "dist"))).toEqual(
				before,
			);
			expect(registry.resolve).not.toHaveBeenCalled();
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "local-artifact-install-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const lock = await readFile(
				join(isolated, "package-lock.json"),
				"utf8",
			);
			await promisify(execFile)(
				"npm",
				["ci", "--offline", "--no-audit", "--no-fund"],
				{ cwd: isolated },
			);
			const executed = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					"import {handler} from './index.js';process.stdout.write(await handler());",
				],
				{ cwd: isolated },
			);
			expect(executed.stdout).toBe("exact local contents");
			await expect(
				readFile(
					join(isolated, "node_modules/example/private.txt"),
				),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				await readFile(
					join(isolated, "package-lock.json"),
					"utf8",
				),
			).toBe(lock);
			expect(lock).not.toContain(f.directory);
			expect(
				await readFile(new URL("package.json", source), "utf8"),
			).toBe(manifest);
		},
	);

	it.each([
		"linked-root",
		"linked-child",
		"file-copy",
		"pnpm-store",
	])("keeps installed package identity for %s", async (kind) => {
		const f = await fixture();
		const parent = kind === "linked-child";
		await writeFile(
			new URL("index.js", f.server),
			`import '${parent ? "parent" : "example"}';
${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			JSON.stringify({
				name: "app",
				...(kind === "file-copy"
					? {
							dependencies: { example: "file:packages/example" },
						}
					: {}),
			}),
		);
		const actual = new URL(
			kind === "pnpm-store"
				? "node_modules/.pnpm/example@1.0.0/node_modules/example/"
				: "packages/example/",
			f.root,
		);
		await mkdir(actual, { recursive: true });
		await mkdir(new URL("node_modules/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("package.json", actual),
			'{"name":"example","version":"1.0.0"}',
		);
		if (kind === "file-copy")
			await cp(actual, new URL("node_modules/example", f.root), {
				recursive: true,
			});
		else
			await symlink(
				actual,
				new URL("node_modules/example", f.root),
				"dir",
			);
		if (parent) {
			await mkdir(new URL("node_modules/parent/", f.root));
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				'{"name":"parent","version":"1.0.0"}',
			);
		}
		const registry = {
			resolve: vi.fn((name: string) =>
				Promise.resolve({
					version: "1.0.0",
					...(name === "parent"
						? { dependencies: { example: "1.0.0" } }
						: {}),
				}),
			),
		};
		const before = await snapshot(join(f.directory, "dist"));
		const result = await Effect.runPromise(
			Effect.either(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					registry,
				),
			),
		);
		if (kind === "pnpm-store") expect(result._tag).toBe("Right");
		else {
			expect(result._tag).toBe("Left");
			if (result._tag === "Left")
				expect(result.left.message).toMatch(
					/linked local runtime package.*example/,
				);
			expect(
				registry.resolve.mock.calls.map(([name]) => name),
			).not.toContain("example");
		}
		expect(await snapshot(join(f.directory, "dist"))).toEqual(
			before,
		);
	});

	it.each(
		[
			{ member: "createRequire() {}", allowed: true },
			{ member: "static createRequire() {}", allowed: true },
			{ member: "createRequire = 1;", allowed: true },
			{ member: "static createRequire = 1;", allowed: true },
			{ member: "[createRequire]() {}", allowed: false },
			{ member: "value = createRequire;", allowed: false },
		].flatMap((c) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ ...c, dependencyStrategy }),
			),
		),
	)(
		"distinguishes class member keys from loader reads: %j",
		async ({ member, allowed, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import {createRequire} from 'node:module';class C {${member}}
${f.index}`,
			);
			const before = await snapshot(f.directory);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(result._tag).toBe(allowed ? "Right" : "Left");
			if (result._tag === "Left")
				expect(result.left).toMatchObject({
					_tag: "UnresolvedDependency",
				});
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		["nested", "hoisted"].flatMap((placement) =>
			["optionalDependencies", "dependencies"].map(
				(leafKind) => ({ placement, leafKind }),
			),
		),
	)(
		"preserves absent optional pins from $placement with a $leafKind leaf",
		async ({ placement, leafKind }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'parent';
${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app"}',
			);
			await mkdir(new URL("node_modules/parent/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				'{"name":"parent","version":"1.0.0"}',
			);
			const location =
				placement === "nested"
					? "node_modules/parent/node_modules/child"
					: "node_modules/child";
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"node_modules/parent": {
							version: "1.0.0",
							optionalDependencies: { child: "^2" },
						},
						"node_modules/child": {
							version: "2.2.0",
							optional: true,
						},
						[location]: {
							version: "2.1.0",
							optional: true,
							[leafKind]: { leaf: "^3" },
						},
						[`${location}/node_modules/leaf`]: {
							version: "3.1.0",
							optional: true,
							os: ["darwin"],
						},
						"node_modules/leaf": {
							version: "3.2.0",
							optional: true,
						},
					},
				}),
			);
			const registry = {
				resolve: vi.fn(() =>
					Promise.reject(
						new Error(
							"Do not reselect a locked optional version",
						),
					),
				),
			};
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					registry,
				),
			);
			const file = plan.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(file?.kind).toBe("writeFile");
			if (file?.kind !== "writeFile")
				throw new Error("Expected lockfile");
			const lock = JSON.parse(file.contents) as {
				packages: Record<
					string,
					{ version?: string; os?: string[] }
				>;
			};
			for (const [name, expected] of [
				["child", { version: "2.1.0" }],
				["leaf", { version: "3.1.0", os: ["darwin"] }],
			] as const) {
				const entries = Object.entries(lock.packages).filter(
					([path]) => path.endsWith(`node_modules/${name}`),
				);
				expect(entries).toHaveLength(1);
				expect(entries[0]![1]).toMatchObject(expected);
			}
			expect(registry.resolve).not.toHaveBeenCalled();
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		["require", "__require"].flatMap((name) =>
			["factory", "local"].flatMap((kind) =>
				(["bundle", "install"] as const).map(
					(dependencyStrategy) => ({
						name,
						kind,
						dependencyStrategy,
					}),
				),
			),
		),
	)(
		"distinguishes $kind bindings named $name from unbound loaders under $dependencyStrategy",
		async ({ name, kind, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${
					kind === "factory"
						? `import {createRequire as ${name}} from 'node:module'; const load = ${name}(import.meta.url); load('node:path');`
						: `function ${name}(value) {return value;} ${name}(import.meta.url);`
				}
${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it("accounts for every installed context of an identical package version", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import 'a'; import 'b';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		for (const [path, name, version, dependencies] of [
			["a", "a", "1.0.0", { shared: "1.0.0" }],
			["b", "b", "1.0.0", { shared: "1.0.0" }],
			[
				"a/node_modules/shared",
				"shared",
				"1.0.0",
				{ leaf: "^1" },
			],
			[
				"b/node_modules/shared",
				"shared",
				"1.0.0",
				{ leaf: "^1" },
			],
			["a/node_modules/leaf", "leaf", "1.1.0", {}],
			["b/node_modules/leaf", "leaf", "1.2.0", {}],
		] as const) {
			await mkdir(new URL(`node_modules/${path}/`, f.root), {
				recursive: true,
			});
			await writeFile(
				new URL(`node_modules/${path}/package.json`, f.root),
				JSON.stringify({ name, version, dependencies }),
			);
		}
		const before = await snapshot(f.directory);
		const result = await Effect.runPromise(
			Effect.either(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name, version) => {
							const dependencies: Record<string, string> =
								name === "a" || name === "b"
									? { shared: "1.0.0" }
									: name === "shared"
										? { leaf: "^1" }
										: {};
							return Promise.resolve({ version, dependencies });
						},
					},
				),
			),
		);
		if (result._tag === "Left") throw result.left;
		const file = result.right.mutations.find(
			(mutation) =>
				mutation.kind === "writeFile" &&
				mutation.path.pathname.endsWith("package-lock.json"),
		);
		if (file?.kind !== "writeFile")
			throw new Error("Expected lockfile");
		const { packages } = JSON.parse(file.contents) as {
			packages: Record<
				string,
				{
					version?: string;
					dependencies?: Record<string, string>;
				}
			>;
		};
		const root = fileURLToPath(f.server);
		const lookup = (owner: string, name: string) => {
			const paths =
				createRequire(
					join(root, owner, "package.json"),
				).resolve.paths(name) ?? [];
			const location = paths
				.map((modules) =>
					relative(root, join(modules, name)).replaceAll(
						"\\",
						"/",
					),
				)
				.find((path) => Object.hasOwn(packages, path));
			if (!location)
				throw new Error(`Expected ${name} under ${owner}`);
			return location;
		};
		for (const owner of ["node_modules/a", "node_modules/b"])
			expect(packages[owner]?.dependencies?.shared).toBe(
				"1.0.0",
			);
		const sharedA = lookup("node_modules/a", "shared");
		const sharedB = lookup("node_modules/b", "shared");
		expect(sharedA).not.toBe(sharedB);
		for (const [shared, leafVersion] of [
			[sharedA, "1.1.0"],
			[sharedB, "1.2.0"],
		] as const) {
			expect(packages[shared]).toMatchObject({
				version: "1.0.0",
				dependencies: { leaf: leafVersion },
			});
			expect(packages[lookup(shared, "leaf")]).toMatchObject({
				version: leafVersion,
			});
		}
		expect(await snapshot(f.directory)).toEqual(before);
	});

	it.each([
		{
			name: "Astro wrapper",
			body: "export const image = images.renderImage({});",
			expected: true,
		},
		{
			name: "unrelated namespace",
			body: "export const image = images.renderImage({});",
			unrelated: true,
			expected: false,
		},
		{
			name: "shadowing parameter",
			body: "export const image = (images) => images.renderImage({});",
			expected: false,
		},
		{
			name: "destructured parameter",
			body: "export const image = ({images}) => images.renderImage({});",
			expected: false,
		},
		{
			name: "hoisted variable",
			body: "export function image() { return images.renderImage({}); var images; }",
			expected: false,
		},
		{
			name: "shadowing block",
			body: "export function image() { { const images = {}; return images.renderImage({}); } }",
			expected: false,
		},
		{
			name: "unshadowed nested call",
			body: "export function image() { { const images = {}; } return images.renderImage({}); }",
			expected: true,
		},
		{
			name: "parameter initializer",
			body: "export function image(value = images.renderImage({})) { var images; return value; }",
			expected: true,
		},
	])(
		"recognizes Astro image calls through the imported namespace binding: $name",
		async ({ body, unrelated, expected }) => {
			const f = await fixture();
			await writeFile(
				new URL("foo.js", f.server),
				`import * as images from './assets.mjs'; export {images}; ${body}`,
			);
			await writeFile(
				new URL("assets.mjs", f.server),
				unrelated
					? 'export function renderImage(){return "unrelated";}'
					: 'export const config={endpoint:{route:"/_image"}, service:{entrypoint:"astro/service"}}; function getImage(config){return service.getURL(config)} export {getImage as renderImage};',
			);
			expect(
				await hasRuntimeImageCalls(
					f.server,
					[
						{
							entrypoint: "page:foo",
							origin: "project",
							pattern: "/foo",
							isPrerendered: false,
						} as Parameters<
							typeof hasRuntimeImageCalls
						>[1][number],
					],
					new Map(),
				),
			).toBe(expected);
		},
	);

	it.each(
		[
			"default-target",
			"shadowed-target",
			"reassigned-target",
			"redeclared-target",
			"normalize-argument",
			"reassigned-normalizer",
			"unrelated-dispatch",
			"missing-case",
		].flatMap((kind) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ kind, dependencyStrategy }),
			),
		),
	)(
		"rejects dynamic imports outside the recognized Astro logger dispatch: %j",
		async ({ kind, dependencyStrategy }) => {
			const f = await fixture();
			const source = `let z = e => e; async function a(e) { ${kind === "redeclared-target" ? "var" : "let"} n = z(e.entrypoint); ${kind === "redeclared-target" ? "var n = e.config.other;" : ""} switch(e.${kind === "unrelated-dispatch" ? "handler" : "entrypoint"}) {
			case "astro/logger/node": return {};
			case "astro/logger/console": return {};
			case "${kind === "missing-case" ? "custom/json" : "astro/logger/json"}": return {};
			case "astro/logger/compose": ${kind === "reassigned-normalizer" ? "z = () => e.config.other;" : ""} return (e.config?.loggers ?? []).map(async config => import(z(config.${kind === "normalize-argument" ? "custom" : "entrypoint"})));
			default: ${kind === "shadowed-target" ? "{ const n = e.config.other; return import(n); }" : ""} ${kind === "reassigned-target" ? "n = e.config.other;" : ""} return import(${kind === "default-target" ? "process.env.RUNTIME_PACKAGE" : "n"});
		}}`;
			const file =
				kind === "unrelated-dispatch"
					? "chunks/remote-fixture.js"
					: "index.js";
			await mkdir(new URL("chunks/", f.server), {
				recursive: true,
			});
			await writeFile(
				new URL(file, f.server),
				source + (file === "index.js" ? f.index : ""),
			);
			const before = await snapshot(f.directory);
			const outcome = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(outcome).toMatchObject({
				_tag: "Left",
				left: { _tag: "UnresolvedDependency" },
			});
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		[false, true].flatMap((renamed) =>
			(["bundle", "install"] as const).flatMap(
				(dependencyStrategy) =>
					["index.js", "chunks/remote-fixture.js"].map(
						(file) => ({
							renamed,
							dependencyStrategy,
							file,
						}),
					),
			),
		),
	)(
		"retains Astro logger dispatch after identifier minification: %j",
		async ({ renamed, dependencyStrategy, file }) => {
			const f = await fixture();
			const [load, config, target, normalize] = renamed
				? ["a", "e", "n", "z"]
				: [
						"loadLoggerDestination",
						"loggerConfig",
						"entrypoint",
						"normalizeEntrypoint",
					];
			const source = `function ${normalize}(x) { return x instanceof URL ? x.href : x; } async function ${load}(${config}) {
			${renamed ? "let unused," : "const"} ${target} = ${normalize}(${config}.entrypoint);
			switch (${config}.entrypoint) {
				case "astro/logger/node": return {};
				case "astro/logger/console": return {};
				case "astro/logger/json": return {};
				case "astro/logger/compose": return Promise.all((${config}.config?.loggers ?? []).map(async loggerConfig => (await import(${normalize}(loggerConfig.entrypoint))).default(loggerConfig.config)));
				default: return import(${target});
			}
		}`;
			await mkdir(new URL("chunks/", f.server), {
				recursive: true,
			});
			await writeFile(
				new URL(file, f.server),
				source + (file === "index.js" ? f.index : ""),
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		"404#scope.html",
		"404?scope.html",
		"404%20scope.html",
	])("copies the exact raw 404 filename %s", async (name) => {
		const f = await fixture();
		await writeFile(
			pathToFileURL(join(f.directory, "dist/client", name)),
			"<h1>Exact fallback</h1>",
		);
		const routePlan = {
			...f.routePlan,
			routes: f.routePlan.routes.map((route) =>
				route.kind === "prerendered"
					? {
							...route,
							paths: route.paths.map((path) => ({
								...path,
								objectKey: name,
							})),
						}
					: route,
			),
		};
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				routePlan,
				settings,
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const output = await readdir(
			new URL(".yandex/404/", f.server),
		);
		expect(
			await readFile(
				new URL(`.yandex/404/${output[0]!}`, f.server),
				"utf8",
			),
		).toBe("<h1>Exact fallback</h1>");
	});

	it.each(["a#b.js", "a%b.js", "a?b.js"])(
		"preserves emitted filesystem name %s during planning and application",
		async (name) => {
			const f = await fixture();
			await mkdir(new URL("chunks/", f.server));
			const file = pathToFileURL(
				join(f.directory, "dist/function/chunks", name),
			);
			await writeFile(file, "export const value = 42;");
			const before = await snapshot(f.directory);
			const chunksBefore = await snapshot(
				join(f.directory, "dist/function/chunks"),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			expect(
				await snapshot(
					join(f.directory, "dist/function/chunks"),
				),
			).toEqual(chunksBefore);
			expect(await readFile(file, "utf8")).toBe(
				"export const value = 42;",
			);
		},
	);

	it.each(["local", "re-export"])(
		"avoids existing wrapper bindings for a %s handler",
		async (kind) => {
			const f = await fixture();
			await writeFile(
				new URL("app.js", f.server),
				"export function h(event, context, previewUrl, policy) {return policy;}",
			);
			await writeFile(
				new URL("index.js", f.server),
				f.index.replace(
					"export { handler };",
					`const URL = 17; const __yandexArtifactURL = 18; export {URL}; const __yandexArtifactHandler = 1; const __yandexArtifactHandler_ = 2; ${kind === "local" ? "export {handler};" : "export {h as handler} from './app.js';"}`,
				),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const emitted = (await import(
				new URL("index.js", f.server).href
			)) as {
				URL: number;
				handler: (...args: unknown[]) => {
					notFound: unknown[];
					artifactDirectory: URL;
				};
			};
			expect(emitted.URL).toBe(17);
			const policy = emitted.handler({}, {});
			expect(policy.notFound).toHaveLength(1);
			expect(policy.artifactDirectory.href).toBe(f.server.href);
		},
	);

	it.each([
		{
			name: "named re-export",
			barrel:
				'export { renderImage as image } from "./assets.mjs";',
			expected: true,
		},
		{
			name: "import then export",
			barrel:
				'import { renderImage as r } from "./assets.mjs"; export { r as image };',
			expected: true,
		},
		{
			name: "star re-export",
			barrel: 'export * from "./inner.mjs";',
			inner:
				'export { renderImage as image } from "./assets.mjs";',
			expected: true,
		},
		{
			name: "two-level barrel",
			barrel: 'export { image } from "./inner.mjs";',
			inner:
				'export { renderImage as image } from "./assets.mjs";',
			expected: true,
		},
		{
			name: "unrelated export",
			barrel: 'export function image() { return "plain"; }',
			expected: false,
		},
	])(
		"recognizes Astro image calls through a forwarding module: $name",
		async ({ barrel, inner, expected }) => {
			const f = await fixture();
			await writeFile(
				new URL("foo.js", f.server),
				'import { image as a } from "./barrel.mjs"; export const value = a({});',
			);
			await writeFile(new URL("barrel.mjs", f.server), barrel);
			if (inner)
				await writeFile(new URL("inner.mjs", f.server), inner);
			await writeFile(
				new URL("assets.mjs", f.server),
				'export const config={endpoint:{route:"/_image"}, service:{entrypoint:"astro/service"}}; function getImage(config){return service.getURL(config)} export {getImage as renderImage};',
			);
			expect(
				await hasRuntimeImageCalls(
					f.server,
					[
						{
							entrypoint: "page:foo",
							origin: "project",
							pattern: "/foo",
							isPrerendered: false,
						} as Parameters<
							typeof hasRuntimeImageCalls
						>[1][number],
					],
					new Map(),
				),
			).toBe(expected);
		},
	);

	it.each([
		{
			spec: "catalog:",
			workspace: "catalog:\n  renderer: ^1.0.0\n",
			accepted: true,
		},
		{
			spec: "catalog:web",
			workspace: "catalogs:\n  web:\n    'renderer': '^1'\n",
			accepted: true,
		},
		{
			spec: "catalog:",
			workspace: "catalog:\n  renderer: link:../renderer\n",
			accepted: false,
		},
		{ spec: "catalog:", workspace: undefined, accepted: false },
	])(
		"classifies a pnpm $spec requirement by its catalog entry: $workspace",
		async ({ spec, workspace, accepted }) => {
			const f = await fixture();
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify({
					name: "app",
					dependencies: { renderer: spec },
				}),
			);
			if (workspace)
				await writeFile(
					new URL("pnpm-workspace.yaml", f.root),
					workspace,
				);
			await mkdir(new URL("node_modules/renderer/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/renderer/package.json", f.root),
				'{"name":"renderer","version":"1.0.0"}',
			);
			await writeFile(
				new URL("index.js", f.server),
				`import "renderer";\n${f.index}`,
			);
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
							includeLocal: false,
						},
						{
							resolve: () =>
								Promise.resolve({ version: "1.0.0" }),
						},
					),
				),
			);
			if (!accepted) {
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left.message).toMatch(/includeLocal/);
				return;
			}
			if (result._tag === "Left") throw result.left;
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/renderer": { version: "1.0.0" },
				},
			});
		},
	);

	it("reads a PAX size record for the following tarball entry", () => {
		// A valid ustar header, including its mandatory checksum.
		const header = (
			name: string,
			size: number,
			type: string,
		) => {
			const block = Buffer.alloc(512);
			const octal = (value: number, width: number) =>
				value.toString(8).padStart(width - 1, "0") + "\0";
			block.write(name, 0, "utf8");
			block.write(octal(0o644, 8), 100, "ascii");
			block.write(octal(0, 8), 108, "ascii");
			block.write(octal(0, 8), 116, "ascii");
			block.write(octal(size, 12), 124, "ascii");
			block.write(octal(0, 12), 136, "ascii");
			block.write(" ".repeat(8), 148, "ascii");
			block.write(type, 156, "ascii");
			block.write("ustar\0", 257, "ascii");
			block.write("00", 263, "ascii");
			const checksum = block.reduce(
				(sum, byte) => sum + byte,
				0,
			);
			block.write(
				`${checksum.toString(8).padStart(6, "0")}\0 `,
				148,
				"ascii",
			);
			return block;
		};
		const padded = (data: Buffer) =>
			Buffer.concat([
				data,
				Buffer.alloc((512 - (data.length % 512)) % 512),
			]);
		const manifest = Buffer.from(
			JSON.stringify({
				name: "child",
				version: "1.0.0",
				peerDependencies: { host: "^1" },
			}),
		);
		const field = `size=${manifest.length}\n`;
		let length = field.length + 2;
		while (`${length} ${field}`.length !== length) length += 1;
		const record = Buffer.from(`${length} ${field}`);
		const tar = Buffer.concat([
			header("PaxHeader/package.json", record.length, "x"),
			padded(record),
			header("package/node_modules/child/package.json", 0, "0"),
			padded(manifest),
			Buffer.alloc(1024),
		]);
		expect(externalBundledPeers(gzipSync(tar))).toEqual([
			{ child: "node_modules/child", name: "host", range: "^1" },
		]);
	});

	it.each([
		{ kind: "file", ok: true },
		{ kind: "directory", ok: false },
	])(
		"accepts only a regular entrypoint file ($kind)",
		async ({ kind, ok }) => {
			const directory = pathToFileURL(
				(await mkdtemp(join(tmpdir(), "astro-entrypoint-"))) +
					"/",
			);
			directories.push(fileURLToPath(directory));
			if (kind === "file")
				await writeFile(
					new URL("index.js", directory),
					"export {};",
				);
			else await mkdir(new URL("index.js/", directory));
			expect(
				await validateFunctionEntrypoint(directory),
			).toMatchObject({
				ok,
			});
		},
	);

	it.each([
		{ server: "client/", overlaps: true },
		{ server: "", overlaps: true },
		{ server: "client/nested/", overlaps: true },
		{ server: "function/", overlaps: false },
		{ server: "function/", linkedClient: true, overlaps: true },
	])(
		"guards server output removal against the client output ($server, linked client: $linkedClient)",
		async ({ server, overlaps, linkedClient }) => {
			const f = await fixture();
			let client = f.build.config.build.client;
			if (linkedClient) {
				// The configured paths look like siblings, but the client resolves inside the server.
				await mkdir(
					new URL("function/site/", f.build.config.outDir),
					{
						recursive: true,
					},
				);
				client = new URL(
					"linked-client/",
					f.build.config.outDir,
				);
				await symlink(
					fileURLToPath(
						new URL("function/site", f.build.config.outDir),
					),
					fileURLToPath(
						new URL("linked-client", f.build.config.outDir),
					),
					"dir",
				);
			}
			const build = {
				...f.build,
				config: {
					...f.build.config,
					build: {
						...f.build.config.build,
						client,
						server: new URL(server, f.build.config.outDir),
					},
				},
			};
			const routePlan = {
				...f.routePlan,
				routes: f.routePlan.routes.filter(
					(route) => route.kind === "prerendered",
				),
			};
			const before = await snapshot(f.directory);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(
					build,
					routePlan,
					settings,
				),
			);
			if (overlaps)
				await expect(planning).rejects.toThrow(
					/overlaps the client output/,
				);
			else
				expect((await planning).mutations).toEqual([
					{
						kind: "removeDirectory",
						path: build.config.build.server,
					},
				]);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		"event",
		"context",
		"previewUrl",
		// Escaped spellings decode to the generated wrapper names.
		"__yandexArtifactArg\\u0075ments",
		"__yandexArtifact\\u0055RL",
	])(
		"invokes a handler whose local binding is named %s",
		async (name) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				f.index.replace(
					"export { handler };",
					`const ${name} = handler; export { ${name} as handler };`,
				),
			);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const emitted = (await import(
				new URL("index.js", f.server).href
			)) as {
				handler: (...args: unknown[]) => {
					notFound: unknown[];
					artifactDirectory: URL;
				};
			};
			const policy = emitted.handler(
				{ httpMethod: "GET", url: "/" },
				{ requestId: "1" },
				"/preview",
			);
			expect(policy.notFound).toHaveLength(1);
			expect(policy.artifactDirectory.href).toBe(f.server.href);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps public export labels separate from lexical loader reads (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				"import {createRequire} from 'node:module';const value = createRequire(import.meta.url)('node:path').sep;export {value as createRequire};" +
					f.index,
			);
			const before = await snapshot(f.directory);
			await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it("pins nested optional lock entries when the application root is a symlink", async () => {
		const f = await fixture();
		const aliasParent = await mkdtemp(
			join(tmpdir(), "astro-linked-root-"),
		);
		directories.push(aliasParent);
		const alias = join(aliasParent, "app");
		await symlink(f.directory, alias, "dir");
		await mkdir(new URL("node_modules/helper/", f.root), {
			recursive: true,
		});
		const pkg = {
			name: "helper",
			version: "1.0.0",
			optionalDependencies: { platform: "^2" },
		};
		await writeFile(
			new URL("node_modules/helper/package.json", f.root),
			JSON.stringify(pkg),
		);
		await writeFile(
			new URL("package-lock.json", f.root),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"node_modules/helper": pkg,
					"node_modules/helper/node_modules/platform": {
						version: "2.1.0",
						resolved: "https://registry.example/platform.tgz",
						integrity: "sha512-platform",
						optional: true,
					},
				},
			}),
		);
		await writeFile(
			new URL("index.js", f.server),
			"import 'helper';" + f.index,
		);
		const before = await snapshot(f.directory);
		const resolve = vi.fn(() =>
			Promise.reject(
				new Error(
					"Unexpected registry lookup with a committed lock",
				),
			),
		);
		const linked = {
			...f.build,
			config: {
				...f.build.config,
				root: pathToFileURL(alias + "/"),
			},
		};
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				linked,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{ resolve },
			),
		);
		expect(resolve).not.toHaveBeenCalled();
		expect(await snapshot(f.directory)).toEqual(before);
		const lock = plan.mutations.find(
			(m) =>
				m.kind === "writeFile" &&
				m.path.pathname.endsWith("package-lock.json"),
		);
		expect(
			lock?.kind === "writeFile" && JSON.parse(lock.contents),
		).toMatchObject({
			packages: {
				"node_modules/platform": {
					version: "2.1.0",
					resolved: "https://registry.example/platform.tgz",
					integrity: "sha512-platform",
					optional: true,
				},
			},
		});
	});

	it.each(
		[
			"export {createRequire as make} from 'node:module';",
			"export {default as mod} from 'module';",
			"export {Module as mod} from 'node:module';",
			"export * as mod from 'node:module';",
			"export * from 'module';",
			"export {'createRequire' as make} from 'node:module';",
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ source, dependencyStrategy }),
			),
		),
	)(
		"rejects untracked builtin loader re-exports: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(new URL("bridge.js", f.server), source);
			const before = await snapshot(f.directory);
			const outcome = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(outcome).toMatchObject({
				_tag: "Left",
				left: {
					_tag: "UnresolvedDependency",
					message: expect.stringMatching(
						/unresolved dynamic/,
					) as string,
				},
			});
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);
	it.each([
		{ exported: "h as handler, other", other: true },
		{ exported: "default as handler, other", other: true },
		{ exported: "h as handler", other: false },
	])(
		"links a policy-wrapped handler re-export: $exported",
		async ({ exported, other }) => {
			const f = await fixture();
			await mkdir(new URL("chunks/", f.server));
			await writeFile(
				new URL("chunks/app.js", f.server),
				"export function h(event, context, previewUrl, policy) {return policy;} export default h; export const other = 23;",
			);
			await writeFile(
				new URL("index.js", f.server),
				f.index.replace(
					"export { handler };",
					`const __yandexOriginalHandler = 1; export {${exported}} from './chunks/app.js';`,
				),
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			);
			expect(await snapshot(f.directory)).toEqual(before);
			const output = await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const artifact = output.functions[0]!;
			const emitted = (await import(
				new URL("index.js", artifact.directory).href
			)) as {
				other?: number;
				handler(
					event: unknown,
					context: unknown,
				): { artifactDirectory: URL; notFound: unknown[] };
			};
			expect(emitted.other).toBe(other ? 23 : undefined);
			const policy = emitted.handler({}, {});
			expect(policy.artifactDirectory.href).toBe(
				artifact.directory.href,
			);
			expect(policy.notFound).toHaveLength(1);
		},
	);

	it("plans the complete artifact without mutations, then applies handlers, 404 and metadata", async () => {
		const f = await fixture();
		const before = await snapshot(f.directory);
		const routesBefore = JSON.stringify(f.routePlan);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(f.build, f.routePlan, {
				...settings,
			}),
		);
		expect(await snapshot(f.directory)).toEqual(before);
		expect(JSON.stringify(f.routePlan)).toBe(routesBefore);
		expect(plan.plannedOutput.functions).toHaveLength(1);
		for (const artifact of plan.plannedOutput.functions) {
			const writes = plan.mutations.filter(
				(mutation) =>
					mutation.kind === "writeFile" &&
					mutation.path.href ===
						new URL("index.js", artifact.directory).href,
			);
			expect(writes).toHaveLength(1);
		}
		const output = await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		expect(output).toBe(plan.plannedOutput);
		for (const artifact of output.functions) {
			const source = await readFile(
				new URL("index.js", artifact.directory),
				"utf8",
			);
			expect(source).toContain("const __yandexArtifactHandler");
			expect(source).toContain(".yandex/404/");
			const pages = await readdir(
				new URL(".yandex/404/", artifact.directory),
			);
			expect(pages).toHaveLength(1);
			expect(
				await readFile(
					new URL(
						`.yandex/404/${pages[0]!}`,
						artifact.directory,
					),
					"utf8",
				),
			).toBe("<h1>Missing</h1>");
			expect(
				JSON.parse(
					await readFile(
						new URL("package.json", artifact.directory),
						"utf8",
					),
				),
			).toMatchObject({ type: "module", dependencies: {} });
		}
		expect(
			await readFile(new URL("asset.bin", f.server)),
		).toEqual(Buffer.from([0, 1, 127, 255]));
		expect(
			await readFile(new URL("bar.js", f.server), "utf8"),
		).toContain("export const bar");
	});

	it("plans empty runtime output without deleting it until application", async () => {
		const f = await fixture();
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				{ ...f.routePlan, routes: [] },
				settings,
			),
		);
		expect(plan.plannedOutput.functions).toEqual([]);
		expect(
			await readFile(new URL("index.js", f.server), "utf8"),
		).toBe(f.index);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		await expect(access(f.server)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("does not mutate output when dependency validation fails during planning", async () => {
		const f = await fixture();
		await writeFile(
			new URL("unsupported.cjs", f.server),
			"module.exports = {};\n",
		);
		const before = await snapshot(f.directory);
		const outcome = await Effect.runPromise(
			Effect.either(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			),
		);
		expect(outcome).toMatchObject({
			_tag: "Left",
			left: { _tag: "UnresolvedDependency" },
		});
		expect(await snapshot(f.directory)).toEqual(before);
	});

	it("does not read a malformed lockfile for a builtins-only install artifact", async () => {
		const f = await fixture();
		await writeFile(
			new URL("package-lock.json", f.root),
			"{ invalid json",
		);
		await writeFile(
			new URL("index.js", f.server),
			`import 'node:path';${f.index}`,
		);
		const before = await snapshot(f.directory);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(f.build, f.routePlan, {
				...settings,
				dependencyStrategy: "install",
			}),
		);
		const lock = plan.mutations.find(
			(file) =>
				file.kind === "writeFile" &&
				file.path.pathname.endsWith("package-lock.json"),
		);
		if (lock?.kind !== "writeFile")
			throw new Error("Expected lockfile");
		expect(
			Object.keys(
				(JSON.parse(lock.contents) as { packages: object })
					.packages,
			),
		).toEqual([""]);
		expect(await snapshot(f.directory)).toEqual(before);
	});

	it.each([true, false])(
		"validates omitted local archive files used at runtime (%s)",
		async (missingRuntimeFile) => {
			const f = await fixture();
			const linked = new URL("packages/linked/", f.root);
			await mkdir(linked, { recursive: true });
			await mkdir(new URL("node_modules/", f.root));
			await symlink(
				linked,
				new URL("node_modules/linked", f.root),
				"dir",
			);
			await writeFile(
				new URL("package.json", linked),
				JSON.stringify({
					name: "linked",
					version: "1.0.0",
					type: "module",
					exports: {
						types: "./internal.d.ts",
						default: "./index.js",
					},
					files: missingRuntimeFile
						? ["index.js"]
						: ["index.js", "helper.js"],
					scripts: { prepare: "exit 2" },
				}),
			);
			await writeFile(
				new URL("index.js", linked),
				'export { default } from "./helper.js";',
			);
			await writeFile(
				new URL("helper.js", linked),
				'export default "local helper";',
			);
			await writeFile(
				new URL("internal.d.ts", linked),
				"export default function run(): string;",
			);
			await writeFile(
				new URL("index.js", f.server),
				`import 'linked';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
					includeLocal: true,
				}),
			);
			if (missingRuntimeFile)
				await expect(planning).rejects.toThrow(
					/archive.*omits helper\.js/,
				);
			else
				expect(
					(await planning).plannedOutput.functions,
				).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		{
			mode: "pattern target omitted",
			excluded: "src/features/a.js",
		},
		{
			mode: "pattern import omitted",
			excluded: "src/helper.js",
		},
		{ mode: "pattern complete" },
		{
			mode: "directory main omitted",
			excluded: "nested/main.cjs",
		},
		{
			mode: "directory manifest omitted",
			excluded: "nested/package.json",
		},
		{ mode: "directory complete" },
	])(
		"validates resolver-selected local archive files ($mode)",
		async ({ mode, excluded }) => {
			const f = await fixture();
			const linked = new URL("packages/linked/", f.root);
			const pattern = mode.startsWith("pattern");
			const files: Record<string, string> = pattern
				? {
						"src/features/a.js":
							'export { default } from "../helper.js";',
						"src/features/internal/private.js":
							'export default "private";',
						"src/helper.js": 'export default "pattern helper";',
					}
				: {
						"index.cjs": 'module.exports = require("./nested");',
						"nested/package.json": '{"main":"main.cjs"}',
						"nested/main.cjs":
							'module.exports = "selected main";',
						"nested/index.js":
							'module.exports = "fallback index";',
					};
			for (const [path, contents] of Object.entries(files)) {
				await mkdir(new URL(".", new URL(path, linked)), {
					recursive: true,
				});
				await writeFile(new URL(path, linked), contents);
			}
			await writeFile(
				new URL("package.json", linked),
				JSON.stringify({
					name: "linked",
					version: "1.0.0",
					type: pattern ? "module" : "commonjs",
					exports: pattern
						? {
								"./features/*": {
									default: "./src/features/*.js",
								},
								"./features/internal/*": null,
							}
						: "./index.cjs",
					files: Object.keys(files).filter(
						(path) => path !== excluded,
					),
				}),
			);
			await mkdir(new URL("node_modules/", f.root));
			await symlink(
				linked,
				new URL("node_modules/linked", f.root),
				"dir",
			);
			const specifier = pattern ? "linked/features/a" : "linked";
			const require = createRequire(
				new URL("package.json", f.root),
			);
			if (pattern) {
				expect(require.resolve(specifier)).toBe(
					await realpath(new URL("src/features/a.js", linked)),
				);
				expect(() => {
					require.resolve("linked/features/internal/private");
				}).toThrow(/not defined by "exports"/);
				expect(
					require.resolve("linked/features/%69nternal/private"),
				).toBe(
					await realpath(
						new URL("src/features/internal/private.js", linked),
					),
				);
			} else expect(require(specifier)).toBe("selected main");
			await writeFile(
				new URL("index.js", f.server),
				`import '${specifier}';${f.index}`,
			);
			const before = await snapshot(f.directory);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
					includeLocal: true,
				}),
			);
			if (excluded)
				await expect(planning).rejects.toThrow(
					`omits ${excluded}`,
				);
			else
				expect(
					(await planning).plannedOutput.functions,
				).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	type ArchiveResolutionCase = {
		name: string;
		files: Record<string, string>;
		pattern?: unknown;
		specifier?: string;
		manifest?: Record<string, unknown>;
		omitted?: string;
		omissionAllowed?: boolean;
		required?: string;
		alsoResolves?: Record<string, string>;
		installedFiles?: Record<string, string>;
		fmtBinding?: "absent" | "shared" | "symlink" | "distinct";
		imported?: string;
		emittedLoader?:
			"require" | "require-resolve" | "import-resolve";
		bracketResolver?: boolean;
		rejection?: string;
		manifestBom?: boolean;
		esmProbe?: "directory-error" | "url";
		alsoImport?: boolean;
	};
	it.each<ArchiveResolutionCase>([
		{
			name: "decodes the directory of an export pattern",
			pattern: "./src/my%20features/*.cjs",
			files: {
				"src/my features/a.cjs": 'module.exports = "encoded";',
			},
			omitted: "src/my features/a.cjs",
			required: "encoded",
		},
		{
			name: "retains the decoded export target",
			pattern: "./src/my%20features/*.cjs",
			files: {
				"src/my features/a.cjs": 'module.exports = "encoded";',
			},
			required: "encoded",
		},
		{
			name: "ignores a default export shadowed by the node condition",
			pattern: {
				node: "./node/*.cjs",
				default: "./fallback/*.cjs",
			},
			files: {
				"node/a.cjs": 'module.exports = "node";',
				"fallback/a.cjs": 'module.exports = "default";',
			},
			omitted: "fallback/a.cjs",
			omissionAllowed: true,
			required: "node",
			imported: "node",
		},
		{
			name: "probes the next condition if the selected condition has no matching child",
			pattern: {
				node: { browser: "./browser/*.cjs" },
				default: "./fallback/*.cjs",
			},
			files: {
				"browser/a.cjs": 'module.exports = "browser";',
				"fallback/a.cjs": 'module.exports = "default";',
			},
			omitted: "browser/a.cjs",
			omissionAllowed: true,
			required: "default",
			imported: "default",
		},
		...(["esm/a.mjs", "cjs/a.cjs", undefined] as const).map(
			(omitted) => ({
				name: omitted
					? `checks both Node loaders when ${omitted} is omitted`
					: "preserves different wildcard targets for import and require after installation",
				pattern: {
					import: "./esm/*.mjs",
					require: "./cjs/*.cjs",
				},
				files: {
					"esm/a.mjs": 'export default "import";',
					"cjs/a.cjs": 'module.exports = "require";',
				},
				omitted,
				required: "require",
				imported: "import",
			}),
		),
		{
			name: "requires the fallback index's format-defining package scope",
			files: {
				"index.cjs":
					'module.exports = require("./nested").default;',
				"nested/index.js": 'export default "module index";',
				"nested/package.json": '{"type":"module"}',
			},
			omitted: "nested/package.json",
			required: "module index",
		},
		{
			name: "accepts a fallback index without a separate package scope",
			files: {
				"index.cjs": 'module.exports = require("./nested");',
				"nested/index.js": 'module.exports = "regular index";',
			},
			required: "regular index",
		},
		{
			name: "follows require in an extensionless file",
			files: {
				"index.cjs": 'module.exports = require("./run");',
				run: 'module.exports = require("./helper.cjs");',
				"helper.cjs": 'module.exports = "helper";',
			},
			omitted: "helper.cjs",
			required: "helper",
		},
		{
			name: "follows require before a CommonJS top-level return",
			files: {
				"index.cjs":
					'module.exports = require("./helper.cjs"); return;',
				"helper.cjs": 'module.exports = "wrapped";',
			},
			omitted: "helper.cjs",
			required: "wrapped",
		},
		...(["./nested/.", "./nested/", "./nested"] as const).map(
			(specifier) => ({
				name: `preserves CommonJS lookup intent for ${specifier}`,
				files: {
					"index.cjs": `module.exports = require(${JSON.stringify(specifier)});`,
					"nested.js": 'module.exports = "file";',
					"nested/package.json": '{"main":"main.cjs"}',
					"nested/main.cjs": 'module.exports = "directory";',
				},
				omitted: "nested/main.cjs",
				omissionAllowed: specifier === "./nested",
				required:
					specifier === "./nested" ? "file" : "directory",
			}),
		),
		...[
			"./../outside.cjs",
			"./dist/%2e%2e/invalid.cjs",
			"./node_modules/invalid.cjs",
		].map((invalid) => ({
			name: "skips an invalid package export target " + invalid,
			manifest: { exports: [invalid, "./dist/entry.cjs"] },
			files: {
				"dist/entry.cjs": 'module.exports = "array entry";',
			},
			omitted: "dist/entry.cjs",
			required: "array entry",
		})),
		{
			name: "does not fall through a valid missing export target",
			manifest: { exports: ["./missing.cjs", "./fallback.cjs"] },
			files: { "fallback.cjs": 'module.exports = "fallback";' },
			omitted: "fallback.cjs",
			omissionAllowed: true,
		},
		{
			name: "checks the root index after an unresolved legacy main",
			manifest: {
				exports: undefined,
				main: "./dist/missing.js",
			},
			files: {
				"index.js": 'module.exports = require("./helper.cjs");',
				"helper.cjs": 'module.exports = "legacy fallback";',
			},
			omitted: "helper.cjs",
			required: "legacy fallback",
		},
		{
			name: "retains Node's legacy main priority over a root index",
			manifest: { exports: undefined, main: "./dist/entry" },
			files: {
				"index.js": 'module.exports = require("./unused.cjs");',
				"unused.cjs": 'module.exports = "unused";',
				"dist/entry.js": 'module.exports = "legacy main";',
			},
			omitted: "unused.cjs",
			omissionAllowed: true,
			required: "legacy main",
		},
		...([false, true] as const).flatMap(
			(complete): ArchiveResolutionCase[] => [
				{
					name: `checks a legacy ESM subpath (complete: ${complete})`,
					specifier: "linked/tools.cjs",
					manifest: { exports: null },
					files: {
						"index.js": 'module.exports = "root";',
						"tools.cjs": 'module.exports = "legacy tools";',
					},
					omitted: complete ? undefined : "tools.cjs",
					required: "legacy tools",
					imported: "legacy tools",
				},
				{
					name: `checks a legacy CommonJS directory subpath (complete: ${complete})`,
					specifier: "linked/tools",
					emittedLoader: "require" as const,
					manifest: { exports: null },
					files: {
						"index.js": 'module.exports = "root";',
						"tools/package.json": '{"main":"./entry.js"}',
						"tools/entry.js":
							'module.exports = require("./helper.json");',
						"tools/helper.json": '"legacy directory"',
					},
					omitted: complete ? undefined : "tools/helper.json",
					required: "legacy directory",
				},
			],
		),
		...(["tools", "tools/.", "tools/sub/.."] as const).map(
			(request) => ({
				name: `matches Node's CommonJS lookup for ${request} with a sibling file`,
				specifier: `linked/${request}`,
				emittedLoader: "require" as const,
				manifest: { exports: null },
				files: {
					"index.js": 'module.exports = "root";',
					"tools.js": 'module.exports = "file";',
					"tools/package.json": '{"main":"./entry.js"}',
					"tools/sub/marker.txt": "keeps the subdirectory",
					"tools/entry.js": 'module.exports = "directory";',
				},
				omitted: "tools/entry.js",
				omissionAllowed: request === "tools",
				required: request === "tools" ? "file" : "directory",
			}),
		),
		...(
			[
				{
					emittedLoader: "require-resolve",
					bracketResolver: false,
				},
				{
					emittedLoader: "require-resolve",
					bracketResolver: true,
				},
				{
					emittedLoader: "import-resolve",
					bracketResolver: false,
				},
			] as const
		).flatMap(({ emittedLoader, bracketResolver }) =>
			[false, true].map((omitSelected) => ({
				name: bracketResolver
					? `checks bracket resolver (selected file omitted: ${omitSelected})`
					: `checks ${emittedLoader} (selected file omitted: ${omitSelected})`,
				specifier: "linked/tools%20tag.cjs",
				emittedLoader,
				bracketResolver,
				manifest: { exports: null },
				files: {
					"index.js": 'module.exports = "root";',
					"tools%20tag.cjs":
						'module.exports = "literal filename";',
					"tools tag.cjs": 'module.exports = "URL pathname";',
				},
				omitted:
					(emittedLoader === "require-resolve") === omitSelected
						? "tools%20tag.cjs"
						: "tools tag.cjs",
				// require.resolve requires the file; import.meta.resolve only forms its URL.
				omissionAllowed:
					emittedLoader === "import-resolve" || !omitSelected,
				required:
					emittedLoader === "require-resolve"
						? "literal filename"
						: undefined,
				...(emittedLoader === "import-resolve"
					? {
							esmProbe: "url" as const,
							imported: "tools%20tag.cjs",
						}
					: {}),
			})),
		),
		{
			name: "follows an extensionless exact ESM entry",
			manifest: { exports: "./entry", type: "module" },
			files: {
				entry:
					'import value from "./helper.js"; export { value }; export default value;',
				"helper.js": 'export default "extensionless exact";',
			},
			omitted: "helper.js",
			imported: "extensionless exact",
			required: "extensionless exact",
		},
		{
			name: "treats an extensionless URL asset as payload",
			manifest: { exports: "./index.mjs", type: "module" },
			files: {
				"index.mjs":
					'export default new URL("./notes", import.meta.url).pathname.endsWith("notes") ? "asset" : "other";',
				notes: 'require("./unused.cjs");',
				"unused.cjs": 'module.exports = "unused";',
			},
			omitted: "unused.cjs",
			omissionAllowed: true,
			required: "asset",
		},
		...(["exact", "pattern", "require"] as const).map(
			(mode) => ({
				name: "checks a local private import using " + mode,
				manifest:
					mode === "require"
						? {
								imports: {
									"#feature": {
										import: "./unreachable.cjs",
										require: "./features/actual.cjs",
									},
								},
							}
						: {
								exports: "./index.mjs",
								imports:
									mode === "pattern"
										? { "#feature/*": "./features/*.cjs" }
										: { "#feature": "./features/actual.cjs" },
							},
				files: Object.fromEntries([
					mode === "require"
						? [
								"index.cjs",
								'module.exports = require("#feature");',
							]
						: [
								"index.mjs",
								"export { default } from " +
									JSON.stringify(
										mode === "pattern"
											? "#feature/actual"
											: "#feature",
									) +
									";",
							],
					[
						"features/actual.cjs",
						'module.exports = "private entry";',
					],
				]),
				omitted: "features/actual.cjs",
				required: "private entry",
			}),
		),
		{
			name: "uses the importing file's own package scope",
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"nested/index.cjs":
					'module.exports = require("#feature");',
				"nested/package.json":
					'{"imports":{"#feature":"./actual.cjs"}}',
				"nested/actual.cjs":
					'module.exports = "nested private entry";',
			},
			omitted: "nested/actual.cjs",
			required: "nested private entry",
		},
		{
			name: "preserves the manifest needed by a private import",
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"nested/index.cjs":
					'module.exports = require("#feature");',
				"nested/package.json":
					'{"imports":{"#feature":"./actual.cjs"}}',
				"nested/actual.cjs":
					'module.exports = "nested private entry";',
			},
			omitted: "nested/package.json",
			required: "nested private entry",
		},
		{
			name: "does not interpret an external private import as a local path",
			manifest: {
				exports: "./index.mjs",
				imports: { "#os-path": ["path", "./unused.cjs"] },
			},
			files: {
				"index.mjs":
					'import value from "#os-path"; export default typeof value.join;',
				"unused.cjs": 'module.exports = "unused";',
			},
			omitted: "unused.cjs",
			omissionAllowed: true,
			required: "function",
		},
		{
			name: "ignores CommonJS loader names shadowed by parameters",
			files: {
				"index.cjs":
					'function render(require) { return require("./fixture.cjs"); } module.exports = render(x => x); return;',
				"fixture.cjs": 'module.exports = "unused";',
			},
			omitted: "fixture.cjs",
			omissionAllowed: true,
			required: "./fixture.cjs",
		},
		{
			name: "retains explicit Node createRequire bindings",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs":
					'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); export default require("./helper.cjs");',
				"helper.cjs": 'module.exports = "explicit loader";',
			},
			omitted: "helper.cjs",
			required: "explicit loader",
		},
		{
			name: "requires a URL asset without a leading dot",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs":
					'import {readFileSync} from "node:fs"; export default readFileSync(new URL("payload.txt", import.meta.url), "utf8");',
				"payload.txt": "runtime data",
			},
			omitted: "payload.txt",
			required: "runtime data",
		},
		{
			name: "checks a wildcard reached by the encoded spelling of an overridden export",
			specifier: "linked/features/a%20b",
			manifest: {
				exports: {
					"./features/*": "./src/*.cjs",
					"./features/a b": "./override.cjs",
				},
			},
			files: {
				"src/a b.cjs": 'module.exports = "encoded wildcard";',
				"override.cjs": 'module.exports = "raw override";',
			},
			omitted: "src/a b.cjs",
			required: "encoded wildcard",
		},
		{
			name: "checks a reachable wildcard when raw and canonical spellings use exact exports",
			specifier: "linked/features/%61%20b",
			manifest: {
				exports: {
					"./features/*": "./src/*.cjs",
					"./features/a b": "./override.cjs",
					"./features/a%20b": "./override.cjs",
				},
			},
			files: {
				"src/a b.cjs": 'module.exports = "unused";',
				"override.cjs": 'module.exports = "override";',
			},
			omitted: "src/a b.cjs",
			alsoResolves: {
				"linked/features/a b": "override",
				"linked/features/a%20b": "override",
			},
			required: "unused",
			imported: "unused",
		},
		{
			name: "ignores an asset of a shadowed URL constructor",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs":
					'const URL = class { constructor(value) { this.value = value; } }; export default new URL("payload.txt", import.meta.url).value;',
				"payload.txt": "unused",
			},
			omitted: "payload.txt",
			omissionAllowed: true,
			required: "payload.txt",
		},
		{
			name: "rejects a relative import outside the package",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs": 'export { default } from "../shared.mjs";',
			},
			installedFiles: {
				"packages/shared.mjs": 'export default "shared";',
			},
			required: "shared",
			rejection: "outside the package",
		},
		{
			name: "scans an extensionless CommonJS file required from a module scope",
			manifest: { type: "module" },
			files: {
				"index.cjs": 'module.exports = require("./run");',
				run: 'module.exports = require("./helper.cjs");',
				"helper.cjs": 'module.exports = "helper";',
			},
			omitted: "helper.cjs",
			required: "helper",
		},
		{
			name: "scans CommonJS reached through an unregistered extension",
			files: {
				"index.cjs":
					'module.exports = require("./adapter.cts");',
				"adapter.cts":
					'module.exports = require("./helper.cjs");',
				"helper.cjs": 'module.exports = "helper";',
			},
			omitted: "helper.cjs",
			required: "helper",
		},
		{
			name: "allows a resolve-only request for an omitted file",
			specifier: "linked/templates.js",
			manifest: { exports: undefined },
			files: {
				"index.cjs": 'module.exports = "index";',
				"templates.js": 'module.exports = "templates";',
			},
			omitted: "templates.js",
			omissionAllowed: true,
			emittedLoader: "import-resolve",
			esmProbe: "url",
			imported: "templates.js",
		},
		{
			name: "does not scan a JavaScript-shaped URL asset as a module",
			manifest: { exports: "./index.mjs", type: "module" },
			files: {
				"index.mjs":
					'import {readFileSync} from "node:fs"; export default String(readFileSync(new URL("./template.js", import.meta.url), "utf8").includes("sample"));',
				"template.js": 'import "./sample.js";',
				"sample.js": 'export default "sample";',
			},
			omitted: "sample.js",
			omissionAllowed: true,
			required: "true",
		},
		{
			name: "scans a JavaScript file also reached by a module edge",
			manifest: { exports: "./index.mjs", type: "module" },
			files: {
				"index.mjs":
					'import "./template.js"; export default new URL("./template.js", import.meta.url).pathname.endsWith("template.js") ? "module" : "other";',
				"template.js": 'import "./sample.js";',
				"sample.js": 'export default "sample";',
			},
			omitted: "sample.js",
			required: "module",
		},
		...(
			[
				{
					name: "root selects a file",
					manifest: { imports: { "#feature": "./root.cjs" } },
					omissionAllowed: false,
				},
				{
					name: "root has no imports map",
					manifest: {},
					omissionAllowed: false,
				},
				{
					name: "root blocks the private import",
					manifest: { imports: { "#feature": null } },
					omissionAllowed: true,
				},
				{
					name: "root has an empty imports map",
					manifest: { imports: {} },
					omissionAllowed: true,
				},
			] as const
		).map(({ name, manifest, omissionAllowed }) => ({
			name: `preserves the require error when ${name}`,
			manifest,
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"root.cjs": 'module.exports = "root";',
				"nested/index.cjs":
					'try { module.exports = require("#feature"); } catch (error) { if (error.code !== "ERR_PACKAGE_IMPORT_NOT_DEFINED") throw error; module.exports = "fallback"; }',
				"nested/package.json": '{"imports":{"#feature":null}}',
			},
			omitted: "nested/package.json",
			omissionAllowed,
			required: "fallback",
		})),
		{
			name: "follows the wrapper require before a later var initializer",
			files: {
				"index.cjs":
					'module.exports = require("./helper.cjs"); var require = value => value;',
				"helper.cjs": 'module.exports = "wrapper loader";',
			},
			omitted: "helper.cjs",
			required: "wrapper loader",
		},
		{
			name: "does not use the wrapper require after an unconditional initializer",
			files: {
				"index.cjs":
					'var require = value => value; module.exports = require("./helper.cjs");',
				"helper.cjs": 'module.exports = "unused";',
			},
			omitted: "helper.cjs",
			omissionAllowed: true,
			required: "./helper.cjs",
		},
		{
			name: "retains the wrapper require when a conditional initializer need not execute",
			files: {
				"index.cjs":
					'if (false) { var require = value => value; } module.exports = require("./helper.cjs");',
				"helper.cjs":
					'module.exports = "conditional wrapper loader";',
			},
			omitted: "helper.cjs",
			required: "conditional wrapper loader",
		},
		{
			name: "ignores a new.target asset base",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs":
					'class Result { static url = "https://example.test/"; constructor() { this.path = new URL("payload.txt", new.target.url).href; } } export default new Result().path;',
				"payload.txt": "unused",
			},
			omitted: "payload.txt",
			omissionAllowed: true,
			required: "https://example.test/payload.txt",
		},
		{
			name: "keeps bracket-form import.meta URLs",
			manifest: { exports: "./index.mjs" },
			files: {
				"index.mjs":
					'import { readFileSync } from "node:fs"; export default readFileSync(new URL("payload.txt", import.meta["url"]), "utf8");',
				"payload.txt": "bracket asset",
			},
			omitted: "payload.txt",
			required: "bracket asset",
		},
		{
			name: "finds a partially escaped wildcard when every initial spelling is overridden",
			specifier: "linked/features/%61%20b",
			manifest: {
				exports: {
					"./features/*": "./src/*.cjs",
					"./features/a b": "./override.cjs",
					"./features/a%20b": "./override.cjs",
					"./features/%61%20%62": "./override.cjs",
				},
			},
			files: {
				"src/a b.cjs": 'module.exports = "partial";',
				"override.cjs": 'module.exports = "override";',
			},
			omitted: "src/a b.cjs",
			required: "partial",
		},
		{
			name: "checks encoded wildcard paths past a literal pattern exclusion",
			specifier: "linked/features/%69nternal/private",
			manifest: {
				exports: {
					"./features/*": "./src/*.cjs",
					"./features/internal/*": null,
				},
			},
			files: {
				"src/internal/private.cjs":
					'module.exports = "encoded bypass";',
			},
			omitted: "src/internal/private.cjs",
			required: "encoded bypass",
		},
		{
			name: "keeps wildcard files reached through a URL-normalized spelling",
			specifier: "linked/features/%2\t7",
			manifest: {
				exports: {
					"./features/*": "./src/*.cjs",
					"./features/'": "./override.cjs",
					"./features/%27": "./override.cjs",
				},
			},
			files: {
				"src/'.cjs": 'module.exports = "normalized wildcard";',
				"override.cjs": 'module.exports = "override";',
			},
			omitted: "src/'.cjs",
			required: "normalized wildcard",
			alsoResolves: {
				"linked/features/'": "override",
				"linked/features/%27": "override",
			},
		},
		{
			name: "checks the fallback after an invalid self export in a private target array",
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"nested/index.cjs":
					'module.exports = require("#feature");',
				"nested/package.json": JSON.stringify({
					name: "inner",
					imports: {
						"#feature": ["inner/feature", "./fallback.cjs"],
					},
					exports: { "./feature": "invalid-target" },
				}),
				"nested/fallback.cjs": 'module.exports = "fallback";',
			},
			omitted: "nested/fallback.cjs",
			required: "fallback",
		},
		...([true, false] as const).map((exported) => ({
			name: `does not retry a private target array for a ${exported ? "missing file" : "blocked subpath"}`,
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"nested/index.cjs":
					'try { module.exports = require("#feature"); } catch (error) { module.exports = error.code; }',
				"nested/package.json": JSON.stringify({
					name: "inner",
					imports: {
						"#feature": ["inner/feature", "./fallback.cjs"],
					},
					exports: {
						"./feature": exported ? "./missing.cjs" : null,
					},
				}),
				"nested/fallback.cjs": 'module.exports = "unused";',
			},
			omitted: "nested/fallback.cjs",
			omissionAllowed: true,
			required: exported
				? "MODULE_NOT_FOUND"
				: "ERR_PACKAGE_PATH_NOT_EXPORTED",
		})),
		...(
			[
				"invalid",
				"invalid capture",
				"blocked",
				"missing target",
				"selected",
			] as const
		).flatMap((target) =>
			(target === "blocked" ||
			target === "missing target" ||
			target === "invalid capture"
				? [false]
				: [false, true]
			).map((complete) => {
				const fallback = target === "invalid";
				const selected = target === "selected";
				return {
					name: `validates a private external array with a ${target} export (complete: ${complete})`,
					fmtBinding: "shared" as const,
					manifest: {
						dependencies: { fmt: "workspace:*" },
						imports: {
							"#feature": [
								target === "invalid capture"
									? "fmt/features/node_modules/tool"
									: "fmt/features/tool.cjs?variant",
								"./fallback.cjs",
							],
						},
					},
					files: {
						"index.cjs":
							'try { module.exports = require("#feature"); } catch (error) { module.exports = error.code; }',
						"fallback.cjs": 'module.exports = "fallback";',
					},
					installedFiles: {
						"packages/fmt/package.json": JSON.stringify({
							name: "fmt",
							version: "1.0.0",
							exports: {
								"./features/*": {
									invalid: "invalid-target",
									"invalid capture": "./src/*.cjs",
									blocked: null,
									"missing target": "./src/missing/*.cjs",
									selected: "./src/*.js",
								}[target],
							},
							files:
								complete || !selected ? ["src/tool.cjs"] : [],
						}),
						"packages/fmt/src/tool.cjs":
							'module.exports = "external";',
					},
					omitted: selected
						? complete
							? undefined
							: "src/tool.cjs"
						: complete
							? undefined
							: "fallback.cjs",
					omissionAllowed: !fallback && !selected,
					required: fallback
						? "fallback"
						: selected
							? "external"
							: target === "blocked"
								? "ERR_PACKAGE_PATH_NOT_EXPORTED"
								: target === "invalid capture"
									? "ERR_INVALID_MODULE_SPECIFIER"
									: "MODULE_NOT_FOUND",
				};
			}),
		),
		{
			name: "checks the file selected by a wildcard request with URL search",
			specifier: "linked/features/entry.cjs?variant",
			manifest: { exports: { "./features/*": "./src/*.js" } },
			files: { "src/entry.cjs": 'module.exports = "variant";' },
			omitted: "src/entry.cjs",
			required: "variant",
		},
		...([false, true] as const).map((declared) => ({
			name: `preserves a private external binding with its original scope (declared: ${declared})`,
			fmtBinding: "shared" as const,
			manifest: {
				imports: { "#fmt": "fmt/entry.cjs" },
				...(declared
					? { dependencies: { fmt: "workspace:*" } }
					: {}),
			},
			files: {
				"index.cjs": 'module.exports = require("#fmt");',
			},
			installedFiles: {
				"packages/fmt/package.json":
					'{"name":"fmt","version":"1.0.0"}',
				"packages/fmt/entry.cjs":
					'module.exports = "fmt entry";',
			},
			rejection: declared
				? undefined
				: 'cannot preserve private dependency "fmt"',
			required: "fmt entry",
		})),
		...([false, true] as const).map((declared) => ({
			name: `skips a file shadowing the external package (declared: ${declared})`,
			fmtBinding: "shared" as const,
			manifest: {
				imports: { "#fmt": "fmt/entry.cjs" },
				...(declared
					? { dependencies: { fmt: "workspace:*" } }
					: {}),
			},
			files: {
				"index.cjs": 'module.exports = require("#fmt");',
				"node_modules/fmt": "a file cannot provide the package",
			},
			installedFiles: {
				"packages/fmt/package.json":
					'{"name":"fmt","version":"1.0.0"}',
				"packages/fmt/entry.cjs":
					'module.exports = "ancestor fmt";',
			},
			rejection: declared
				? undefined
				: 'cannot preserve private dependency "fmt"',
			required: "ancestor fmt",
		})),
		...([false, true] as const).flatMap((external) =>
			([false, true] as const).map(
				(packed): ArchiveResolutionCase => ({
					name: `preserves directory import errors (external: ${external}, packed: ${packed})`,
					fmtBinding: external ? "shared" : undefined,
					manifest: {
						imports: {
							"#entry": external ? "fmt/feature" : "./folder",
						},
						...(external
							? { dependencies: { fmt: "workspace:*" } }
							: {}),
					},
					files: {
						"index.cjs":
							'module.exports = import("#entry").then(() => "loaded", error => { if (error.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error; return "directory fallback"; });',
						...(!external
							? { "folder/marker.txt": "keeps the directory" }
							: {}),
					},
					installedFiles: external
						? {
								"packages/fmt/package.json": JSON.stringify({
									name: "fmt",
									version: "1.0.0",
									exports: { "./feature": "./folder" },
									files: packed ? ["folder/marker.txt"] : [],
								}),
								"packages/fmt/folder/marker.txt":
									"keeps the directory",
							}
						: undefined,
					omitted:
						!external && !packed
							? "folder/marker.txt"
							: undefined,
					rejection: packed
						? undefined
						: "omits directory folder",
					required: "directory fallback",
				}),
			),
		),
		...(
			[
				"root import",
				"resolve-only",
				"resolve and import",
			] as const
		).flatMap((operation) =>
			[false, true].map((packed): ArchiveResolutionCase => ({
				name: `checks observed ${operation} for a directory (packed: ${packed})`,
				specifier:
					operation === "root import"
						? "linked"
						: "linked/folder",
				manifest: {
					exports:
						operation === "root import"
							? "./folder"
							: { "./folder": "./folder" },
				},
				files: { "folder/marker.txt": "keeps the directory" },
				omitted: packed ? undefined : "folder/marker.txt",
				omissionAllowed: operation === "resolve-only",
				rejection:
					!packed && operation !== "resolve-only"
						? "omits directory folder"
						: undefined,
				emittedLoader:
					operation === "root import"
						? undefined
						: "import-resolve",
				esmProbe:
					operation === "resolve-only"
						? "url"
						: "directory-error",
				alsoImport: operation === "resolve and import",
				imported:
					operation === "resolve-only"
						? "folder"
						: "ERR_UNSUPPORTED_DIR_IMPORT",
			})),
		),
		{
			name: "preserves a BOM in the root archive manifest",
			manifestBom: true,
			files: { "index.cjs": 'module.exports = "root";' },
			required: "root",
		},
		{
			name: "preserves a BOM in a nested directory manifest and archive scope",
			files: {
				"index.cjs": 'module.exports = require("./nested");',
				"nested/package.json":
					'\uFEFF{"main":"./entry.js","imports":{"#feature":"./value.cjs"}}',
				"nested/entry.js":
					'module.exports = require("#feature");',
				"nested/value.cjs": 'module.exports = "nested";',
			},
			required: "nested",
		},
		{
			name: "preserves the directory error for an export of the archive root",
			manifest: { exports: "./" },
			files: {},
			esmProbe: "directory-error",
			imported: "ERR_UNSUPPORTED_DIR_IMPORT",
		},
		...(
			[
				"legacy subpath",
				"exported subpath",
				"legacy root",
				"directory",
			] as const
		).map((target) => ({
			name: `keeps the external private fallback for a missing ${target}`,
			fmtBinding: "shared" as const,
			manifest: {
				imports: {
					"#fmt":
						target === "legacy root" ? "fmt" : "fmt/entry.cjs",
				},
			},
			files: {
				"index.cjs":
					'try { module.exports = require("#fmt"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; module.exports = "fallback"; }',
			},
			installedFiles: {
				"packages/fmt/package.json": JSON.stringify({
					name: "fmt",
					version: "1.0.0",
					...(target === "exported subpath"
						? { exports: { "./entry.cjs": "./entry.cjs" } }
						: {}),
				}),
				...(target === "directory"
					? {
							"packages/fmt/entry.cjs/marker.txt":
								"keeps the directory",
						}
					: {}),
			},
			required: "fallback",
		})),
		...(
			["absent", "shared", "symlink", "distinct"] as const
		).map((fmtBinding) => ({
			name: `checks the private dependency binding in the artifact: ${fmtBinding}`,
			fmtBinding,
			manifest: {
				imports: { "#fmt": "fmt" },
				...(fmtBinding === "absent"
					? {}
					: { dependencies: { fmt: "workspace:*" } }),
			},
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"nested/index.cjs": 'module.exports = require("#fmt");',
				"nested/package.json": '{"imports":{"#fmt":"fmt"}}',
				...(fmtBinding === "distinct"
					? {
							"nested/node_modules/fmt/package.json":
								'{"name":"fmt","version":"1.0.0"}',
							"nested/node_modules/fmt/index.js":
								'module.exports = "nearby";',
						}
					: {}),
			},
			installedFiles: {
				"packages/fmt/index.js": 'module.exports = "shared";',
				"packages/fmt/package.json":
					'{"name":"fmt","version":"1.0.0"}',
			},
			omitted: "nested/package.json",
			omissionAllowed:
				fmtBinding === "shared" || fmtBinding === "symlink",
			required: fmtBinding === "distinct" ? "nearby" : "shared",
		})),
		...(
			[
				"nested/package.json",
				"nested/feature.cjs",
				undefined,
			] as const
		).map((omitted) => ({
			name: omitted
				? `checks the package self-reference after omitting ${omitted}`
				: "keeps a complete package self-reference",
			manifest: {
				imports: { "#feature": "linked/feature" },
				exports: {
					".": "./index.cjs",
					"./feature": "./root.cjs",
				},
			},
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.cjs");',
				"root.cjs": 'module.exports = "root";',
				"nested/index.cjs":
					'module.exports = require("#feature");',
				"nested/package.json":
					'{"name":"linked","imports":{"#feature":"linked/feature"},"exports":{"./feature":"./feature.cjs"}}',
				"nested/feature.cjs": 'module.exports = "nested";',
			},
			omitted,
			required: "nested",
		})),
		...([false, true] as const).map((omitsSelected) => ({
			name: omitsSelected
				? "checks the selected import-mode self-reference"
				: "allows the unselected require-mode self-reference to be omitted",
			files: {
				"index.cjs":
					'module.exports = require("./nested/index.mjs").default;',
				"nested/index.mjs":
					'export { default } from "#feature";',
				"nested/package.json": JSON.stringify({
					name: "@fixture/inner",
					imports: { "#feature": "@fixture/inner/features/foo" },
					exports: {
						"./features/*": {
							import: "./esm/*.mjs",
							require: "./cjs/*.cjs",
						},
					},
				}),
				"nested/esm/foo.mjs": 'export default "self import";',
				"nested/cjs/foo.cjs": 'module.exports = "self require";',
			},
			omitted: omitsSelected
				? "nested/esm/foo.mjs"
				: "nested/cjs/foo.cjs",
			omissionAllowed: !omitsSelected,
			required: "self import",
		})),
	])(
		"validates Node archive resolution ($name)",
		async ({
			files,
			pattern,
			specifier: explicitSpecifier,
			manifest,
			omitted,
			omissionAllowed,
			required,
			imported,
			alsoResolves,
			installedFiles,
			fmtBinding,
			emittedLoader,
			bracketResolver,
			rejection,
			manifestBom,
			esmProbe,
			alsoImport,
		}) => {
			const f = await fixture();
			const linked = new URL("packages/linked/", f.root);
			await mkdir(linked, { recursive: true });
			for (const [base, entries] of [
				[linked, files],
				[f.root, installedFiles ?? {}],
			] as const) {
				for (const [path, contents] of Object.entries(entries)) {
					const file = join(fileURLToPath(base), path);
					await mkdir(dirname(file), { recursive: true });
					await writeFile(file, contents);
				}
			}
			await writeFile(
				new URL("package.json", linked),
				(manifestBom ? "\uFEFF" : "") +
					JSON.stringify({
						name: "linked",
						version: "1.0.0",
						type: "commonjs",
						exports: pattern
							? { "./features/*": pattern }
							: "./index.cjs",
						...manifest,
						files: Object.keys(files).filter(
							(path) => path !== omitted,
						),
					}),
			);
			await mkdir(new URL("node_modules/", f.root), {
				recursive: true,
			});
			await symlink(
				linked,
				new URL("node_modules/linked", f.root),
				"dir",
			);
			if (fmtBinding) {
				const fmt = new URL("packages/fmt/", f.root);
				await symlink(
					fmt,
					new URL("node_modules/fmt", f.root),
					"dir",
				);
				if (fmtBinding === "symlink") {
					await mkdir(new URL("nested/node_modules/", linked), {
						recursive: true,
					});
					await symlink(
						fmt,
						new URL("nested/node_modules/fmt", linked),
						"dir",
					);
				}
			}
			const specifier =
				explicitSpecifier ??
				(pattern ? "linked/features/a" : "linked");
			const assertNodeLoads = async (directory: string) => {
				const require = createRequire(
					join(directory, "package.json"),
				);
				if (required !== undefined) {
					const loaded: unknown = await require(
						emittedLoader === "require-resolve"
							? require.resolve(specifier)
							: specifier,
					);
					const value =
						loaded &&
						typeof loaded === "object" &&
						"default" in loaded
							? loaded.default
							: loaded;
					expect(value).toBe(required);
				} else if (emittedLoader !== "import-resolve") {
					expect(() => {
						require(specifier);
					}).toThrow(/Cannot find module/);
				}
				for (const [request, expected] of Object.entries(
					alsoResolves ?? {},
				))
					expect(require(request)).toBe(expected);
				if (imported !== undefined) {
					const request = JSON.stringify(specifier);
					const result = await promisify(execFile)(
						process.execPath,
						[
							"--input-type=module",
							"-e",
							esmProbe === "url"
								? `console.log(new URL(import.meta.resolve(${request})).pathname.split("/").at(-1));`
								: esmProbe === "directory-error"
									? `${alsoImport ? `import.meta.resolve(${request});` : ""} try { await import(${request}); } catch (error) { console.log(error.code); }`
									: emittedLoader === "import-resolve"
										? `const { resolve: select } = import.meta; console.log((await import(select(${request}))).default);`
										: `import value from ${request}; console.log(value);`,
						],
						{ cwd: directory },
					);
					expect(result.stdout.trim()).toBe(imported);
				}
			};
			await assertNodeLoads(fileURLToPath(f.root));
			await writeFile(
				new URL("index.js", f.server),
				`${
					emittedLoader === "require"
						? `import { createRequire } from "node:module"; createRequire(import.meta.url)(${JSON.stringify(specifier)});`
						: emittedLoader === "require-resolve"
							? `import { createRequire } from "node:module"; const req = createRequire(import.meta.url); const select = req${bracketResolver ? '["resolve"]' : ".resolve"}; select(${JSON.stringify(specifier)});`
							: emittedLoader === "import-resolve"
								? `const { resolve: select } = import.meta; select(${JSON.stringify(specifier)});${alsoImport ? ` await import(${JSON.stringify(specifier)});` : ""}`
								: esmProbe === "directory-error"
									? `try { await import(${JSON.stringify(specifier)}); } catch (error) { if (error.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error; }`
									: `import ${JSON.stringify(specifier)};`
				}${f.index}`,
			);
			const before = await snapshot(f.directory);
			const outcome = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							includeLocal: true,
							dependencyStrategy: "install",
						},
					),
				),
			);
			const expectedRejection =
				rejection ??
				(omitted && !omissionAllowed
					? fmtBinding === "absent"
						? "fmt"
						: `omits ${omitted}`
					: undefined);
			if (expectedRejection) {
				expect(outcome._tag).toBe("Left");
				if (outcome._tag === "Left")
					expect(String(outcome.left)).toContain(
						expectedRejection,
					);
			} else {
				if (outcome._tag === "Left") throw outcome.left;
				expect(
					outcome.right.plannedOutput.functions,
				).toHaveLength(1);
			}
			expect(await snapshot(f.directory)).toEqual(before);
			if (outcome._tag === "Right") {
				await Effect.runPromise(
					FunctionArtifact.applyPreparation(outcome.right),
				);
				const isolated = await mkdtemp(
					join(tmpdir(), "archive-resolution-"),
				);
				directories.push(isolated);
				await cp(f.server, isolated, { recursive: true });
				await promisify(execFile)(
					"npm",
					[
						"ci",
						"--offline",
						"--ignore-scripts",
						"--no-audit",
						"--no-fund",
					],
					{ cwd: isolated },
				);
				await assertNodeLoads(isolated);
			}
		},
	);

	it.each([
		{ resolver: ".resolve", retained: false },
		{ resolver: '["resolve"]', retained: false },
		{ resolver: ".resolve", retained: true },
		{ resolver: '["resolve"]', retained: true },
	])(
		"checks the relative CommonJS resolver target ($resolver, retained: $retained)",
		async ({ resolver, retained }) => {
			const f = await fixture();
			const relativeTarget = retained
				? "./asset.bin"
				: "../feature.cjs";
			const file = new URL(relativeTarget, f.server);
			if (!retained)
				await writeFile(file, 'module.exports = "source only";');
			const entry = new URL("index.js", f.server);
			const source = `import {createRequire} from "node:module"; const req = createRequire(import.meta.url); export const resolved = req${resolver}(${JSON.stringify(relativeTarget)});`;
			await writeFile(entry, `${source}\n${f.index}`);
			expect(createRequire(entry).resolve(relativeTarget)).toBe(
				await realpath(file),
			);
			const before = await snapshot(f.directory);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
				}),
			);
			if (!retained) {
				await expect(planning).rejects.toThrow(
					/does not name a retained file/,
				);
				expect(await snapshot(f.directory)).toEqual(before);
				return;
			}
			const plan = await planning;
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "relative-resolver-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			expect(
				createRequire(join(isolated, "index.js")).resolve(
					relativeTarget,
				),
			).toBe(await realpath(join(isolated, "asset.bin")));
		},
	);

	it.each([
		{
			request: "./feature",
			entry: "feature/index.js",
			invoke: "req",
		},
		{
			request: "./feature/",
			entry: "feature/index.js",
			invoke: "req.resolve",
		},
		{
			request: "./feature/sub/..",
			entry: "feature/main.cjs.json",
			invoke: 'req["resolve"]',
		},
		{
			request: "./feature",
			entry: "feature.js",
			invoke: "req.resolve",
		},
		{
			request: "../feature/",
			entry: "../feature/index.js",
			invoke: "req.resolve",
		},
		{ request: ".", entry: "index.js", invoke: "req.resolve" },
		{
			request: "..",
			entry: "../index.js",
			invoke: "req.resolve",
		},
		{
			request: "../",
			entry: "../index.js",
			invoke: "req.resolve",
		},
		{
			request: "./feature/.",
			entry: "feature/main.cjs.json",
			invoke: "req",
			bom: true,
		},
	])(
		"checks CommonJS directory resolution for $request and $invoke ($entry)",
		async ({ request, entry, invoke, bom }) => {
			const f = await fixture();
			const feature = new URL("feature/", f.server);
			const selected = new URL(entry, f.server);
			await mkdir(new URL(".", selected), { recursive: true });
			await mkdir(feature, { recursive: true });
			await writeFile(
				selected,
				entry.endsWith(".json")
					? '"selected"'
					: 'export default "selected";',
			);
			if (entry === "feature.js" || entry.endsWith(".json"))
				await writeFile(
					new URL("index.js", feature),
					'export default "wrong index";',
				);
			if (entry.endsWith(".json")) {
				await writeFile(
					new URL("package.json", feature),
					(bom ? "\uFEFF" : "") + '{"main":"./main.cjs"}',
				);
				await writeFile(
					new URL("feature.js", f.server),
					'export default "wrong file";',
				);
			}
			const from = new URL("index.js", f.server);
			await writeFile(
				from,
				`import {createRequire} from "node:module"; const req = createRequire(import.meta.url); export const selected = ${invoke}(${JSON.stringify(request)});\n${f.index}`,
			);
			expect(createRequire(from).resolve(request)).toBe(
				await realpath(selected),
			);
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "install",
				}),
			);
			if (entry.startsWith("../")) {
				await expect(planning).rejects.toThrow(
					/does not name a retained file/,
				);
				return;
			}
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(await planning),
			);
			const isolated = await mkdtemp(
				join(tmpdir(), "directory-resolver-"),
			);
			directories.push(isolated);
			await cp(f.server, isolated, { recursive: true });
			const result = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import { selected } from "./index.js"; console.log(selected.default ?? selected);',
				],
				{ cwd: isolated },
			);
			expect(result.stdout.trim()).toBe(
				invoke === "req"
					? "selected"
					: await realpath(join(isolated, entry)),
			);
		},
	);

	it("tracks the loader role returned by a bare CommonJS directory request", async () => {
		const f = await fixture();
		const feature = new URL("feature/", f.server);
		await mkdir(feature);
		await writeFile(
			new URL("index.js", feature),
			"export const runtime = process;",
		);
		await writeFile(
			new URL("request.mjs", feature),
			'import {createRequire} from "node:module"; const req = createRequire(import.meta.url); req(".").runtime.getBuiltinModule("node:module").createRequire(import.meta.url)("example");',
		);
		await expect(
			Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy: "bundle",
				}),
			),
		).rejects.toThrow(
			/unresolved runtime package imports.*example/,
		);
	});

	it.each(["ancestor marker", "empty shadow"] as const)(
		"detects local provenance for the installed ancestor package: %s",
		async (mode) => {
			const ancestor = await mkdtemp(
				join(tmpdir(), "ancestor-package-"),
			);
			directories.push(ancestor);
			const f = await fixture(ancestor);
			const leaf = join(ancestor, "node_modules", "leaf");
			await mkdir(leaf, { recursive: true });
			await writeFile(
				join(leaf, "package.json"),
				'{"name":"leaf","version":"1.0.0"}',
			);
			await mkdir(new URL("node_modules/parent/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/parent/package.json", f.root),
				'{"name":"parent","version":"1.0.0","dependencies":{"leaf":"^1"}}',
			);
			await writeFile(
				new URL("package.json", f.root),
				JSON.stringify(
					mode === "ancestor marker"
						? {
								dependencies: { leaf: "^1" },
								devDependencies: { leaf: "file:./leaf.tgz" },
							}
						: { dependencies: { leaf: "file:./leaf.tgz" } },
				),
			);
			if (mode === "ancestor marker") {
				await writeFile(
					new URL("node_modules/.modules.yaml", f.root),
					"layoutVersion: 5\n",
				);
				await writeFile(
					join(ancestor, "node_modules", ".package-lock.json"),
					"{}",
				);
			} else {
				await mkdir(new URL("node_modules/leaf/", f.root));
			}
			await writeFile(
				new URL("index.js", f.server),
				`import '${mode === "ancestor marker" ? "leaf" : "parent"}';${f.index}`,
			);
			const resolve = vi.fn((_name: string, version: string) =>
				Promise.resolve({ version }),
			);
			const before = await snapshot(ancestor);
			await expect(
				Effect.runPromise(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy: "install" },
						{ resolve },
					),
				),
			).rejects.toThrow(/linked local runtime package "leaf"/);
			expect(
				resolve.mock.calls.map(([name]) => name),
			).not.toContain("leaf");
			expect(await snapshot(ancestor)).toEqual(before);
		},
	);

	it.each(
		[
			"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); if (typeof load === 'function') load('node:fs');",
			"import {createRequire} from 'node:module'; createRequire(import.meta['url'])('node:fs');",
			"import {createRequire} from 'node:module'; if (typeof createRequire === 'function') {const load = createRequire(import.meta.url); load('node:fs');}",
			"if(typeof import.meta.resolve === 'function') import.meta.resolve('node:fs');",
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ source, dependencyStrategy }),
			),
		),
	)(
		"allows non-escaping Node loader observations: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps the switch discriminant outside its case bindings for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import {createRequire} from 'node:module'; const load = 0; switch(load) {default: const load = createRequire(import.meta.url); load("node:fs");}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		[
			"import {createRequire} from 'node:module'; const load = 1; function run(value = load) {var load = createRequire(import.meta.url); load('node:fs');} run();",
			"import {createRequire} from 'node:module'; const load = 1; const run = (value = load) => {var load = createRequire(import.meta.url); load('node:fs');}; run();",
			"import {createRequire} from 'node:module'; const load = 1; function run({[load]: value}) {var load = createRequire(import.meta.url); load('node:fs');} run({1:0});",
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ source, dependencyStrategy }),
			),
		),
	)(
		"keeps parameter expressions outside body var bindings: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"plans fixed Node module metadata destructuring for %s without mutations",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import * as mod from 'node:module'; const { builtinModules } = mod; console.log(builtinModules);\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps builtin and relative import.meta.resolve references local for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import.meta.resolve('node:fs'); import.meta.resolve('./asset.bin');\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(
		[
			"export const {url} = import.meta;",
			"const meta = import.meta; export const {url: moduleUrl, dirname, filename} = meta;",
			"export const {'url': moduleUrl} = import.meta;",
			"export var {url: moduleUrl} = import.meta; var moduleUrl = 'local-metadata';",
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ source, dependencyStrategy }),
			),
		),
	)(
		"allows exported import.meta URL metadata without mutations: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps fixed import.meta metadata and local resolutions available through aliases for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`const meta = import.meta; const {url, dirname, filename} = meta; console.log(url, dirname, filename, meta['url']); meta.resolve('node:fs'); meta.resolve('./asset.bin');\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps a shadowed import.meta alias local for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`const meta = import.meta; function unused(meta) {meta.resolve('not-a-runtime-package');}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps a function-local bare var from inheriting an outer Node loader for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); function unused() {var load; load('not-a-node-loader');}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		"const p=(0,process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const fallback=null;const p=fallback ?? process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const fallback={};const p=globalThis.process || fallback;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"function run(p=process){p.getBuiltinModule('module').createRequire(import.meta.url)('example');var p=null}run();",
		"const p=typeof process==='object' && process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=proc.env && proc;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?process:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='undefined'?{}:process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?globalThis.process:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=typeof proc==='object'?proc:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?process:globalThis.process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?(process.env.NODE_ENV?process:globalThis.process):{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=typeof process==='object'?process:{};get('module').createRequire(import.meta.url)('example');",
		"function run(p=typeof process==='object'?process:{}){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"const p=process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"function run(p=process){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"const run=(p=globalThis.process)=>p.getBuiltinModule('module').createRequire(import.meta.url)('example');run();",
		"function run({getBuiltinModule:get}=process){get('module').createRequire(import.meta.url)('example')}run();",
		"function run(p=process){var p;p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"import proc from 'node:process';function run(p=proc){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"function run({proc=process}={}){proc.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"let stable=process;const p=(stable=process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"let env;const p=({env}=process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=await import('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=await import('process');get('module').createRequire(import.meta.url)('example');",
		"import {createRequire} from 'node:module';const req=createRequire(import.meta.url);const p=req('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=process.getBuiltinModule('process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=proc.getBuiltinModule('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",

		"import * as proc from 'node:process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import {getBuiltinModule as get} from 'node:process';get('module').createRequire(import.meta.url)('example');",
		"import {default as proc} from 'process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",

		"process['getBuiltinModule']('node:module').createRequire(import.meta.url)('example');",
		"const get=process.getBuiltinModule; get('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=process;get('module').createRequire(import.meta.url)('example');",
		"process.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url)('example');",
		"const p=globalThis.process || {};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const mod=process.getBuiltinModule('node:module'); const load=mod.createRequire(import.meta.url);load('example');",
		"const {createRequire:make}=globalThis.process.getBuiltinModule('module');make(import.meta.url)('example');",
		"import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); const mod = req('node:module'); const load = mod.createRequire(import.meta.url); load('example');",
		"import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); const {createRequire: make} = req('module'); const load = make(import.meta.url); load('example');",
		"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); switch(load('example')) {default: const load = 0;}",
		"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); function run(value = load('example')) {var load = 0;} run();",
		"const asset = import.meta.resolve('example/asset.css');",
		"const meta = import.meta; const asset = meta.resolve('example/asset.css');",
		"const meta = import.meta; const copy = meta; const locate = copy['resolve']; locate('example/asset.css');",
		"const {resolve: locate, url} = import.meta; locate('example/asset.css');",
	])(
		"rejects a retained runtime package reference in a bundle before writing output: %s",
		async (source) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const outcome = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						settings,
					),
				),
			);
			expect(outcome).toMatchObject({
				_tag: "Left",
				left: { _tag: "UnresolvedDependency" },
			});
			expect(outcome).toHaveProperty(
				"left.message",
				expect.stringContaining("example"),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		"const p=(0,process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const fallback=null;const p=fallback ?? process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const fallback={};const p=globalThis.process || fallback;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"function run(p=process){p.getBuiltinModule('module').createRequire(import.meta.url)('example');var p=null}run();",
		"const p=typeof process==='object' && process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=proc.env && proc;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?process:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='undefined'?{}:process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?globalThis.process:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=typeof proc==='object'?proc:{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?process:globalThis.process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=typeof process==='object'?(process.env.NODE_ENV?process:globalThis.process):{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=typeof process==='object'?process:{};get('module').createRequire(import.meta.url)('example');",
		"function run(p=typeof process==='object'?process:{}){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"const p=process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"function run(p=process){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"const run=(p=globalThis.process)=>p.getBuiltinModule('module').createRequire(import.meta.url)('example');run();",
		"function run({getBuiltinModule:get}=process){get('module').createRequire(import.meta.url)('example')}run();",
		"function run(p=process){var p;p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"import proc from 'node:process';function run(p=proc){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"function run({proc=process}={}){proc.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
		"let stable=process;const p=(stable=process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"let env;const p=({env}=process);p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=await import('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=await import('process');get('module').createRequire(import.meta.url)('example');",
		"import {createRequire} from 'node:module';const req=createRequire(import.meta.url);const p=req('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const p=process.getBuiltinModule('process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import proc from 'node:process';const p=proc.getBuiltinModule('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",

		"import * as proc from 'node:process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"import {getBuiltinModule as get} from 'node:process';get('module').createRequire(import.meta.url)('example');",
		"import {default as proc} from 'process';proc.getBuiltinModule('module').createRequire(import.meta.url)('example');",

		"process['getBuiltinModule']('node:module').createRequire(import.meta.url)('example');",
		"const get=process.getBuiltinModule; get('module').createRequire(import.meta.url)('example');",
		"const {getBuiltinModule:get}=process;get('module').createRequire(import.meta.url)('example');",
		"process.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"globalThis.process.getBuiltinModule('node:module').createRequire(import.meta.url)('example');",
		"const p=globalThis.process || {};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
		"const mod=process.getBuiltinModule('node:module'); const load=mod.createRequire(import.meta.url);load('example');",
		"const {createRequire:make}=globalThis.process.getBuiltinModule('module');make(import.meta.url)('example');",
		"import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); const mod = req('node:module'); const load = mod.createRequire(import.meta.url); load('example');",
		"import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); const {createRequire: make} = req('module'); const load = make(import.meta.url); load('example');",
		"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); switch(load('example')) {default: const load = 0;}",
		"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); function run(value = load('example')) {var load = 0;} run();",
		"import value from 'example';",
		"const asset = import.meta.resolve('example/asset.css');",
		"const meta = import.meta; const asset = meta.resolve('example/asset.css');",
		"const meta = import.meta; const copy = meta; const locate = copy['resolve']; locate('example/asset.css');",
		"const {resolve: locate, url} = import.meta; locate('example/asset.css');",
		"const meta = import.meta; const {resolve: locate} = meta; locate('example/asset.css');",
		"var locate = import.meta.resolve; locate('example/asset.css'); var locate = import.meta.resolve;",
		"import {createRequire} from 'node:module'; var load = createRequire(import.meta.url); load('example'); var load = createRequire(import.meta.url);",
		"import {createRequire} from 'node:module'; var load; var load = createRequire(import.meta.url); load('example');",
		"const locate = import.meta.resolve; const asset = locate('example/asset.css');",
		"const asset = import.meta['resolve']('example/asset.css');",
		"import {createRequire} from 'node:module'; var load = createRequire(import.meta.url); { var load; } load('example');",
		"import {createRequire} from 'node:module'; var load = createRequire(import.meta.url); var load; load('example');",
		"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); load('example');",
		"import {createRequire} from 'node:module'; class C {static {var createRequire = null;}} const load = createRequire(import.meta.url); load('example');",
		"import {default as mod} from 'node:module'; const load = mod.createRequire(import.meta.url); load('example');",
		"import * as mod from 'node:module'; const load = mod.default.createRequire(import.meta.url); load('example');",
		"import * as mod from 'node:module'; const load = mod.createRequire(import.meta.url); load('example');",
		"import * as mod from 'node:module'; const {builtinModules, createRequire: make} = mod; const load = make(import.meta.url); load('example');",
	])("plans exact install metadata for %s", async (source) => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`${source}\n${f.index}`,
		);
		await mkdir(new URL("node_modules/example/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		await writeFile(
			new URL("node_modules/example/package.json", f.root),
			'{"name":"example","version":"1.2.3"}',
		);
		const before = await snapshot(f.directory);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{ resolve: () => Promise.resolve({ version: "1.2.3" }) },
			),
		);
		expect(await snapshot(f.directory)).toEqual(before);
		const lock = plan.mutations.find(
			(mutation) =>
				mutation.kind === "writeFile" &&
				mutation.path.pathname.endsWith("package-lock.json"),
		);
		expect(
			lock?.kind === "writeFile" && JSON.parse(lock.contents),
		).toMatchObject({
			lockfileVersion: 3,
			packages: { "node_modules/example": { version: "1.2.3" } },
		});
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		expect(
			JSON.parse(
				await readFile(
					new URL("package.json", f.server),
					"utf8",
				),
			),
		).toMatchObject({ dependencies: { example: "1.2.3" } });
	});

	it("plans an installed import-only package without a public package.json export", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import value from 'example';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		await mkdir(new URL("node_modules/example/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("node_modules/example/package.json", f.root),
			JSON.stringify({
				name: "example",
				version: "1.2.3",
				type: "module",
				exports: { import: "./index.js" },
			}),
		);
		await writeFile(
			new URL("node_modules/example/index.js", f.root),
			"export default 42;",
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{ resolve: () => Promise.resolve({ version: "1.2.3" }) },
			),
		);
		const lock = plan.mutations.find(
			(mutation) =>
				mutation.kind === "writeFile" &&
				mutation.path.pathname.endsWith("package-lock.json"),
		);
		expect(
			lock?.kind === "writeFile" && JSON.parse(lock.contents),
		).toMatchObject({
			packages: { "node_modules/example": { version: "1.2.3" } },
		});
	});

	it("retains explicitly optional peers of an uninstalled package without selecting new peer versions", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import 'example';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		await mkdir(new URL("node_modules/example/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("node_modules/example/package.json", f.root),
			'{"name":"example","version":"1.2.3"}',
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name) => {
						if (name === "example")
							return Promise.resolve({
								version: "1.2.3",
								optionalDependencies: { helper: "^2" },
							});
						if (name === "helper")
							return Promise.resolve({
								version: "2.3.4",
								peerDependencies: { absent: "^3" },
								peerDependenciesMeta: {
									absent: { optional: true },
								},
							});
						throw new Error(
							"Absent peers must not be reselected",
						);
					},
				},
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const lock = JSON.parse(
			await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			),
		) as {
			packages: Record<
				string,
				{
					dependencies?: Record<string, string>;
					optionalDependencies?: Record<string, string>;
				}
			>;
		};
		expect(lock.packages["node_modules/helper"]).toMatchObject({
			version: "2.3.4",
			optional: true,
			peerDependencies: { absent: "^3" },
			peerDependenciesMeta: { absent: { optional: true } },
		});
		expect(Object.keys(lock.packages)).toEqual([
			"",
			"node_modules/example",
			"node_modules/helper",
		]);
	});

	it.each(["bundle", "install"] as const)(
		"retains ordinary builtin metadata re-exports for %s",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("metadata.js", f.server),
				"export {builtinModules as names} from 'node:module';",
			);
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(f.build, f.routePlan, {
					...settings,
					dependencyStrategy,
				}),
			);
			expect(plan.plannedOutput.functions).toHaveLength(1);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it("keeps the locked exact version of an absent optional dependency", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import 'example';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		await mkdir(new URL("node_modules/example/", f.root), {
			recursive: true,
		});
		await writeFile(
			new URL("node_modules/example/package.json", f.root),
			'{"name":"example","version":"1.2.3"}',
		);
		await writeFile(
			new URL("package-lock.json", f.root),
			JSON.stringify({
				packages: {
					"node_modules/example": {
						version: "1.2.3",
						optionalDependencies: { child: "^2" },
					},
					"node_modules/child": {
						version: "2.1.0",
						resolved:
							"https://registry.example/locked-child.tgz",
						integrity: "sha512-locked",
						os: ["darwin"],
					},
				},
			}),
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{ resolve: () => Promise.resolve({ version: "2.2.0" }) },
			),
		);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const lock = JSON.parse(
			await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			),
		) as { packages: Record<string, unknown> };
		expect(lock.packages["node_modules/child"]).toMatchObject({
			version: "2.1.0",
			optional: true,
			resolved: "https://registry.example/locked-child.tgz",
			integrity: "sha512-locked",
			os: ["darwin"],
		});
		expect(lock.packages["node_modules/example"]).toMatchObject({
			optionalDependencies: { child: "2.1.0" },
		});
	});
	it.each([
		["next", "2.0.0-beta.2"],
		["npm:real-child@next", "2.0.0-beta.2"],
		["latest", "2.0.0-beta.1"],
		["*", "2.0.0-beta.1"],
		["npm:real-child@*", "2.0.0-beta.1"],
	])(
		"pins an absent optional dependency from registry tag %s",
		async (range, version) => {
			const tarball = (version: string) =>
				`https://registry.example/child-${version}.tgz`;
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';\n${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app"}',
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			await writeFile(
				new URL("package-lock.json", f.root),
				JSON.stringify({
					packages: {
						"node_modules/example": {
							version: "1.2.3",
							optionalDependencies: { child: range },
						},
					},
				}),
			);
			const registry = createServer((_request, response) => {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						name: range.startsWith("npm:")
							? "real-child"
							: "child",
						"dist-tags": {
							next: "2.0.0-beta.2",
							latest: "2.0.0-beta.1",
						},
						versions: {
							"2.0.0-beta.1": {
								version: "2.0.0-beta.1",
								dist: { tarball: tarball("2.0.0-beta.1") },
							},
							"2.0.0-beta.2": {
								version: "2.0.0-beta.2",
								dist: { tarball: tarball("2.0.0-beta.2") },
							},
							"3.0.0": { version: "3.0.0" },
						},
					}),
				);
			});
			await new Promise<void>((resolve) =>
				registry.listen(0, "127.0.0.1", resolve),
			);
			const address = registry.address();
			if (!address || typeof address === "string")
				throw new Error("Expected registry port");
			try {
				// pnpm lifecycle scripts export a registry env value above project .npmrc.
				const fixtureRegistry = `http://127.0.0.1:${address.port}/`;
				vi.stubEnv("npm_config_registry", fixtureRegistry);
				vi.stubEnv("NPM_CONFIG_REGISTRY", fixtureRegistry);
				vi.stubEnv("npm_config_offline", "false");
				vi.stubEnv("NPM_CONFIG_OFFLINE", "false");
				vi.stubEnv("npm_config_tag", "latest");
				vi.stubEnv("NPM_CONFIG_TAG", "latest");
				await writeFile(
					new URL(".npmrc", f.root),
					`registry=http://127.0.0.1:${address.port}/\n`,
				);
				const plan = await Effect.runPromise(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy: "install",
						},
					),
				);
				await Effect.runPromise(
					FunctionArtifact.applyPreparation(plan),
				);
				const lock = JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				) as {
					packages: Record<
						string,
						{
							dependencies?: Record<string, string>;
							optionalDependencies?: Record<string, string>;
						}
					>;
				};
				expect(
					lock.packages["node_modules/child"],
				).toMatchObject({
					version,
					optional: true,
					resolved: tarball(version),
				});
				expect(
					lock.packages["node_modules/example"]
						?.optionalDependencies?.child,
				).toBe(
					range.startsWith("npm:")
						? `npm:real-child@${version}`
						: version,
				);
			} finally {
				await new Promise<void>((resolve, reject) =>
					registry.close((error) =>
						error ? reject(error) : resolve(),
					),
				);
			}
		},
	);
	it.each(["latest", "next", "npm:real-child@next"])(
		"pins the installed resolution of tagged dependency %s",
		async (range) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';\n${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app"}',
			);
			const parent = {
				name: "example",
				version: "1.2.3",
				dependencies: { child: range },
			};
			for (const [path, manifest] of [
				["example", parent],
				[
					"child",
					{
						name: range.startsWith("npm:")
							? "real-child"
							: "child",
						version: "2.3.4",
					},
				],
			] as const) {
				await mkdir(new URL(`node_modules/${path}/`, f.root), {
					recursive: true,
				});
				await writeFile(
					new URL(`node_modules/${path}/package.json`, f.root),
					JSON.stringify(manifest),
				);
			}
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name) =>
							Promise.resolve(
								name === "example"
									? parent
									: { version: "2.3.4" },
							),
					},
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as {
				packages: Record<
					string,
					{
						dependencies?: Record<string, string>;
						optionalDependencies?: Record<string, string>;
					}
				>;
			};
			expect(lock.packages["node_modules/child"]).toMatchObject({
				version: "2.3.4",
			});
			expect(
				lock.packages["node_modules/example"]?.dependencies
					?.child,
			).toBe(
				range.startsWith("npm:")
					? "npm:real-child@2.3.4"
					: "2.3.4",
			);
		},
	);
	it.each([false, true])(
		"pins an installed runtime peer (optional: %s)",
		async (optional) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import 'example';\n${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app"}',
			);
			const parent = {
				name: "example",
				version: "1.2.3",
				peerDependencies: { peer: "^2" },
				...(optional
					? {
							peerDependenciesMeta: { peer: { optional: true } },
						}
					: {}),
			};
			for (const manifest of [
				parent,
				{ name: "peer", version: "2.3.4" },
			]) {
				await mkdir(
					new URL(`node_modules/${manifest.name}/`, f.root),
					{ recursive: true },
				);
				await writeFile(
					new URL(
						`node_modules/${manifest.name}/package.json`,
						f.root,
					),
					JSON.stringify(manifest),
				);
			}
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name) =>
							Promise.resolve(
								name === "example"
									? parent
									: { version: "2.3.4" },
							),
					},
				),
			);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			const lock = JSON.parse(
				await readFile(
					new URL("package-lock.json", f.server),
					"utf8",
				),
			) as {
				packages: Record<
					string,
					{
						dependencies?: Record<string, string>;
						optionalDependencies?: Record<string, string>;
					}
				>;
			};
			expect(lock.packages["node_modules/peer"]).toMatchObject({
				version: "2.3.4",
			});
			expect(
				lock.packages["node_modules/example"],
			).toMatchObject({
				peerDependencies: { peer: "2.3.4" },
				...(optional
					? {
							peerDependenciesMeta: { peer: { optional: true } },
						}
					: {}),
			});
		},
	);
	it.each(["none", "legacy", "modern"])(
		"preserves an installed npm alias with %s lock metadata",
		async (lockKind) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import value from 'runtime-alias';\n${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app","dependencies":{"runtime-alias":"npm:@scope/real@^1"}}',
			);
			await mkdir(
				new URL("node_modules/runtime-alias/", f.root),
				{ recursive: true },
			);
			await writeFile(
				new URL(
					"node_modules/runtime-alias/package.json",
					f.root,
				),
				'{"name":"@scope/real","version":"1.2.3"}',
			);
			const entry = {
				name: "@scope/real",
				version: "1.2.3",
				resolved: "https://registry.example/real.tgz",
			};
			if (lockKind !== "none")
				await writeFile(
					new URL("package-lock.json", f.root),
					JSON.stringify(
						lockKind === "modern"
							? {
									lockfileVersion: 3,
									packages: {
										"node_modules/runtime-alias": entry,
									},
								}
							: {
									lockfileVersion: 1,
									dependencies: {
										"runtime-alias": {
											version: "npm:@scope/real@1.2.3",
										},
									},
								},
					),
				);
			const requests: string[][] = [];
			const before = await snapshot(f.directory);
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name, requirement) => {
							requests.push([name, requirement]);
							if (name !== "@scope/real")
								throw new Error(
									"Unpublished import alias must not be requested",
								);
							return Promise.resolve(entry);
						},
					},
				),
			);
			expect(requests).toEqual(
				lockKind === "modern" ? [] : [["@scope/real", "1.2.3"]],
			);
			expect(await snapshot(f.directory)).toEqual(before);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				dependencies: {
					"runtime-alias": "npm:@scope/real@1.2.3",
				},
			});
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"": {
						dependencies: {
							"runtime-alias": "npm:@scope/real@1.2.3",
						},
					},
					"node_modules/runtime-alias": entry,
				},
			});
		},
	);

	it.each([false, true])(
		"pins an npm alias on a transitive edge (optional: %s)",
		async (optional) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import value from 'example';\n${f.index}`,
			);
			await writeFile(
				new URL("package.json", f.root),
				'{"name":"app"}',
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			const edges = {
				[optional ? "optionalDependencies" : "dependencies"]: {
					"runtime-alias": "npm:@scope/real@^2",
				},
			};
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				JSON.stringify({
					name: "example",
					version: "1.2.3",
					...edges,
				}),
			);
			if (!optional) {
				await mkdir(
					new URL("node_modules/runtime-alias/", f.root),
					{ recursive: true },
				);
				await writeFile(
					new URL(
						"node_modules/runtime-alias/package.json",
						f.root,
					),
					'{"name":"@scope/real","version":"2.3.4"}',
				);
			}
			const requests: string[][] = [];
			const plan = await Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					{ ...settings, dependencyStrategy: "install" },
					{
						resolve: (name, requirement) => {
							requests.push([name, requirement]);
							if (name === "example")
								return Promise.resolve({
									version: "1.2.3",
									...edges,
								});
							if (name === "@scope/real")
								return Promise.resolve({ version: "2.3.4" });
							throw new Error("Unpublished alias");
						},
					},
				),
			);
			expect(requests).toContainEqual([
				"@scope/real",
				optional ? "^2" : "2.3.4",
			]);
			await Effect.runPromise(
				FunctionArtifact.applyPreparation(plan),
			);
			expect(
				JSON.parse(
					await readFile(
						new URL("package-lock.json", f.server),
						"utf8",
					),
				),
			).toMatchObject({
				packages: {
					"node_modules/example": {
						[optional ? "optionalDependencies" : "dependencies"]:
							{ "runtime-alias": "npm:@scope/real@2.3.4" },
					},
					"node_modules/runtime-alias": {
						name: "@scope/real",
						version: "2.3.4",
						...(optional ? { optional: true } : {}),
					},
				},
			});
		},
	);

	it("keeps nested alias metadata associated with its actual registry identity", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import value from 'example';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		for (const [location, name, version, dependencies] of [
			[
				"example",
				"example",
				"1.0.0",
				{ "runtime-alias": "npm:real-b@^1" },
			],
			["runtime-alias", "real-a", "1.2.3", {}],
			[
				"example/node_modules/runtime-alias",
				"real-b",
				"1.2.3",
				{ "good-child": "^2" },
			],
			["good-child", "good-child", "2.0.0", {}],
		] as const) {
			await mkdir(new URL(`node_modules/${location}/`, f.root), {
				recursive: true,
			});
			await writeFile(
				new URL(`node_modules/${location}/package.json`, f.root),
				JSON.stringify({ name, version, dependencies }),
			);
		}
		await writeFile(
			new URL("package-lock.json", f.root),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"node_modules/example": {
						version: "1.0.0",
						dependencies: { "runtime-alias": "npm:real-b@^1" },
					},
					"node_modules/runtime-alias": {
						name: "real-a",
						version: "1.2.3",
						resolved: "https://registry.example/real-a.tgz",
						integrity: "sha512-wrong-a",
						dependencies: { "wrong-child": "1.0.0" },
					},
				},
			}),
		);
		const requests: string[][] = [];
		const before = await snapshot(f.directory);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name, version) => {
						requests.push([name, version]);
						if (name === "real-b")
							return Promise.resolve({
								version: "1.2.3",
								resolved: "https://registry.example/real-b.tgz",
								integrity: "sha512-correct-b",
								dependencies: { "good-child": "^2" },
							});
						if (name === "good-child")
							return Promise.resolve({ version: "2.0.0" });
						throw new Error(
							`Unexpected registry lookup ${name}`,
						);
					},
				},
			),
		);
		expect(requests).toContainEqual(["real-b", "1.2.3"]);
		expect(await snapshot(f.directory)).toEqual(before);
		await Effect.runPromise(
			FunctionArtifact.applyPreparation(plan),
		);
		const lock = JSON.parse(
			await readFile(
				new URL("package-lock.json", f.server),
				"utf8",
			),
		) as { packages: Record<string, unknown> };
		const alias = Object.entries(lock.packages).filter(
			([location]) => location.endsWith("/runtime-alias"),
		);
		expect(alias).toHaveLength(1);
		expect(alias[0]?.[1]).toMatchObject({
			name: "real-b",
			version: "1.2.3",
			resolved: "https://registry.example/real-b.tgz",
			integrity: "sha512-correct-b",
			dependencies: { "good-child": "2.0.0" },
		});
		expect(JSON.stringify(lock)).not.toContain("wrong-child");
		expect(JSON.stringify(lock)).not.toContain("real-a.tgz");
	});

	it("uses registry edges when a legacy lockfile has no packages section", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import value from 'example';\n${f.index}`,
		);
		await writeFile(
			new URL("package.json", f.root),
			'{"name":"app"}',
		);
		for (const [name, version] of [
			["example", "1.2.3"],
			["child", "2.3.4"],
		]) {
			await mkdir(new URL(`node_modules/${name}/`, f.root), {
				recursive: true,
			});
			await writeFile(
				new URL(`node_modules/${name}/package.json`, f.root),
				JSON.stringify({ name, version }),
			);
		}
		await writeFile(
			new URL("package-lock.json", f.root),
			JSON.stringify({
				lockfileVersion: 1,
				dependencies: {
					example: {
						version: "1.2.3",
						requires: { child: "^2.0.0" },
					},
					child: { version: "2.3.4" },
				},
			}),
		);
		const plan = await Effect.runPromise(
			FunctionArtifact.planPreparation(
				f.build,
				f.routePlan,
				{ ...settings, dependencyStrategy: "install" },
				{
					resolve: (name) =>
						Promise.resolve(
							name === "example"
								? {
										version: "1.2.3",
										dependencies: { child: "^2.0.0" },
									}
								: { version: "2.3.4" },
						),
				},
			),
		);
		const lock = plan.mutations.find(
			(mutation) =>
				mutation.kind === "writeFile" &&
				mutation.path.pathname.endsWith("package-lock.json"),
		);
		expect(
			lock?.kind === "writeFile" && JSON.parse(lock.contents),
		).toMatchObject({
			packages: {
				"node_modules/example": {
					dependencies: { child: "2.3.4" },
				},
				"node_modules/child": { version: "2.3.4" },
			},
		});
	});

	it.each(
		[
			'import {make} from "data:text/javascript,export%20%7BcreateRequire%20as%20make%7D%20from%20%22node%3Amodule%22";make(import.meta.url)("example");',
			`await import("data:application/javascript;base64,${Buffer.from("export * from 'node:module'").toString("base64")}");`,
			`export * from "data:text/javascript,${encodeURIComponent('import "data:text/javascript,export * from %27node:module%27"')}";`,
			"import {register as installHooks} from 'node:module';installHooks('example',import.meta.url);",
			"async function loadLoggerDestination(entrypoint){return import(entrypoint)}",
			"const p=typeof process==='object'?process:{};p.getBuiltinModule(process.env.BUILTIN);",
			"const p=typeof process==='object'?process:{};p[process.env.KEY]('module');",
			"const p=typeof process==='object'?process:{};consume(p.getBuiltinModule);",
			"const p=typeof process==='object'?process:{};export const {getBuiltinModule:get}=p;",
			"import * as mod from 'node:module';const p=typeof process==='object'?process:mod;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let p;p=process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let p;p=globalThis.process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"import proc from 'node:process';let p;p=proc;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"const proc=process;let p;p=proc;p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let p;p=globalThis.process||{};p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let p;p=await import('node:process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let p;p=process.getBuiltinModule('process');p.getBuiltinModule('module').createRequire(import.meta.url)('example');",
			"let get;({getBuiltinModule:get}=process);get('module').createRequire(import.meta.url)('example');",
			"function run({...p}=process){p.getBuiltinModule('module').createRequire(import.meta.url)('example')}run();",
			"function run({['getBuiltinModule']:get}=process){get('module').createRequire(import.meta.url)('example')}run();",
			"function run({getBuiltinModule:get=undefined}=process){get('module').createRequire(import.meta.url)('example')}run();",
			"import proc from 'node:process';proc.getBuiltinModule(process.env.BUILTIN);",
			"import * as proc from 'node:process';proc[process.env.KEY]('module');",
			"import {getBuiltinModule as get} from 'node:process';consume(get);",
			"import {getBuiltinModule as get} from 'process';get(process.env.BUILTIN);",
			"const p=await import('node:process');p.getBuiltinModule(process.env.BUILTIN);",
			"import {createRequire} from 'node:module';const req=createRequire(import.meta.url);req('process').getBuiltinModule(process.env.BUILTIN);",
			"export {getBuiltinModule as get} from 'node:process';",
			"export * from 'process';",
			"var p=process;p.getBuiltinModule('module').createRequire(import.meta.url)('example');var p=null;",
			"const {getBuiltinModule:get}=process;get(process.env.BUILTIN);",
			"consume(process.getBuiltinModule);",
			"process.getBuiltinModule(process.env.BUILTIN);",
			"export const {getBuiltinModule:get}=process;",
			"export const {'getBuiltinModule':get}=process;",
			"var {getBuiltinModule:get}=process;get('module').createRequire(import.meta.url)('example');var get=null;",
			"process[process.env.BUILTIN_GETTER]('module');",
			"const p=globalThis.process || {};p.getBuiltinModule(process.env.BUILTIN);",
			"globalThis.process.getBuiltinModule(process.env.BUILTIN);",
			"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); if(typeof load === 'function') consume(load);",
			"import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); load(process.env.RUNTIME_PACKAGE);",
			"import * as mod from 'node:module'; const {builtinModules, createRequire: make} = mod; consume(make);",
			"import * as mod from 'node:module'; const {builtinModules, createRequire: make} = mod; const load = make(import.meta.url); load(process.env.RUNTIME_PACKAGE);",
			"import * as mod from 'node:module'; const {builtinModules, Module: moduleClass} = mod; consume(moduleClass);",
			"import * as mod from 'node:module'; const {builtinModules, default: moduleClass} = mod; consume(moduleClass);",
			"import * as mod from 'node:module'; const {register} = mod; register('example', import.meta.url);",
			"import * as mod from 'node:module'; const {register: installHooks} = mod; installHooks('example', import.meta.url);",
			"import * as mod from 'node:module'; const {builtinModules, 'register': installHooks} = mod; installHooks('example', import.meta.url);",
			"const {register: installHooks} = await import('node:module'); installHooks('example', import.meta.url);",
			"import {registerHooks} from 'node:module'; registerHooks({}); await import('example');",
			"import {registerHooks as install} from 'node:module'; install({});",
			"import * as mod from 'node:module'; const {registerHooks: install} = mod; install({});",
			"import * as mod from 'node:module'; mod.registerHooks({});",
			"const {registerHooks} = await import('node:module'); registerHooks({});",
			"export {registerHooks} from 'node:module';",
			"import.meta.resolve(process.env.RUNTIME_PACKAGE);",
			"const locate = import.meta.resolve; locate(process.env.RUNTIME_PACKAGE);",
			"consume(import.meta.resolve);",
			"import.meta.resolve('example/asset.css', import.meta.url);",
			"const meta = import.meta; meta.resolve(process.env.RUNTIME_PACKAGE);",
			"const meta = import.meta; consume(meta);",
			"consume(import.meta);",
			"const meta = import.meta; meta[process.env.RESOLVER]('example');",
			"import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); req[process.env.RESOLVER]('example');",
			"const meta = import.meta; const {resolve: locate} = meta; consume(locate);",
			"const {resolve: locate} = import.meta; locate(process.env.RUNTIME_PACKAGE);",
			"const meta = import.meta; export {meta};",
			"export const meta = import.meta;",
			"export const {resolve} = import.meta;",
			"const meta = import.meta; export const {url, resolve: locate} = meta;",
			"export const {'resolve': url} = import.meta;",
			"export var {resolve: locate} = import.meta; locate('example/asset.css'); var locate = null;",
			"var locate = import.meta.resolve; locate('example/asset.css'); var locate = null;",
			"var {resolve: locate} = import.meta; locate('example/asset.css'); var locate = null;",
			"var meta = import.meta; meta.resolve('example/asset.css'); var meta = null;",
			"import {createRequire} from 'node:module'; var load = createRequire(import.meta.url); load('example'); var load = null;",
			"var {createRequire: make} = await import('node:module'); const load = make(import.meta.url); load('example'); var make = null;",
			"var locate = null; var locate = import.meta.resolve; locate('example/asset.css');",
			"export var {'resolve': locate} = import.meta; locate('example/asset.css'); var locate = null;",
			"export var {resolve} = import.meta; resolve('example/asset.css'); var resolve = null;",
			"const meta = import.meta; export var {url, resolve: locate} = meta; locate('example/asset.css'); var locate = null;",
			"const meta = import.meta; const {...copy} = meta; copy.resolve('example');",
			"const meta = import.meta; meta.resolve('example/asset.css', meta.url);",
			"import {createRequire} from 'node:module'; var load = createRequire(import.meta.url); var load; load(process.env.RUNTIME_PACKAGE);",
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({ source, dependencyStrategy }),
			),
		),
	)(
		"rejects unaccounted Node loader use before writing output: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`${source}\n${f.index}`,
			);
			const before = await snapshot(f.directory);
			const outcome = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
					),
				),
			);
			expect(outcome).toMatchObject({
				_tag: "Left",
				left: {
					_tag: "UnresolvedDependency",
				},
			});
			expect(outcome).toHaveProperty(
				"left.message",
				expect.stringMatching(/unresolved dynamic/),
			);
			expect(await snapshot(f.directory)).toEqual(before);
		},
	);

	it.each([
		{ dynamic: true, accepted: true },
		{ dynamic: false, accepted: false },
	])(
		"handles an inline module that fails to parse (dynamic: $dynamic)",
		async ({ dynamic, accepted }) => {
			const f = await fixture();
			const request = JSON.stringify(
				`data:text/javascript,${encodeURIComponent("export const = ;")}`,
			);
			await writeFile(
				new URL("index.js", f.server),
				(dynamic
					? `export async function observe() { try { await import(${request}); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return "fallback"; } }`
					: `import ${request};`) + `\n${f.index}`,
			);
			if (dynamic) {
				const { stdout } = await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						'import { observe } from "./index.js"; console.log(await observe());',
					],
					{ cwd: fileURLToPath(f.server) },
				);
				expect(stdout.trim()).toBe("fallback");
			}
			const planning = Effect.runPromise(
				FunctionArtifact.planPreparation(
					f.build,
					f.routePlan,
					settings,
				),
			);
			if (accepted)
				await expect(planning).resolves.toBeDefined();
			else await expect(planning).rejects.toThrow();
		},
	);

	it.each(
		[
			'const require = typeof globalThis.require === "function" ? globalThis.require : createRequire(import.meta.url);export const value = require("example");',
			'const load = Math.random() > 2 ? undefined : createRequire(import.meta.url);export const value = load("example");',
			'const load = globalThis.missing || createRequire(import.meta.url);export const value = load("example");',
			'const load = Math.random() > 2 ? null : createRequire(import.meta.url);export const value = load?.("example");',
		].flatMap((source) =>
			(["bundle", "install"] as const).map(
				(dependencyStrategy) => ({
					source,
					dependencyStrategy,
				}),
			),
		),
	)(
		"never accepts a conditional createRequire loader without its package: %j",
		async ({ source, dependencyStrategy }) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`import { createRequire } from "node:module";${source}\n${f.index}`,
			);
			await mkdir(new URL("node_modules/example/", f.root), {
				recursive: true,
			});
			await writeFile(
				new URL("node_modules/example/package.json", f.root),
				'{"name":"example","version":"1.2.3"}',
			);
			await writeFile(
				new URL("node_modules/example/index.js", f.root),
				'module.exports = "loaded";',
			);
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`const m=await import(${JSON.stringify(new URL("index.js", f.server).href)});process.stdout.write(m.value);`,
				],
				{ cwd: f.directory },
			);
			expect(stdout).toBe("loaded");
			const result = await Effect.runPromise(
				Effect.either(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{ ...settings, dependencyStrategy },
						{
							resolve: () =>
								Promise.resolve({ version: "1.2.3" }),
						},
					),
				),
			);
			// Tracking or rejecting the selected loader are both safe; silent acceptance is not.
			if (result._tag === "Left") {
				expect(result.left.message).toMatch(
					/example|unresolved dynamic/,
				);
				return;
			}
			expect(dependencyStrategy).toBe("install");
			const lock = result.right.mutations.find(
				(m) =>
					m.kind === "writeFile" &&
					m.path.pathname.endsWith("package-lock.json"),
			);
			expect(
				lock?.kind === "writeFile" && JSON.parse(lock.contents),
			).toMatchObject({
				packages: {
					"node_modules/example": { version: "1.2.3" },
				},
			});
		},
	);

	it.each(["bundle", "install"] as const)(
		"keeps a local function named registerHooks ordinary (%s)",
		async (dependencyStrategy) => {
			const f = await fixture();
			await writeFile(
				new URL("index.js", f.server),
				`function registerHooks(value) { return value; } registerHooks({}); import('node:path');\n${f.index}`,
			);
			await expect(
				Effect.runPromise(
					FunctionArtifact.planPreparation(
						f.build,
						f.routePlan,
						{
							...settings,
							dependencyStrategy,
						},
					),
				),
			).resolves.toBeDefined();
		},
	);

	it("stops applying on failure and retains earlier mutations without rollback", async () => {
		const f = await fixture();
		const first = new URL("first.txt", f.root);
		const last = new URL("last.txt", f.root);
		const plan: FunctionArtifact.PreparationPlan = {
			mutations: [
				{ kind: "writeFile", path: first, contents: "first" },
				{
					kind: "writeFile",
					path: new URL("missing/child.txt", f.root),
					contents: "fail",
				},
				{ kind: "writeFile", path: last, contents: "never" },
			],
			plannedOutput: { routePlan: f.routePlan, functions: [] },
		};
		const outcome = await Effect.runPromise(
			Effect.either(FunctionArtifact.applyPreparation(plan)),
		);
		expect(outcome).toMatchObject({
			_tag: "Left",
			left: {
				_tag: "InvalidArtifact",
				cause: { code: "ENOENT" },
			},
		});
		expect(await readFile(first, "utf8")).toBe("first");
		await expect(access(last)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("keeps default objects private to the Options module", () => {
		expect(
			Object.keys(Options).filter((name) =>
				/default/i.test(name),
			),
		).toEqual([]);
	});
});
