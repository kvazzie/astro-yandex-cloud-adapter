import type { DeploymentManifestV1 } from "./manifest/schema.ts";
import type { OptionsSchema } from "./integration/options.ts";

export type Target = "object-storage" | "object-storage-functions";
export type DependencyStrategy = "bundle" | "install";
export type FunctionPartition = "shared" | "separate";

export type AdapterOptions = typeof OptionsSchema.Encoded;

export type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudRuntime,
} from "./runtime/types.ts";

export type {
  DeploymentManifestV1,
  OnDemandRouteRequirement,
  PrerenderedRouteRequirement,
} from "./manifest/schema.ts";

export type YandexCloudManifestV1 = DeploymentManifestV1;
