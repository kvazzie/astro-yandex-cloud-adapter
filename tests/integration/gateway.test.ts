import { readFile, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { build, type AstroConfig } from "astro";
import { describe, expect, it } from "vitest";
import yandexCloud from "./helpers/built-adapter.js";

import type { DeploymentManifestV1 } from "../../packages/adapter/src/types.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");

interface GatewayTemplate {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  "x-yc-apigateway": {
    ignoreTrailingSlashes: boolean;
    variables: Record<string, { default: string; description: string }>;
  };
}

/** Gives a new fixture the already installed workspace dependencies. */
async function fixtureRoot(fixture: string): Promise<string> {
  const root = join(fixtures, fixture);
  await symlink(
    join(fixtures, "static/node_modules"),
    join(root, "node_modules"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return root;
}

/** Builds the public adapter fixture and reads its deployable Gateway artifact. */
async function gatewayBuild(
  fixture: string,
  trailingSlash?: AstroConfig["trailingSlash"],
): Promise<{
  manifest: DeploymentManifestV1;
  template: GatewayTemplate;
}> {
  const root = await fixtureRoot(fixture);
  await build({ root: `${root}/`, logLevel: "silent", trailingSlash });
  const manifest = JSON.parse(
    await readFile(join(root, "dist/yandex-cloud.json"), "utf8"),
  ) as DeploymentManifestV1;
  expect(manifest.gatewayTemplate).toEqual({ path: "yandex-api-gateway.json" });
  const template = JSON.parse(
    await readFile(join(root, "dist/yandex-api-gateway.json"), "utf8"),
  ) as GatewayTemplate;
  return { manifest, template };
}

describe.sequential("API Gateway artifacts", () => {
  it("maps static page URLs to concrete objects without taking over public asset delivery", async () => {
    const { manifest, template } = await gatewayBuild("gateway-static");
    expect(manifest).toMatchObject({
      modifiers: { apiGateway: true },
      assetsPrefix: "https://assets.example",
      artifacts: { functions: [] },
    });
    expect(template.openapi).toBe("3.0.0");
    expect(template["x-yc-apigateway"].ignoreTrailingSlashes).toBe(false);
    expect(template.paths["/docs/about/"]).toMatchObject({
      get: {
        "x-yc-apigateway-integration": {
          type: "object_storage",
          bucket: "${var.bucket}",
          object: "docs/about/index.html",
          service_account_id: "${var.storage_service_account_id}",
        },
      },
    });
    expect(template.paths).not.toHaveProperty("/docs/about");
    expect(template.paths).not.toHaveProperty("/docs/robots.txt");
    expect(Object.values(template["x-yc-apigateway"].variables)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ default: "REPLACE_ME_INVALID_BUCKET" }),
      ]),
    );
    expect(JSON.stringify(template)).not.toContain("cloud_functions");
  });

  it("routes dynamic, rest, and integration-injected requests through the declared Function Artifact", async () => {
    const { manifest, template } = await gatewayBuild("gateway-mixed");
    expect(manifest.routes.onDemand.map(({ pattern }) => pattern)).toEqual(
      expect.arrayContaining([
        "/docs/posts/[slug]",
        "/docs/archive/[...path]",
        "/docs/injected/[name]",
      ]),
    );
    for (const path of [
      "/docs/posts/{slug}",
      "/docs/posts/{slug}/",
      "/docs/archive/{path+}",
      "/docs/archive",
      "/docs/injected/{name}",
    ]) {
      expect(template.paths[path], path).toMatchObject({
        "x-yc-apigateway-any-method": {
          "x-yc-apigateway-integration": {
            type: "cloud_functions",
            payload_format_version: "0.1",
          },
        },
      });
    }
    const integration = (
      template.paths["/docs/posts/{slug}"]!["x-yc-apigateway-any-method"] as {
        "x-yc-apigateway-integration": { function_id: string };
      }
    )["x-yc-apigateway-integration"];
    const functionVariable = integration.function_id.slice(6, -1);
    const variable = template["x-yc-apigateway"].variables[functionVariable]!;
    expect(variable.default).toBe("REPLACE_ME_INVALID_FUNCTION_ID");
    expect(variable.description).toContain(manifest.artifacts.functions[0]!.id);
  });

  it("keeps strict slashless page URLs canonical under a non-root base", async () => {
    const { manifest, template } = await gatewayBuild("gateway-static", "never");
    expect(manifest.routes.prerendered.map(({ url }) => url)).toEqual([
      "/docs",
      "/docs/about",
    ]);
    expect(Object.keys(template.paths).sort()).toEqual(["/docs", "/docs/about"]);
    expect(template["x-yc-apigateway"].ignoreTrailingSlashes).toBe(false);
  });

  it("keeps a Static-only Build on the Function Target free of Function integrations and variables", async () => {
    const { manifest, template } = await gatewayBuild("gateway-static-functions");
    expect(manifest.artifacts.functions).toEqual([]);
    expect(JSON.stringify(template)).not.toContain("cloud_functions");
    expect(Object.keys(template["x-yc-apigateway"].variables)).toEqual([
      "bucket",
      "storage_service_account_id",
    ]);
  });

  it("includes required Actions and server islands while excluding unused image routes", async () => {
    const { manifest, template } = await gatewayBuild("gateway-internal");
    expect(manifest.routes.onDemand.map(({ pattern }) => pattern)).toEqual(
      expect.arrayContaining([
        "/docs/_actions/[...path]",
        "/docs/_server-islands/[name]",
      ]),
    );
    expect(template.paths).toHaveProperty("/docs/_actions/{path+}");
    expect(template.paths).toHaveProperty("/docs/_server-islands/{name}");
    expect(template.paths).not.toHaveProperty("/docs/_image");
  });

  it("fails compound dynamic segments rather than routing a broader URL shape", async () => {
    const root = await fixtureRoot("gateway-rejected-compound");
    await expect(
      build({ root: `${root}/`, logLevel: "silent" }),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(
        /cannot faithfully represent.*compound|API Gateway.*compound/s,
      ),
    );
  });

  it("fails when Yandex precedence would select another Function than Astro", async () => {
    const root = await fixtureRoot("gateway-rejected-priority");
    await expect(
      build({ root: `${root}/`, logLevel: "silent" }),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/cannot preserve Astro route priority/),
    );
  });

  it("rejects a generated specification above Yandex's 3.5 MB limit", async () => {
    const root = await fixtureRoot("gateway-limit");
    await expect(
      build({ root: `${root}/`, logLevel: "silent" }),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/3\.5 MB limit/),
    );
  });

  it("emits concrete recursive 404 scopes without rewriting a matched endpoint response", async () => {
    const { manifest, template } = await gatewayBuild("gateway-404");
    expect(manifest.routes.notFound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "/docs", objectKey: "docs/404.html" }),
        expect.objectContaining({
          scope: "/docs/blog/a",
          objectKey: "docs/blog/a/404/index.html",
        }),
      ]),
    );
    expect(template.paths["/docs/blog/a/{_+}"]).toMatchObject({
      "x-yc-apigateway-any-method": {
        responses: { "200": { "x-yc-status-mapping": 404 } },
        "x-yc-apigateway-integration": {
          type: "object_storage",
          object: "docs/blog/a/404/index.html",
        },
      },
    });
    expect(template.paths).toHaveProperty("/docs/blog/{id}");
    expect(template.paths).not.toHaveProperty("/docs/blog/a");
    expect(template.paths).not.toHaveProperty("/docs/blog/a/");
    const nested404 = Object.entries(template.paths).find(([path]) =>
      /\/blog\/a\/404\/?$/.test(path),
    );
    expect(nested404?.[1]).toMatchObject({
      get: { responses: { "200": { "x-yc-status-mapping": 404 } } },
    });
    const endpoint = Object.entries(template.paths).find(([path]) =>
      /\/api\/\{[^{}]+\+\}$/.test(path),
    );
    expect(endpoint?.[1]).toMatchObject({
      "x-yc-apigateway-any-method": {
        responses: {
          default: {
            description: "Astro handles method selection and the response.",
          },
        },
        "x-yc-apigateway-integration": { type: "cloud_functions" },
      },
    });
    expect(JSON.stringify(endpoint?.[1])).not.toContain("x-yc-status-mapping");
  });

  it("routes static-only root and nested Markdown 404 scopes to their own Object Storage pages", async () => {
    const { manifest, template } = await gatewayBuild("gateway-404-static");
    expect(manifest.artifacts.functions).toEqual([]);
    expect(manifest.routes.notFound).toEqual([
      {
        scope: "/docs",
        url: "/docs/404",
        objectKey: "docs/404.html",
        artifactId: "client:primary",
      },
      {
        scope: "/docs/help",
        url: "/docs/help/404",
        objectKey: "docs/help/404/index.html",
        artifactId: "client:primary",
      },
    ]);
    expect(template.paths["/docs/{_+}"]).toMatchObject({
      "x-yc-apigateway-any-method": {
        responses: { "200": { "x-yc-status-mapping": 404 } },
        "x-yc-apigateway-integration": {
          type: "object_storage",
          object: "docs/404.html",
        },
      },
    });
    expect(template.paths["/docs/help/{_+}"]).toMatchObject({
      "x-yc-apigateway-any-method": {
        responses: { "200": { "x-yc-status-mapping": 404 } },
        "x-yc-apigateway-integration": {
          type: "object_storage",
          object: "docs/help/404/index.html",
        },
      },
    });
    for (const path of ["/docs/help/404", "/docs/help/404/"])
      expect(template.paths[path]).toMatchObject({
        get: { responses: { "200": { "x-yc-status-mapping": 404 } } },
      });
    expect(template.paths).not.toHaveProperty("/docs/robots.txt");
    expect(JSON.stringify(template)).not.toContain("cloud_functions");
  });

  it("keeps the normal service fallback when recursive 404 has no custom page", async () => {
    const { manifest, template } = await gatewayBuild("gateway-404-no-custom");
    expect(manifest.routes.notFound).toEqual([]);
    expect(template.paths).not.toHaveProperty("/{_+}");
    expect(Object.keys(template.paths)).toEqual(["/"]);
    const clientFiles = await readdir(
      join(fixtures, "gateway-404-no-custom/dist/client"),
      { recursive: true },
    );
    expect(clientFiles).not.toContain("404.html");
  });

  it("keeps the root custom 404 status without enabling nested scopes", async () => {
    const root = await fixtureRoot("gateway-404-static");
    await build({
      root: `${root}/`,
      logLevel: "silent",
      adapter: yandexCloud({ apiGateway: true }),
    });
    const manifest = JSON.parse(
      await readFile(join(root, "dist/yandex-cloud.json"), "utf8"),
    ) as DeploymentManifestV1;
    expect(manifest.routes.notFound.map(({ scope }) => scope)).toEqual(["/docs"]);
    const template = JSON.parse(
      await readFile(join(root, "dist/yandex-api-gateway.json"), "utf8"),
    ) as GatewayTemplate;
    expect(template.paths["/docs/404"]).toMatchObject({
      get: { responses: { "200": { "x-yc-status-mapping": 404 } } },
    });
    expect(template.paths).not.toHaveProperty("/docs/help/{_+}");
  });

  it("rejects an on-demand custom 404 with prerender guidance", async () => {
    const root = await fixtureRoot("gateway-404-static");
    await expect(
      build({
        root: `${root}/`,
        output: "server",
        logLevel: "silent",
        adapter: yandexCloud({
          target: "object-storage-functions",
          apiGateway: true,
          recursive404: true,
        }),
      }),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/404.*must be prerendered.*prerender = true/),
    );
  });
});
