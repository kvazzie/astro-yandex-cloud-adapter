import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import {
  CreateBucketCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClientArtifact,
  createClientApplication,
  uploadClientArtifact,
} from "./helpers/client-artifact.js";
import { localS3Client, waitForS3 } from "./helpers/local-s3.js";
import {
  deleteTestBucket,
  expectS3Objects,
  listObjectKeys,
  type ExpectedS3Object,
} from "./lib/s3.js";

describe.sequential("Client Artifact uploads to local S3", () => {
  let client: S3Client;
  let root: string;

  beforeAll(async () => {
    client = localS3Client();
    await waitForS3(client);
    const artifacts = resolve(import.meta.dirname, "../../.artifacts");
    await mkdir(artifacts, { recursive: true });
    root = await mkdtemp(join(artifacts, "s3-"));
  });

  afterAll(async () => {
    client?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    { base: "/", prefix: "" },
    { base: "/docs", prefix: "docs/" },
  ])(
    "uploads and updates the Client Artifact under $base while preserving unrelated objects",
    async ({ base, prefix }) => {
      const pages = [
        "404.html",
        "about/index.html",
        "api/items/a.json",
        "api/items/b.json",
        "blog/a/index.html",
        "blog/b/index.html",
        "feed.xml",
        "index.html",
      ];
      const publicFiles = ["robots.txt", "payload.bin"];
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".xml": "application/xml",
        ".svg": "image/svg+xml",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".bin": "application/octet-stream",
      };
      const unrelated: ExpectedS3Object[] = [
        {
          key: `${prefix}user-owned.txt`,
          bytes: Buffer.from("Keep this object.\n"),
          contentType: "text/plain; charset=utf-8",
          metadata: { owner: "another-application" },
        },
        {
          key: "other/application.bin",
          bytes: Buffer.from([255, 0, 128, 1]),
          contentType: "application/octet-stream",
          metadata: { owner: "another-application" },
        },
      ];

      const application = join(root, randomUUID());
      await createClientApplication(application, base);
      const initial = await buildClientArtifact(application, 1);
      const bucket = `issue11-${randomUUID()}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      try {
        for (const object of unrelated) {
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: object.key,
              Body: object.bytes,
              ContentType: object.contentType,
              Metadata: object.metadata,
            }),
          );
        }
        expect(initial.manifest.base).toBe(base);
        expect(
          initial.manifest.routes.prerendered
            .map(({ objectKey }) => objectKey)
            .sort(),
        ).toEqual(pages.map((page) => `${prefix}${page}`).sort());
        const browserAssets = initial.files.filter(({ path }) =>
          path.startsWith("_astro/"),
        );
        expect(initial.files.map(({ path }) => path).sort()).toEqual(
          [
            ...pages,
            ...publicFiles,
            ...browserAssets.map(({ path }) => path),
          ].sort(),
        );
        expect(browserAssets.map(({ path }) => extname(path))).toEqual(
          expect.arrayContaining([".svg", ".js", ".css"]),
        );
        for (const { path } of initial.files)
          expect(mimeTypes[extname(path)]).toBeDefined();
        const initialObjects = initial.files.map(({ path, bytes }) => ({
          key: `${prefix}${path}`,
          bytes,
          contentType: mimeTypes[extname(path)]!,
        }));

        await uploadClientArtifact(client, bucket, initial.manifestPath);
        await expectS3Objects(client, bucket, [...initialObjects, ...unrelated]);
        expect(await listObjectKeys(client, bucket, prefix)).toEqual(
          [...initialObjects, ...unrelated]
            .map(({ key }) => key)
            .filter((key) => key.startsWith(prefix))
            .sort(),
        );

        const updated = await buildClientArtifact(application, 2);
        expect(updated.manifest.base).toBe(base);
        expect(
          updated.manifest.routes.prerendered
            .map(({ objectKey }) => objectKey)
            .sort(),
        ).toEqual(pages.map((page) => `${prefix}${page}`).sort());
        for (const { path } of updated.files)
          expect(mimeTypes[extname(path)]).toBeDefined();
        const updatedObjects = updated.files.map(({ path, bytes }) => ({
          key: `${prefix}${path}`,
          bytes,
          contentType: mimeTypes[extname(path)]!,
        }));
        const changed = updatedObjects.filter(
          (object) =>
            !initialObjects.some(
              (old) => old.key === object.key && old.bytes.equals(object.bytes),
            ),
        );
        expect(changed.map(({ key }) => key)).toContain(`${prefix}index.html`);
        expect(changed.map(({ key }) => key)).toContain(`${prefix}robots.txt`);
        expect(changed.some(({ key }) => key.endsWith(".js"))).toBe(true);
        expect(changed.some(({ key }) => key.endsWith(".css"))).toBe(true);
        const retained = initialObjects.filter(
          ({ key }) => !updatedObjects.some((object) => object.key === key),
        );
        const expected = [...updatedObjects, ...retained, ...unrelated];

        await uploadClientArtifact(client, bucket, updated.manifestPath);
        await expectS3Objects(client, bucket, expected);

        await uploadClientArtifact(client, bucket, updated.manifestPath);
        await expectS3Objects(client, bucket, expected);
      } finally {
        await deleteTestBucket(client, bucket);
      }
    },
  );
});
