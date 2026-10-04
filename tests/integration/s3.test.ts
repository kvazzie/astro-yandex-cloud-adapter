import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  paginateListObjectsV2,
  type S3Client,
} from "@aws-sdk/client-s3";
import { build } from "astro";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDeploymentManifest } from "../../packages/adapter/src/deployment-manifest.js";

import { localS3Client, uploadClientArtifact, waitForS3 } from "./helpers/s3.js";

const repository = resolve(import.meta.dirname, "../..");
let client: S3Client;
let root: string;

interface ExpectedObject {
  key: string;
  bytes: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}

async function expectedArtifact(
  application: string,
  prefix: string,
): Promise<ExpectedObject[]> {
  const manifest = parseDeploymentManifest(
    JSON.parse(
      await readFile(join(application, "dist/yandex-cloud.json"), "utf8"),
    ),
  );
  const directory = join(application, "dist", manifest.artifacts.client.path);
  expect(manifest.base).toBe(prefix ? `/${prefix.slice(0, -1)}` : "/");
  const files = [
    "404.html",
    "about/index.html",
    "api/items/a.json",
    "api/items/b.json",
    "blog/a/index.html",
    "blog/b/index.html",
    "feed.xml",
    "index.html",
    "robots.txt",
    "payload.bin",
    ...(await readdir(join(directory, "_astro"))).map((file) => `_astro/${file}`),
  ];
  expect(
    manifest.routes.prerendered.map(({ objectKey }) => objectKey).sort(),
  ).toEqual(
    files
      .filter(
        (file) =>
          !file.startsWith("_astro/") &&
          !["robots.txt", "payload.bin"].includes(file),
      )
      .map((file) => `${prefix}${file}`)
      .sort(),
  );
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".bin": "application/octet-stream",
  };
  for (const extension of [".svg", ".js", ".css"]) {
    expect(
      files.some((file) => file.startsWith("_astro/") && file.endsWith(extension)),
    ).toBe(true);
  }
  return Promise.all(
    files.map(async (file) => {
      const type = types[extname(file)];
      expect(type).toBeDefined();
      return {
        key: `${prefix}${file}`,
        bytes: await readFile(join(directory, file)),
        contentType: type!,
      };
    }),
  );
}

async function expectObjects(
  bucket: string,
  objects: ExpectedObject[],
): Promise<void> {
  for (const { key, bytes, contentType, metadata } of objects) {
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

async function changeApplication(
  application: string,
  revision: number,
): Promise<void> {
  await writeFile(
    join(application, "src/pages/index.astro"),
    `---
import { Image } from "astro:assets";
import logo from "../assets/logo.svg";
---
<!doctype html><title>Upload revision ${revision}</title>
<Image src={logo} alt="Yandex Cloud" /><h1>Upload revision ${revision}</h1>
<script>document.documentElement.dataset.uploadRevision = "${revision}";</script>
<style>h1 { color: ${revision === 1 ? "red" : "blue"}; }</style>
`,
  );
  await writeFile(
    join(application, "public/robots.txt"),
    `User-agent: *\n# revision ${revision}\n`,
  );
  await writeFile(
    join(application, "public/payload.bin"),
    Buffer.from([0, revision, 128, 255]),
  );
}

async function objectKeys(bucket: string, prefix?: string): Promise<string[]> {
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

describe.sequential("Client Artifact uploads to local S3", () => {
  beforeAll(async () => {
    client = localS3Client();
    await waitForS3(client);
    await mkdir(join(repository, ".artifacts"), { recursive: true });
    root = await mkdtemp(join(repository, ".artifacts/s3-"));
  });

  afterAll(async () => {
    client?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["/", "/docs"])(
    "uploads and updates the Client Artifact under %s while preserving unrelated objects",
    async (base) => {
      const application = join(root, randomUUID());
      const bucket = `issue11-${randomUUID()}`;
      await cp(
        join(repository, "tests/fixtures/static/src"),
        join(application, "src"),
        {
          recursive: true,
        },
      );
      await cp(
        join(repository, "tests/fixtures/static/public"),
        join(application, "public"),
        {
          recursive: true,
        },
      );
      await writeFile(
        join(application, "astro.config.mjs"),
        `import yandexCloud from ${JSON.stringify(pathToFileURL(join(repository, "packages/adapter/dist/index.js")).href)};
export default { adapter: yandexCloud(), base: ${JSON.stringify(base)}, trailingSlash: "always", build: { inlineStylesheets: "never" }, vite: { build: { assetsInlineLimit: 0 } } };
`,
      );
      await changeApplication(application, 1);
      await build({ root: `${application}/`, logLevel: "silent" });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      try {
        const prefix = base === "/" ? "" : "docs/";
        const unrelated: ExpectedObject[] = [
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
        const initial = await expectedArtifact(application, prefix);
        await uploadClientArtifact(
          client,
          bucket,
          join(application, "dist/yandex-cloud.json"),
        );
        expect(await objectKeys(bucket)).toEqual(
          [...initial, ...unrelated].map(({ key }) => key).sort(),
        );
        await expectObjects(bucket, [...initial, ...unrelated]);
        expect(await objectKeys(bucket, prefix)).toEqual(
          [...initial, ...unrelated]
            .map(({ key }) => key)
            .filter((key) => key.startsWith(prefix))
            .sort(),
        );

        await changeApplication(application, 2);
        await build({ root: `${application}/`, logLevel: "silent" });
        const updated = await expectedArtifact(application, prefix);
        const changed = updated.filter(
          (object) =>
            !initial.some(
              (old) => old.key === object.key && old.bytes.equals(object.bytes),
            ),
        );
        expect(changed.map(({ key }) => key)).toContain(`${prefix}index.html`);
        expect(changed.map(({ key }) => key)).toContain(`${prefix}robots.txt`);
        expect(changed.some(({ key }) => key.endsWith(".js"))).toBe(true);
        expect(changed.some(({ key }) => key.endsWith(".css"))).toBe(true);
        const retained = initial.filter(
          ({ key }) => !updated.some((object) => object.key === key),
        );
        const expected = [...updated, ...retained, ...unrelated];
        for (let upload = 0; upload < 2; upload++) {
          await uploadClientArtifact(
            client,
            bucket,
            join(application, "dist/yandex-cloud.json"),
          );
          expect(await objectKeys(bucket)).toEqual(
            expected.map(({ key }) => key).sort(),
          );
          await expectObjects(bucket, expected);
        }
      } finally {
        for (const key of await objectKeys(bucket)) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    },
  );
});
