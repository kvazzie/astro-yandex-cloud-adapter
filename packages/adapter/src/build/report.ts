import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegrationLogger } from "astro";
import { glob } from "tinyglobby";

import type { DeploymentManifestV1 } from "../types.js";

/** Reports local file bytes, without constructing or validating deployment archives. */
export async function reportArtifactSizes(
  outDir: URL,
  manifest: DeploymentManifestV1,
  logger: AstroIntegrationLogger,
): Promise<void> {
  const artifacts = [
    { kind: "Client", ...manifest.artifacts.client },
    ...manifest.artifacts.functions.map((artifact) => ({
      kind: "Function",
      ...artifact,
    })),
  ];
  for (const artifact of artifacts) {
    const directory = new URL(`${artifact.path}/`, outDir);
    const directoryPath = fileURLToPath(directory);
    const files = await glob("**/*", {
      cwd: directoryPath,
      dot: true,
      onlyFiles: true,
    });
    let totalBytes = 0;
    let largestFileBytes = 0;
    for (const file of files) {
      const { size } = await stat(join(directoryPath, file));
      totalBytes += size;
      largestFileBytes = Math.max(largestFileBytes, size);
    }
    logger.info(
      `${artifact.kind} Artifact ${artifact.path}: ${totalBytes} local bytes in ${files.length} files; largest file: ${largestFileBytes} bytes.`,
    );
    // Decimal units are a conservative advisory comparison with the documented
    // MB/TB values. Deployment Products check the actual upload and archive.
    if (artifact.kind === "Function" && totalBytes > 680_000_000) {
      logger.warn(
        `Function Artifact ${artifact.path} exceeds the advisory 680 MB expanded-code comparison. The build continues; the Deployment Product must check the final archive.`,
      );
    }
    if (artifact.kind === "Client" && largestFileBytes > 5_000_000_000_000) {
      logger.warn(
        `Client Artifact ${artifact.path} has a file above the advisory 5 TB Object Storage object-size comparison. The build continues; the Deployment Product must check uploads.`,
      );
    }
  }
  logger.info(
    "Object Storage limits apply per object: 5 TB per object and 5 GB per upload request, not to the Client Artifact total.",
  );
  if (manifest.artifacts.functions.length) {
    logger.info(
      "Cloud Functions limits: 680 MB expanded code and 128 MB ZIP from Object Storage, or 3.5 MB ZIP from the console. Local bytes exclude dependencies installed later. Final archive and ingress checks belong to the Deployment Product. See https://yandex.cloud/en/docs/functions/concepts/limits.",
    );
  }
}
