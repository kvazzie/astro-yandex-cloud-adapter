import type { DeploymentManifestV1 } from "./manifest/schema.js";

export type Target = "object-storage" | "object-storage-functions";
export type DependencyStrategy = "bundle" | "install";

export interface AdapterOptions {
  target?: Target;
  dependencyStrategy?: DependencyStrategy;
}

export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./runtime/types.js";

export type {
  DeploymentManifestV1,
  OnDemandRouteRequirement,
  PrerenderedRouteRequirement,
} from "./manifest/schema.js";

export type YandexCloudManifestV1 = DeploymentManifestV1;
