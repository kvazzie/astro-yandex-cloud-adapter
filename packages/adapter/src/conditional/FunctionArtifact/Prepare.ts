import { access } from "node:fs/promises";
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
import { findRuntimePackageImports } from "./Dependency/ImportSpecifier.ts";
import { resolvePinnedRuntimeDependencies } from "./Dependency";

export async function planPackageFiles(
	files: readonly PlannedFile[],
	strategy: PreparationSettings["dependencyStrategy"],
	appRoot: URL,
	registry: Registry,
): Promise<PlannedFile[]> {
	const dependencyNames = findRuntimePackageImports(
		files,
		strategy,
	);
	if (strategy === "install") {
		const pinned = await resolvePinnedRuntimeDependencies(
			appRoot,
			dependencyNames,
			registry,
		);
		return [
			{
				path: "package.json",
				contents: formatFunctionPackageJson(pinned),
			},
			{
				path: "package-lock.json",
				contents: formatNpmLockfile(pinned),
			},
		];
	}
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
		dependencies: {},
	};
	return [
		{
			path: "package.json",
			contents: `${JSON.stringify(packageJson, null, 2)}\n`,
		},
	];
}

type FunctionEntrypointValidation =
	{ ok: true } | { ok: false; reason: string; cause: unknown };

export async function validateFunctionEntrypoint(
	functionDirectory: URL,
): Promise<FunctionEntrypointValidation> {
	const entrypoint = new URL("index.js", functionDirectory);
	try {
		await access(entrypoint);
		return { ok: true };
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
