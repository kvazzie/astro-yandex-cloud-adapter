import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  type S3Client,
} from "@aws-sdk/client-s3";
import { expect } from "vitest";

/**
 * Checks a bucket's complete inventory and every object's bytes and metadata.
 * Callers supply all expected keys, MIME types, and bytes; this matcher has no
 * artifact layout, routing, base-prefix, or content-type policy.
 */
export async function expectS3Objects(
  client: S3Client,
  bucket: string,
  expected: ExpectedS3Object[],
): Promise<void> {
  expect(await listObjectKeys(client, bucket)).toEqual(
    expected.map(({ key }) => key).sort(),
  );
  for (const { key, bytes, contentType, metadata } of expected) {
    const object = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    expect(Buffer.from(await object.Body!.transformToByteArray()), key).toEqual(
      bytes,
    );
    expect(object.ContentType, key).toBe(contentType);
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    expect(head.ContentType, key).toBe(contentType);
    expect(head.ContentLength, key).toBe(bytes.length);
    if (metadata) expect(head.Metadata, key).toEqual(metadata);
  }
}

/** Deletes exact object keys and a bucket that the caller owns exclusively. */
export async function deleteTestBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  for (const key of await listObjectKeys(client, bucket)) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** Lists sorted keys across all pages, optionally restricted to a supplied prefix. */
export async function listObjectKeys(
  client: S3Client,
  bucket: string,
  prefix?: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of paginateListObjectsV2(
    { client, pageSize: 2 },
    { Bucket: bucket, Prefix: prefix },
  )) {
    for (const object of page.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
  }
  return keys.sort();
}

/** Values supplied by a test, without deriving expectations from the S3 response. */
export interface ExpectedS3Object {
  key: string;
  bytes: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}
