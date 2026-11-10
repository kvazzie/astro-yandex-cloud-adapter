import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import * as FunctionArtifact from "../../packages/adapter/src/conditional/FunctionArtifact";
import * as Options from "../../packages/adapter/src/Options";
import type { RoutePlan } from "../../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements";

const directories: string[] = [];
afterEach(async () => {
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
			} else
				result[relative(directory, child)] = (
					await readFile(child)
				).toString("base64");
		}
	};
	await visit(directory);
	return result;
}

async function fixture() {
	const directory = await mkdtemp(
		join(tmpdir(), "astro-function-plan-"),
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

	it("plans exact install metadata without writing it or using implicit strategy defaults", async () => {
		const f = await fixture();
		await writeFile(
			new URL("index.js", f.server),
			`import value from 'example';\n${f.index}`,
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
