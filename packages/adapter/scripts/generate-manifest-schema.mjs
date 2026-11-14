import { copyFile, mkdir } from "node:fs/promises";
import { URL } from "node:url";

// Keep the adapter's existing schema artifact path while the shared package
// owns generation and the versioned schema contract.
const directory = new URL("../.generated/", import.meta.url);
await mkdir(directory, { recursive: true });
await copyFile(
	new URL(
		import.meta
			.resolve("@astro-yandex-cloud/deployment-manifest/deployment-manifest.schema.json"),
	),
	new URL("deployment-manifest.schema.json", directory),
);
