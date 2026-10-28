import type { Options } from "../integration/options.ts";
import { objectStorageFunctionsModule } from "./object-storage-functions.ts";
import { objectStorageModule } from "./object-storage.ts";

export function selectTarget(options: Options) {
  return options.target === "object-storage"
    ? objectStorageModule(options)
    : objectStorageFunctionsModule(options);
}
