import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import yandexCloud from "../../packages/adapter/dist/index.js";
import { build, preview } from "astro";
import { afterAll, describe, expect, it } from "vitest";

import type {
  YandexCloudHttpEvent,
  YandexCloudInvocationContext,
  YandexCloudManifestV1,
} from "../../packages/adapter/src/types.js";
import type { YandexCloudHttpResult } from "../../packages/adapter/src/runtime.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const runCommand = promisify(execFile);
const temporaryDirectories = new Set<string>();
const context: YandexCloudInvocationContext = {
  functionFolderId: "partition-folder",
  functionName: "partition-function",
  functionVersion: "partition-version",
  memoryLimitInMB: "128",
  requestId: "partition-request",
  getPayload: () => undefined,
  getRemainingTimeInMillis: () => 30_000,
};

/** Supplies a Gateway 0.1 invocation for a generated, isolated handler. */
function gatewayEvent(path: string): YandexCloudHttpEvent {
  return {
    httpMethod: "GET",
    url: path,
    path,
    pathParams: {},
    params: {},
    multiValueParams: {},
    headers: { host: "partition.example" },
    multiValueHeaders: {},
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    requestContext: {
      identity: { sourceIp: "192.0.2.1", userAgent: "vitest" },
      httpMethod: "GET",
      requestId: "partition-request",
      requestTime: "09/Oct/2026:12:00:00 +0000",
      requestTimeEpoch: 1_790_000_000,
    },
    body: "",
    isBase64Encoded: false,
  };
}

/** Reads the portable output consumed by a standalone Deployment Product. */
async function manifest(fixture: string): Promise<YandexCloudManifestV1> {
  return JSON.parse(
    await readFile(join(fixtures, fixture, "dist/yandex-cloud.json"), "utf8"),
  ) as YandexCloudManifestV1;
}

/** Imports an Artifact copied away from the application and workspace. */
async function isolatedHandler(fixture: string, artifactPath: string) {
  const isolated = await mkdtemp(join(tmpdir(), "yandex-partition-handler-"));
  temporaryDirectories.add(isolated);
  await cp(join(fixtures, fixture, "dist", artifactPath), isolated, {
    recursive: true,
  });
  const module = (await import(
    pathToFileURL(join(isolated, "index.js")).href
  )) as {
    handler(
      event: YandexCloudHttpEvent,
      context: YandexCloudInvocationContext,
    ): Promise<YandexCloudHttpResult>;
  };
  return { module, isolated };
}

