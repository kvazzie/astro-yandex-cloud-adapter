import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reads the calling module's package name and version, including after bundling.
 * @param {string | URL} moduleUrl The caller's import.meta.url.
 * @returns {import("../index.d.ts").PackageInfo}
 */
export function readPackageInfo(moduleUrl) {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (basename(directory) !== "node_modules") {
    const path = join(directory, "package.json");
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch (cause) {
      if (/** @type {NodeJS.ErrnoException} */ (cause).code !== "ENOENT")
        throw cause;
    }

    if (source !== undefined) {
      const metadata = /** @type {unknown} */ (JSON.parse(source));
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !("name" in metadata) ||
        typeof metadata.name !== "string" ||
        !metadata.name.trim() ||
        !("version" in metadata) ||
        typeof metadata.version !== "string" ||
        !metadata.version.trim()
      ) {
        throw new TypeError(
          `${path} must declare a non-empty package name and version.`,
        );
      }
      return { name: metadata.name, version: metadata.version };
    }

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`No package.json found for ${String(moduleUrl)}.`);
}
