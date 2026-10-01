import type { AstroAdapter, AstroConfig, IntegrationResolvedRoute } from "astro";
import type { Effect } from "effect";
import type { InlineConfig } from "vite";

import type { CompletedBuild } from "../integration/session.js";
import type { DeploymentManifestV1, Target } from "../types.js";

export interface AstroBuildConfigPatch {
  build: { client: URL; server: URL; serverEntry: string };
}

export type BuildError =
  | { _tag: "InvalidConfiguration"; message: string; cause?: unknown }
  | { _tag: "UnsupportedRoute"; message: string; cause?: unknown }
  | { _tag: "InvalidArtifact"; message: string; cause?: unknown }
  | { _tag: "UnresolvedDependency"; message: string; cause?: unknown }
  | { _tag: "InvalidManifest"; message: string; cause?: unknown };

export interface TargetModule {
  readonly target: Target;
  astroBuildConfig(
    config: AstroConfig,
  ): Effect.Effect<AstroBuildConfigPatch, BuildError>;
  astroAdapter(
    routes: readonly IntegrationResolvedRoute[],
  ): Effect.Effect<AstroAdapter, BuildError>;
  serverViteConfig(vite: InlineConfig): InlineConfig;
  generateArtifacts(
    build: CompletedBuild,
  ): Effect.Effect<DeploymentManifestV1, BuildError>;
}
