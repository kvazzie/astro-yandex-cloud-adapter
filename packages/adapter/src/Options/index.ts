import * as Context from "effect/Context";
import * as S from "effect/Schema";

import { ObjectStorageTargetOptions } from "./ObjectStorageTargetOptions.ts";
import { ObjectStorageCloudFunctionsTargetOptions } from "./ObjectStorageCloudFunctionsTargetOptions.ts";

export { Targets } from "@astro-yandex-cloud/deployment-manifest/v1/target-encoding";

export * as Errors from "./Errors.ts";
export {
	ObjectStorageTargetOptions,
	ObjectStorageCloudFunctionsTargetOptions,
};

export const Schema = S.Union(
	ObjectStorageTargetOptions,
	ObjectStorageCloudFunctionsTargetOptions,
).pipe(S.brand("Options"));

export type Target = (typeof Schema.Type)["target"];
export type DependencyStrategy =
	(typeof ObjectStorageCloudFunctionsTargetOptions.Type)["dependencyStrategy"];
export type FunctionPartition =
	(typeof ObjectStorageCloudFunctionsTargetOptions.Type)["functions"];

export class Tag extends Context.Tag(
	"@astro-yandex-cloud/adapter/Options",
)<Tag, typeof Schema.Type>() {}
