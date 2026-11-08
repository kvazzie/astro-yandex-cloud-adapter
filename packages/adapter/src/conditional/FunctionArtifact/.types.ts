import type { IntegrationResolvedRoute } from "astro";
import type { RoutePlan } from "../../mandatory/ArtifactGeneration/RouteRequirements";

export interface FunctionArtifactBuild {
	readonly config: {
		readonly root: URL;
		readonly outDir: URL;
		readonly base: string;
		readonly build: {
			readonly server: URL;
			readonly client: URL;
		};
	};
	readonly resolvedRoutes: readonly Pick<
		IntegrationResolvedRoute,
		"pattern" | "entrypoint"
	>[];
}
export interface PreparationSettings {
	readonly functions: "shared" | "separate";
	readonly dependencyStrategy: "bundle" | "install";
	readonly recursive404: boolean;
}
export interface FunctionArtifactDescriptor {
	readonly id: string;
	readonly path: string;
	readonly directory: URL;
	readonly runtime: "nodejs22";
	readonly entrypoint: "index.handler";
	readonly allowedRoutes?: readonly string[];
}
export interface PreparationOutput {
	readonly routePlan: RoutePlan;
	readonly functions: readonly FunctionArtifactDescriptor[];
}
export type Mutation =
	| {
			readonly kind: "writeFile";
			readonly path: URL;
			readonly contents: string;
	  }
	| {
			readonly kind: "copyFile";
			readonly from: URL;
			readonly to: URL;
	  }
	| { readonly kind: "mkdir"; readonly path: URL }
	| { readonly kind: "removeDirectory"; readonly path: URL };
export interface PreparationPlan {
	readonly mutations: readonly Mutation[];
	readonly plannedOutput: PreparationOutput;
}
/** Contents are computed in memory; from records an unchanged source when present. */
export type PlannedFile = { readonly path: string } & (
	| { readonly contents: string; readonly from?: URL }
	| { readonly from: URL; readonly contents?: never }
);

/** Completed-build routing and static error assets owned by one Function. */
export interface FunctionArtifactPolicy {
	allowedRoutes?: readonly string[];
	notFound?: Array<{ scope: string; url: string; file: string }>;
	artifactDirectory?: URL;
}
