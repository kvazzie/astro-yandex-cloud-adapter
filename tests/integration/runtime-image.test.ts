import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
  return {
    async handler(
      event: YandexCloudHttpEvent,
      context: YandexCloudInvocationContext,
    ): Promise<YandexCloudHttpResult> {
      // Astro caches image services globally. A deployed Function starts outside
      // the build process and outside every other independently installed Function.
      const { stdout, stderr } = await runCommand(process.execPath, [
        "--input-type=module",
        "--eval",
        `import { pathToFileURL } from "node:url";
const { handler } = await import(pathToFileURL(process.argv[1]).href);
const context = { ...JSON.parse(process.argv[3]), getPayload: () => undefined, getRemainingTimeInMillis: () => 30_000 };
process.stdout.write(JSON.stringify(await handler(JSON.parse(process.argv[2]), context)));`,
        join(isolated, "index.js"),
        JSON.stringify(event),
        JSON.stringify(context),
      ]);
      const result = JSON.parse(stdout) as YandexCloudHttpResult;
      expect(result.statusCode, stderr || result.body).not.toBe(500);
      return result;
    },
  };
}

it.each(["/_image", "/optimized"])(
  "declares and executes %s needed only by an on-demand page",
  async (imageEndpoint) => {
    const temporary: string[] = [];
    const sourceImage = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: "red",
      },
    })
      .png()
      .toBuffer();
    const source = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" }).end(sourceImage);
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    try {
      const address = source.address();
      if (!address || typeof address === "string")
        throw new Error("Image server has no TCP port.");
      const root = join(fixtures, "runtime-image");
      const output = await mkdtemp(join(tmpdir(), "yandex-runtime-image-build-"));
      temporary.push(output);
      // Build outside Vitest's import.meta.env transform so image service URLs use
      // the application's Vite base rather than the test runner's base.
      await runCommand(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import { build } from "astro"; await build(JSON.parse(process.argv[1]));',
          JSON.stringify({
            root: `${root}/`,
            outDir: `${output}/`,
            logLevel: "error",
            image: { endpoint: { route: imageEndpoint } },
          }),
        ],
        { env: { ...process.env, BASE_URL: undefined } },
      );
      const manifest = JSON.parse(
        await readFile(join(output, "yandex-cloud.json"), "utf8"),
      ) as YandexCloudManifestV1;
      expect(manifest.routes.prerendered).toEqual([]);
      expect(manifest.routes.onDemand).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pattern: `/docs${imageEndpoint}`,
            kind: "endpoint",
          }),
        ]),
      );
      const gateway = JSON.parse(
        await readFile(join(output, "yandex-api-gateway.json"), "utf8"),
      ) as { paths: Record<string, unknown> };
      expect(gateway.paths).toHaveProperty(`/docs${imageEndpoint}`);
      const page = await handler(output, manifest, "/docs/", temporary);
      const pageUrl = new URL(
        `https://images.example/docs/?src=${encodeURIComponent(`http://127.0.0.1:${address.port}/image.png`)}`,
      );
      const rendered = await page.handler(event(pageUrl), context);
      expect(rendered.statusCode).toBe(200);
      const imagePath = rendered.body
        .match(/<img[^>]+src="([^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&");
      expect(new URL(imagePath!, "https://images.example").pathname).toBe(
        `/docs${imageEndpoint}`,
      );
      const image = await handler(
        output,
        manifest,
        `/docs${imageEndpoint}`,
        temporary,
      );
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
  },
);
