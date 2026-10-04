import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { build } from "astro";
import { contentType, lookup } from "mime-types";

import { parseDeploymentManifest } from "../../../packages/adapter/src/deployment-manifest.js";

import { readDirectorySnapshot } from "../lib/files.js";

/** Uploads the manifest's Client Artifact without deleting any existing objects. */
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
  for (const { path, bytes } of await readArtifactFiles(directory)) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: declaredKeys.get(path) ?? `${prefix}${path}`,
        Body: bytes,
        ContentType:
          contentType(lookup(path) || "application/octet-stream") ||
          "application/octet-stream",
      }),
    );
  }
}

/** Builds a changed fixture and returns generated inputs for independent assertions. */
export async function buildClientArtifact(application: string, revision: number) {
  await writeRevision(application, revision);
  await build({ root: `${application}/`, logLevel: "silent" });
  const manifestPath = join(application, "dist/yandex-cloud.json");
  const manifest = parseDeploymentManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const files = await readDirectorySnapshot(
    join(dirname(manifestPath), manifest.artifacts.client.path),
  );
  return { manifest, manifestPath, files };
}

/** Copies the static fixture into a test-owned application with the requested base. */
export async function createClientApplication(
  application: string,
  base: string,
): Promise<void> {
  const repository = resolve(import.meta.dirname, "../../..");
  for (const directory of ["src", "public"]) {
    await cp(
      join(repository, "tests/fixtures/static", directory),
      join(application, directory),
      { recursive: true },
    );
  }
  await writeFile(
    join(application, "astro.config.mjs"),
    `import yandexCloud from ${JSON.stringify(pathToFileURL(join(repository, "packages/adapter/dist/index.js")).href)};
export default {
  adapter: yandexCloud(),
  base: ${JSON.stringify(base)},
  trailingSlash: "always",
  build: { inlineStylesheets: "never" },
  vite: { build: { assetsInlineLimit: 0 } },
};
`,
  );
}

async function readArtifactFiles(
  directory: string,
  prefix = "",
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await readArtifactFiles(file, `${path}/`)));
    else if (entry.isFile()) files.push({ path, bytes: await readFile(file) });
  }
  return files;
}

async function writeRevision(
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
