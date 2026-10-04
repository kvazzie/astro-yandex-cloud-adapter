import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

/** Creates a path-style client restricted to a configured HTTP loopback endpoint. */
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

/** Waits for authenticated bucket readiness and includes service logs on timeout. */
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
