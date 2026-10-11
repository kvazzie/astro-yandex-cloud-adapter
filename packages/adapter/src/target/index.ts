import type { Options } from "../integration/options.js";
import { objectStorageFunctionsModule } from "./object-storage-functions.js";
import { objectStorageModule } from "./object-storage.js";

export function selectTarget(options: Options) {
  return options.target === "object-storage"
    ? objectStorageModule(options)
    : objectStorageFunctionsModule(options);
}
