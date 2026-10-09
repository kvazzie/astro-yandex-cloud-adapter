import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "astro";
import sharp from "sharp";
import { expect, it } from "vitest";

import type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudManifestV1,
} from "../../packages/adapter/src/types.js";
import type { YandexCloudHttpResult } from "../../packages/adapter/src/runtime.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const runCommand = promisify(execFile);
const context: YandexCloudInvocationContext = {
  functionFolderId: "image-folder",
  functionName: "image-function",
  functionVersion: "image-version",
  memoryLimitInMB: "128",
  requestId: "image-request",
  getPayload: () => undefined,
  getRemainingTimeInMillis: () => 30_000,
};

/** Invokes actual public request URLs through the Gateway event contract. */
function event(url: URL): YandexCloudHttpEvent {
  return {
    httpMethod: "GET",
    url: url.pathname,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: { host: url.host },
  };
}

/** Installs a generated Function outside its application dependency tree. */
async function handler(
  output: string,
  manifest: YandexCloudManifestV1,
  pattern: string,
  temporary: string[],
) {
  const route = manifest.routes.onDemand.find(
    (route) => route.pattern === pattern,
  );
  expect(route, pattern).toBeDefined();
  const artifact = manifest.artifacts.functions.find(
    (artifact) => artifact.id === route!.artifactId,
  )!;
  const isolated = await mkdtemp(join(tmpdir(), "yandex-image-function-"));
  temporary.push(isolated);
  await cp(join(output, artifact.path), isolated, { recursive: true });
  await runCommand("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: isolated,
    env: { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
  });
  return (await import(pathToFileURL(join(isolated, "index.js")).href)) as {
    handler(
      event: YandexCloudHttpEvent,
      context: YandexCloudInvocationContext,
    ): Promise<YandexCloudHttpResult>;
  };
}

it("declares and executes the image endpoint needed only by an on-demand page", async () => {
  const temporary: string[] = [];
  const source = createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "image/svg+xml" })
      .end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
      );
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    const address = source.address();
    if (!address || typeof address === "string")
      throw new Error("Image server has no TCP port.");
    const root = join(fixtures, "runtime-image");
    const output = await mkdtemp(join(tmpdir(), "yandex-runtime-image-build-"));
    temporary.push(output);
    await build({ root: `${root}/`, outDir: `${output}/`, logLevel: "silent" });
    const manifest = JSON.parse(
      await readFile(join(output, "yandex-cloud.json"), "utf8"),
    ) as YandexCloudManifestV1;
    expect(manifest.routes.prerendered).toEqual([]);
    expect(manifest.routes.onDemand).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pattern: "/docs/_image", kind: "endpoint" }),
      ]),
    );
    const page = await handler(output, manifest, "/docs/", temporary);
    const pageUrl = new URL(
      `https://images.example/docs/?src=${encodeURIComponent(`http://127.0.0.1:${address.port}/image.svg`)}`,
    );
    const rendered = await page.handler(event(pageUrl), context);
    expect(rendered.statusCode).toBe(200);
    const imagePath = rendered.body
      .match(/<img[^>]+src="([^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    expect(imagePath).toMatch(/^\/docs\/_image\?/);
    const image = await handler(output, manifest, "/docs/_image", temporary);
    const transformed = await image.handler(
      event(new URL(imagePath!, "https://images.example")),
      context,
    );
    expect(transformed.statusCode).toBe(200);
    expect(transformed.isBase64Encoded).toBe(true);
    expect(transformed.headers["content-type"]).toBe("image/png");
    const metadata = await sharp(
      Buffer.from(transformed.body, "base64"),
    ).metadata();
    expect(metadata).toMatchObject({ width: 8, height: 8, format: "png" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      source.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(
      temporary.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
});
