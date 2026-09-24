import * as dependencies from "./dependencies.js";
import * as drivers from "./drivers.js";
import type { TargetDriver } from "./drivers.js";
import type { AdapterOptions } from "../types.js";

export function createDriver(options: AdapterOptions | undefined): TargetDriver {
  const target = options?.target ?? "object-storage";
  if (target !== "object-storage" && target !== "object-storage-functions") {
    throw new TypeError(`Unknown Yandex Cloud adapter target: ${String(target)}.`);
  }
  const policy = dependencies.createDependencyStrategyPolicy(
    options?.dependencyStrategy,
  );
  if (target === "object-storage") {
    return new drivers.ObjectStorageDriver(policy);
  }
  return new drivers.ObjectStorageFunctionsDriver(policy);
}
