import type { BuildPlan } from "../integration/options.js";
import { objectStorageFunctionsModule } from "./object-storage-functions.js";
import { objectStorageModule } from "./object-storage.js";

export function selectTarget(plan: BuildPlan) {
  return plan.target === "object-storage"
    ? objectStorageModule(plan)
    : objectStorageFunctionsModule(plan);
}
