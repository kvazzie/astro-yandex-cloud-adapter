import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { contentType, lookup } from "mime-types";

import { parseDeploymentManifest } from "../../../packages/adapter/src/deployment-manifest.js";

export function localS3Client(): S3Client {
  const endpoint = process.env.S3_TEST_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "Set S3_TEST_ENDPOINT to a local S3 service, or run devenv test.",
    );
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("S3_TEST_ENDPOINT must be an HTTP loopback endpoint.");
  }
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? "issue11-local",
      secretAccessKey: process.env.S3_TEST_SECRET_KEY ?? "issue11-local-secret",
    },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 1500, requestTimeout: 5000 },
  });
}

export async function waitForS3(client: S3Client): Promise<void> {
  const bucket = process.env.S3_TEST_READY_BUCKET ?? "issue11-ready";
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(1500),
      });
      return;
    } catch (error) {
      lastError = error;
      await setTimeout(250);
    }
  }
  const logs = await readFile(".devenv/s3.log", "utf8").catch(
    () => "No local service log.",
  );
  throw new Error(
    `S3 readiness failed at ${process.env.S3_TEST_ENDPOINT} for ${bucket}: ${String(lastError)}\n${logs}`,
    { cause: lastError },
  );
}

export async function uploadClientArtifact(
  client: S3Client,
  bucket: string,
  manifestPath: string,
): Promise<void> {
  const manifest = parseDeploymentManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const directory = join(dirname(manifestPath), manifest.artifacts.client.path);
  const prefix = manifest.base === "/" ? "" : `${manifest.base.slice(1)}/`;
  const declaredKeys = new Map(
    manifest.routes.prerendered.map(({ objectKey }) => [
      objectKey.slice(prefix.length),
      objectKey,
    ]),
  );

  async function uploadDirectory(
    path: string,
    relativeDirectory = "",
  ): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const relative = `${relativeDirectory}${entry.name}`;
      if (entry.isDirectory()) {
        await uploadDirectory(file, `${relative}/`);
      } else if (entry.isFile()) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: declaredKeys.get(relative) ?? `${prefix}${relative}`,
            Body: await readFile(file),
            ContentType:
              contentType(lookup(relative) || "application/octet-stream") ||
              "application/octet-stream",
          }),
        );
      }
    }
  }
  await uploadDirectory(directory);
}