/** Builds public adapter configuration with a unique output for each comparison. */
async function partitionBuild(
  fixture: string,
  options: {
    functions: "shared" | "separate";
    apiGateway: boolean;
    dependencyStrategy?: "bundle" | "install";
    base?: string;
  },
) {
  const root = join(fixtures, fixture);
  await symlink(
    join(
      fixtures,
      fixture === "partition-install"
        ? "install-basic/node_modules"
        : "static/node_modules",
    ),
    join(root, "node_modules"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const output = await mkdtemp(join(tmpdir(), "yandex-partition-build-"));
  temporaryDirectories.add(output);
  const { base, ...adapterOptions } = options;
  await build({
    root: `${root}/`,
    outDir: `${output}/`,
    logLevel: "silent",
    ...(base ? { base } : {}),
    adapter: yandexCloud({
      target: "object-storage-functions",
      ...adapterOptions,
    }),
  });
  const manifest = JSON.parse(
    await readFile(join(output, "yandex-cloud.json"), "utf8"),
  ) as YandexCloudManifestV1;
  return { root, output, manifest };
}

/** Opens only the Function identified by the Manifest, outside the build tree. */
async function routeHandler(
  output: string,
  manifest: YandexCloudManifestV1,
  pattern: string,
  install = false,
) {
  const route = manifest.routes.onDemand.find(
    (route) => route.pattern === pattern,
  );
  expect(route, pattern).toBeDefined();
  const artifact = manifest.artifacts.functions.find(
    (artifact) => artifact.id === route?.artifactId,
  )!;
  const isolated = await mkdtemp(join(tmpdir(), "yandex-partition-route-"));
  temporaryDirectories.add(isolated);
  await cp(join(output, artifact.path), isolated, { recursive: true });
  if (install)
    await runCommand(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: isolated },
    );
  return {
    isolated,
    module: (await import(pathToFileURL(join(isolated, "index.js")).href)) as {
      handler(
        event: YandexCloudHttpEvent,
        context: YandexCloudInvocationContext,
      ): Promise<YandexCloudHttpResult>;
    },
  };
}

describe.sequential("Function Artifact partitioning", () => {
  afterAll(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });
  it("emits independently deployable route Functions with distinct runtime code", async () => {
    const root = join(fixtures, "partition-basic");
    await rm(join(root, "dist"), { recursive: true, force: true });
    await build({ root, logLevel: "silent" });
    const output = await manifest("partition-basic");
    expect(output.artifacts.functions).toHaveLength(2);
    const fixed = output.routes.onDemand.find(
      (route) => route.pattern === "/api/fixed",
    );
    const rest = output.routes.onDemand.find(
      (route) => route.pattern === "/api/[...path]",
    );
    expect(fixed?.artifactId).not.toBe(rest?.artifactId);
    const fixedArtifact = output.artifacts.functions.find(
      (artifact) => artifact.id === fixed?.artifactId,
    )!;
    const restArtifact = output.artifacts.functions.find(
      (artifact) => artifact.id === rest?.artifactId,
    )!;
    const fixedHandler = await isolatedHandler(
      "partition-basic",
      fixedArtifact.path,
    );
    const restHandler = await isolatedHandler(
      "partition-basic",
      restArtifact.path,
    );
    expect(
      await fixedHandler.module.handler(gatewayEvent("/api/fixed"), context),
    ).toMatchObject({ statusCode: 200, body: "fixed-route-only-marker" });
    expect(
      await restHandler.module.handler(gatewayEvent("/api/a/b"), context),
    ).toMatchObject({ statusCode: 200, body: "rest-route-only-marker:a/b:" });
    expect(
      await restHandler.module.handler(gatewayEvent("/api/fixed"), context),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await fixedHandler.module.handler(gatewayEvent("/api/a/b"), context),
    ).toMatchObject({ statusCode: 404 });
    const source = (
      await Promise.all(
        (await readdir(fixedHandler.isolated, { recursive: true }))
          .filter((file) => /\.m?js$/.test(file))
          .map((file) => readFile(join(fixedHandler.isolated, file), "utf8")),
      )
    ).join("\n");
    expect(source).not.toContain("rest-route-only-marker");
  });
  it("keeps Astro preview working for separate direct Functions under a non-root base", async () => {
    const { root, output, manifest } = await partitionBuild("partition-basic", {
      functions: "separate",
      apiGateway: false,
      base: "/docs",
    });
    expect(manifest.artifacts.functions).toHaveLength(2);
    expect(
      manifest.artifacts.functions.every(
        (artifact) => artifact.path !== "function",
      ),
    ).toBe(true);
    const dispatcher = await readFile(join(output, "function/index.js"), "utf8");
    expect(dispatcher).not.toContain(output);
    expect(dispatcher).toContain("../functions/");
    const server = await preview({
      root: `${root}/`,
      outDir: `${output}/`,
      base: "/docs",
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const fixed = await fetch(`${origin}/docs/api/fixed`);
      expect(fixed.status).toBe(200);
      expect(await fixed.text()).toBe("fixed-route-only-marker");
      const rest = await fetch(`${origin}/docs/api/a/b?value=one&value=two`);
      expect(rest.status).toBe(200);
      expect(await rest.text()).toBe(
        "rest-route-only-marker:a/b:?value=one&value=two",
      );
      expect((await fetch(`${origin}/outside`)).status).toBe(404);
    } finally {
      await server.stop();
      await server.closed();
    }
  });

  it("preserves Gateway dynamic, rest, and injected responses while assigning deterministic resources", async () => {
    const shared = await partitionBuild("partition-mixed", {
      functions: "shared",
      apiGateway: true,
    });
    const separate = await partitionBuild("partition-mixed", {
      functions: "separate",
      apiGateway: true,
    });
    const repeated = await partitionBuild("partition-mixed", {
      functions: "separate",
      apiGateway: true,
    });
    expect(separate.manifest.artifacts.functions).toEqual(
      repeated.manifest.artifacts.functions,
    );
    expect(separate.manifest.routes.onDemand).toEqual(
      repeated.manifest.routes.onDemand,
    );
    expect(separate.manifest.artifacts.functions).toHaveLength(3);
    for (const [pattern, path, expected] of [
      ["/docs/posts/[slug]", "/docs/posts/ada", "<p>ada</p>"],
      ["/docs/archive/[...path]", "/docs/archive/a/b", "a/b"],
      ["/docs/injected/[name]", "/docs/injected/Ada", "Ada"],
    ]) {
      const sharedHandler = await routeHandler(
        shared.output,
        shared.manifest,
        pattern!,
      );
      const separateHandler = await routeHandler(
        separate.output,
        separate.manifest,
        pattern!,
      );
      const event = gatewayEvent(path!);
      const before = await sharedHandler.module.handler(event, context);
      const after = await separateHandler.module.handler(event, context);
      expect(after).toMatchObject({ statusCode: 200 });
      expect(after.body).toContain(expected);
      expect(after.body).toBe(before.body);
    }
    const template = JSON.parse(
      await readFile(join(separate.output, "yandex-api-gateway.json"), "utf8"),
    ) as {
      paths: Record<
        string,
        {
          "x-yc-apigateway-any-method": {
            "x-yc-apigateway-integration": { function_id: string };
          };
        }
      >;
      "x-yc-apigateway": {
        variables: Record<string, { default: string; description: string }>;
      };
    };
    const variables = Object.values(template["x-yc-apigateway"].variables).filter(
      (variable) => variable.default === "REPLACE_ME_INVALID_FUNCTION_ID",
    );
    expect(variables).toHaveLength(3);
    const references = [
      "/docs/posts/{slug}",
      "/docs/archive/{path+}",
      "/docs/injected/{name}",
    ].map(
      (path) =>
        template.paths[path]!["x-yc-apigateway-any-method"][
          "x-yc-apigateway-integration"
        ].function_id,
    );
    expect(new Set(references).size).toBe(3);
  });

  it("restores the same direct request target in shared and separate endpoint Functions", async () => {
    for (const functions of ["shared", "separate"] as const) {
      const { output, manifest } = await partitionBuild("partition-basic", {
        functions,
        apiGateway: false,
        base: "/docs",
      });
      expect(manifest.directInvocation).toBeDefined();
      const handler = await routeHandler(output, manifest, "/docs/api/[...path]");
      const parameter = manifest.directInvocation!.requestTargetParameter;
      const response = await handler.module.handler(
        {
          ...gatewayEvent("/provider-function-id"),
          queryStringParameters: {
            [parameter]: "/docs/api/a/b?value=one&value=two",
          },
        },
        context,
      );
      expect(response).toMatchObject({
        statusCode: 200,
        body: "rest-route-only-marker:a/b:?value=one&value=two",
      });
      expect(response.body).not.toContain(parameter);
    }
  });

  it("keeps Actions and deferred server islands executable in separate Gateway Functions", async () => {
    const { output, manifest } = await partitionBuild("partition-internal", {
      functions: "separate",
      apiGateway: true,
    });
    const action = await routeHandler(
      output,
      manifest,
      "/docs/_actions/[...path]",
    );
    const response = await action.module.handler(
      {
        ...gatewayEvent("/docs/_actions/greet"),
        httpMethod: "POST",
        headers: {
          host: "partition.example",
          origin: "https://partition.example",
          "content-type": "application/json",
        },
        body: "{}",
      },
      context,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Hello");
    const actionSources = (
      await Promise.all(
        (await readdir(action.isolated, { recursive: true }))
          .filter((file) => /\.m?js$/.test(file))
          .map((file) => readFile(join(action.isolated, file), "utf8")),
      )
    ).join("\n");
    expect(actionSources.includes("server-island-only-marker")).toBe(false);
    const page = await readFile(join(output, "client/index.html"), "utf8");
    const islandPath =
      page
        .match(/<link rel="preload" as="fetch" href="([^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&") ?? page.match(/fetch\("([^"]+)"/)?.[1];
    expect(islandPath).toBeDefined();
    const url = new URL(islandPath!, "https://partition.example");
    const island = await routeHandler(
      output,
      manifest,
      "/docs/_server-islands/[name]",
    );
    const fragment = await island.module.handler(
      {
        ...gatewayEvent(url.pathname),
        queryStringParameters: Object.fromEntries(url.searchParams),
      },
      context,
    );
    expect(fragment.statusCode).toBe(200);
    expect(fragment.body).toContain("Hello, Ada.");
    expect(fragment.body).toContain("server-island-only-marker");
  });

  it("pins and installs only the runtime dependencies needed by a separate Function", async () => {
    const { output, manifest } = await partitionBuild("partition-install", {
      functions: "separate",
      apiGateway: true,
      dependencyStrategy: "install",
    });
    const endpoint = await routeHandler(output, manifest, "/api/id", true);
    const packageJson = JSON.parse(
      await readFile(join(endpoint.isolated, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies.nanoid).toMatch(/^3\.3\.\d+$/);
    const response = await endpoint.module.handler(
      gatewayEvent("/api/id"),
      context,
    );
    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body) as {
      id: string;
      alphabetLength: number;
    };
    expect(result.id).toMatch(/^[a-zA-Z0-9_-]{21}$/);
    expect(result.alphabetLength).toBe(64);
    const page = await routeHandler(output, manifest, "/");
    const pagePackage = JSON.parse(
      await readFile(join(page.isolated, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pagePackage.dependencies).not.toHaveProperty("nanoid");
    expect((await page.module.handler(gatewayEvent("/"), context)).body).toContain(
      "<h1>Install basic</h1>",
    );
  });
  it("discovers and serves an island used only by an on-demand page", async () => {
    const { output, manifest } = await partitionBuild("partition-server-island", {
      functions: "separate",
      apiGateway: true,
    });
    expect(manifest.routes.prerendered).toEqual([]);
    const page = await routeHandler(output, manifest, "/docs/");
    const response = await page.module.handler(gatewayEvent("/docs/"), context);
    expect(response.statusCode).toBe(200);
    const islandPath = response.body.match(/fetch\("([^"]+)"/)?.[1];
    expect(islandPath).toBeDefined();
    const url = new URL(islandPath!, "https://partition.example");
    const island = await routeHandler(
      output,
      manifest,
      "/docs/_server-islands/[name]",
    );
    const fragment = await island.module.handler(
      {
        ...gatewayEvent(url.pathname),
        queryStringParameters: Object.fromEntries(url.searchParams),
      },
      context,
    );
    expect(fragment.statusCode).toBe(200);
    expect(fragment.body).toContain("Hello, Ada.");
    expect(fragment.body).toContain("server-island-only-marker");
  });
  it("emits no Function directories for a Static-only Build configured for separate Functions", async () => {
    const { output, manifest } = await partitionBuild("static-functions", {
      functions: "separate",
      apiGateway: true,
    });
    expect(manifest.artifacts.functions).toEqual([]);
    expect(manifest.routes.onDemand).toEqual([]);
    expect(await readdir(output)).not.toContain("functions");
    await expect(
      readFile(join(output, "function/index.js")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });
});
