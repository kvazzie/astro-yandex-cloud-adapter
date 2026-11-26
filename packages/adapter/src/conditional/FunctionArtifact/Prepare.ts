import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PackageJson } from "pkg-types";
import {
	manifestRoutes,
	type RoutePlan,
} from "../../mandatory/ArtifactGeneration/RouteRequirements";
import type {
	FunctionArtifactBuild,
	FunctionArtifactDescriptor,
	FunctionArtifactPolicy,
	Mutation,
	PlannedFile,
	PreparationSettings,
} from "./.types.ts";
import {
	formatFunctionPackageJson,
	formatNpmLockfile,
} from "./Dependency/Metadata.ts";
import { type Registry } from "./Dependency/Registry.ts";
import { traceRuntimeDependencies } from "./Dependency/Trace.ts";
import { planLocalArchives } from "./Dependency/Archive.ts";
import { resolvePinnedRuntimeDependencies } from "./Dependency";

export async function planPackageFiles(
	files: readonly PlannedFile[],
	strategy: PreparationSettings["dependencyStrategy"],
	appRoot: URL,
	registry: Registry,
	serverDirectory: URL,
	includeLocal = false,
	includeDependencies: readonly string[] = [],
): Promise<PlannedFile[]> {
	if (
		strategy === "bundle" &&
		files.some((file) => file.path.endsWith(".node"))
	)
		throw new Error(
			'The Function Artifact contains a native runtime module, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
		);
	if (files.some((file) => file.path.endsWith(".cjs")))
		throw new Error(
			"The function artifact contains an unsupported CommonJS module. V1 function artifacts must use ESM.",
		);
	const trace = await traceRuntimeDependencies(
		files,
		serverDirectory,
	);
	if (strategy === "install") {
		const graph = await resolvePinnedRuntimeDependencies(
			appRoot,
			new Set([...trace.packages, ...includeDependencies]),
			registry,
			includeLocal,
		);
		const { dependencies: pinned, files: archives } =
			await planLocalArchives(graph, trace);
		return [
			...archives,
			{
				path: "package.json",
				contents: formatFunctionPackageJson(
					pinned,
					emittedResolution(files),
				),
			},
			{
				path: "package-lock.json",
				contents: formatNpmLockfile(pinned),
			},
		];
	}
	const dependencyNames = trace.packages;
	if (dependencyNames.has("sharp"))
		throw new Error(
			'The Function Artifact contains the native runtime dependency sharp, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
		);
	if (dependencyNames.size)
		throw new Error(
			`The "bundle" dependency strategy left unresolved runtime package imports in the Function Artifact: ${Array.from(dependencyNames).sort().join(", ")}. Bundle these packages with Astro/Vite or select dependencyStrategy: "install".`,
		);
	const packageJson: PackageJson = {
		private: true,
		type: "module",
		engines: { node: ">=22.12.0" },
		...emittedResolution(files),
		dependencies: {},
	};
	return [
		{
			path: "package.json",
			contents: `${JSON.stringify(packageJson, null, 2)}\n`,
		},
	];
}

/**
 * Keeps the emitted package fields that Node uses to resolve the artifact's own modules:
 * `imports`, and the `name` and `exports` a package self-reference such as an
 * `imports` target `"server-app/helper"` resolves through.
 */
function emittedResolution(
	files: readonly PlannedFile[],
): Pick<PackageJson, "name" | "exports" | "imports"> {
	const emitted = files.find(
		(file) => file.path === "package.json",
	);
	if (emitted?.contents === undefined) return {};
	let manifest: unknown;
	try {
		// Node accepts one leading byte order mark in package.json.
		manifest = JSON.parse(
			emitted.contents.replace(/^\uFEFF/, ""),
		);
	} catch (cause) {
		throw new Error(
			"The emitted Function Artifact package.json is not valid JSON.",
			{ cause },
		);
	}
	if (typeof manifest !== "object" || manifest === null)
		return {};
	const { name, exports, imports } = manifest as {
		name?: unknown;
		exports?: unknown;
		imports?: unknown;
	};
	return {
		...(name === undefined
			? {}
			: { name: name as PackageJson["name"] }),
		...(exports === undefined
			? {}
			: { exports: exports as PackageJson["exports"] }),
		...(imports === undefined
			? {}
			: { imports: imports as PackageJson["imports"] }),
	};
}

type FunctionEntrypointValidation =
	{ ok: true } | { ok: false; reason: string; cause: unknown };

export async function validateFunctionEntrypoint(
	functionDirectory: URL,
): Promise<FunctionEntrypointValidation> {
	const entrypoint = new URL("index.js", functionDirectory);
	try {
		if ((await stat(entrypoint)).isFile()) return { ok: true };
		return {
			ok: false,
			reason:
				"The Function Artifact entrypoint index.js is not a regular file.",
			cause: undefined,
		};
	} catch (error) {
		return {
			ok: false,
			reason:
				"Astro did not emit the expected Function Artifact entrypoint index.js.",
			cause: error,
		};
	}
}

/** Describes 404 copies and handler policies without creating their destination files. */
export function planNotFoundArtifacts(
	build: FunctionArtifactBuild,
	routePlan: RoutePlan,
	functions: readonly FunctionArtifactDescriptor[],
	recursive404: boolean,
): {
	mutations: Mutation[];
	policies: Map<
		string,
		Omit<FunctionArtifactPolicy, "artifactDirectory">
	>;
} {
	const scopes = manifestRoutes(
		routePlan,
		recursive404,
	).notFound;
	const pageFunctions = new Set<string>(
		routePlan.routes.flatMap((route) =>
			route.kind === "on-demand" && route.routeKind === "page"
				? [route.artifactId]
				: [],
		),
	);
	const policies = new Map<
		string,
		Omit<FunctionArtifactPolicy, "artifactDirectory">
	>();
	const mutations: Mutation[] = [];
	const prefix =
		routePlan.base === "/" ? "" : `${routePlan.base.slice(1)}/`;
	for (const artifact of functions) {
		const policy: Omit<
			FunctionArtifactPolicy,
			"artifactDirectory"
		> = {};
		if (pageFunctions.has(artifact.id) && scopes.length) {
			policy.notFound = [];
			mutations.push({
				kind: "mkdir",
				root: artifact.directory,
				path: new URL(".yandex/404/", artifact.directory),
			});
			for (const scope of scopes) {
				const name = createHash("sha256")
					.update(scope.url)
					.digest("hex")
					.slice(0, 16);
				const file = `.yandex/404/${name}.html`;
				mutations.push({
					kind: "copyFile",
					root: artifact.directory,
					from: pathToFileURL(
						join(
							fileURLToPath(build.config.build.client),
							scope.objectKey.slice(prefix.length),
						),
					),
					to: new URL(file, artifact.directory),
				});
				policy.notFound.push({
					scope: scope.scope,
					url: scope.url,
					file,
				});
			}
		}
		policies.set(artifact.id, policy);
	}
	return { mutations, policies };
}
