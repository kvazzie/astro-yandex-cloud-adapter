import type { DependencyStrategy, YandexCloudManifestV1 } from "./types.js";

export type FunctionSharpSupport = NonNullable<
  YandexCloudManifestV1["artifacts"]["function"]
>["support"]["sharp"];

export const defaults: {
  STRATEGY: DependencyStrategy;
  SHARP_SUPPORT: FunctionSharpSupport;
} = {
  STRATEGY: "bundle",
  SHARP_SUPPORT: "unsupported",
};
