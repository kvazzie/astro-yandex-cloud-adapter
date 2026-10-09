import { cp, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "astro";
import { describe, expect, it } from "vitest";
import type { YandexCloudManifestV1, YandexCloudInvocationContext } from "../../packages/adapter/src/types.js";
import type { YandexCloudHttpResult, YandexCloudHttpEvent } from "../../packages/adapter/src/runtime.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const context: YandexCloudInvocationContext = {
  functionFolderId: "folder", functionName: "function", functionVersion: "version", memoryLimitInMB: "128", requestId: "404-test",
  getPayload: () => undefined, getRemainingTimeInMillis: () => 30_000,
};

/** Invokes a Gateway 0.1 event against the artifact a user deploys. */
function event(url: string): YandexCloudHttpEvent {
  return { url, httpMethod: "GET", headers: { host: "example.test" }, body: "", isBase64Encoded: false };
}

describe.sequential("recursive static 404 artifacts", () => {
  it("uses concrete dynamic scopes and copies custom pages to every page Function", async () => {
    const root = join(fixtures, "recursive-404");
    await symlink(join(fixtures, "static/node_modules"), join(root, "node_modules")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await build({ root: `${root}/`, logLevel: "silent" });
    const manifest = JSON.parse(await readFile(join(root, "dist/yandex-cloud.json"), "utf8")) as YandexCloudManifestV1;
    expect(manifest.routes.notFound.map(scope => scope.scope)).toEqual(["/docs", "/docs/blog/a", "/docs/blog/b"]);
    const pageIds = manifest.routes.onDemand.filter(route => route.kind === "page").map(route => route.artifactId);
    expect(pageIds).toHaveLength(2);
    for (const scope of manifest.routes.notFound) expect(scope.functionArtifactIds).toEqual(expect.arrayContaining(pageIds));
    for (const id of pageIds) {
      const artifact = manifest.artifacts.functions.find(item => item.id === id)!;
      const isolated = await mkdtemp(join(tmpdir(), "yandex-404-"));
      await cp(join(root, "dist", artifact.path), isolated, { recursive: true });
      const generated = await import(pathToFileURL(join(isolated, "index.js")).href) as { handler(event: YandexCloudHttpEvent, context: YandexCloudInvocationContext): Promise<YandexCloudHttpResult> };
      expect(await generated.handler(event("/docs/blog/a/missing"), context)).toMatchObject({ statusCode: 404, body: expect.stringContaining("Missing blog a") });
      expect(await generated.handler(event("/docs/api/unknown"), context)).toMatchObject({ statusCode: 404, body: expect.stringContaining("Root missing page") });
      expect(await generated.handler(event("/docs/blog/b/404"), context)).toMatchObject({ statusCode: 404, body: expect.stringContaining("Missing blog b") });
    }
    const endpoint = manifest.routes.onDemand.find(route => route.pattern === "/docs/api/own")!;
    const artifact = manifest.artifacts.functions.find(item => item.id === endpoint.artifactId)!;
    const generated = await import(pathToFileURL(join(root, "dist", artifact.path, "index.js")).href) as { handler(event: YandexCloudHttpEvent, context: YandexCloudInvocationContext): Promise<YandexCloudHttpResult> };
    expect(await generated.handler(event("/docs/api/own"), context)).toMatchObject({ statusCode: 404, body: "Endpoint owns this 404" });
  });
});
