import type { DeploymentManifestV1 } from "./manifest/schema.js";

export type Target = "object-storage" | "object-storage-functions";
export type DependencyStrategy = "bundle" | "install";
export type FunctionPartition = "shared" | "separate";

export interface AdapterOptions {
  target?: Target;
  dependencyStrategy?: DependencyStrategy;
  apiGateway?: boolean;
  recursive404?: boolean;
  functions?: FunctionPartition;
  directOrigin?: string;
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
