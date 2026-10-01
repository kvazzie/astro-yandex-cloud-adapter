import { Schema } from "effect";

import type { DependencyStrategy, Target } from "../types.js";

export type RoutingPlan =
  { kind: "direct" } | { kind: "gateway"; recursive404: boolean };

export type BuildPlan =
  | { target: "object-storage"; routing: RoutingPlan }
  | {
      target: "object-storage-functions";
      routing: RoutingPlan;
      dependencyStrategy: DependencyStrategy;
      functionLayout: "shared" | "per-route";
    };

const optionsSchema = Schema.Struct({
  target: Schema.optional(
    Schema.Literal("object-storage", "object-storage-functions"),
  ),
  dependencyStrategy: Schema.optional(Schema.Literal("bundle", "install")),
});

/** Validates user choices once for the integration instance. */
export function decodeOptions(value: unknown): BuildPlan {
  let options: Schema.Schema.Type<typeof optionsSchema>;
  try {
    options = Schema.decodeUnknownSync(optionsSchema)(value ?? {});
  } catch {
    if (
      typeof value === "object" &&
      value !== null &&
      "target" in value &&
      !(["object-storage", "object-storage-functions"] as unknown[]).includes(
        value.target,
      )
    ) {
      throw new TypeError(
        `Unknown Yandex Cloud adapter target: ${String(value.target)}.`,
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "dependencyStrategy" in value
    ) {
      throw new TypeError(
        `Unknown Yandex Cloud adapter dependency strategy: ${String(value.dependencyStrategy)}.`,
      );
    }
    throw new TypeError("Invalid Yandex Cloud adapter options.");
  }
  const target: Target = options.target ?? "object-storage";
  if (target === "object-storage") {
    if (options.dependencyStrategy && options.dependencyStrategy !== "bundle")
      throw new TypeError(
        `The ${options.dependencyStrategy} dependency strategy requires the Object Storage + Cloud Functions Target.`,
      );
    return { target, routing: { kind: "direct" } };
  }
  return {
    target,
    routing: { kind: "direct" },
    dependencyStrategy: options.dependencyStrategy ?? "bundle",
    functionLayout: "shared",
  };
}
