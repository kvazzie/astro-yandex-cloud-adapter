import { describe, expect, it } from "vitest";

import { parseDeploymentManifest } from "../../packages/adapter/src/deployment-manifest.js";

interface ManifestInput {
  [key: string]: unknown;
  schemaVersion: number;
  adapter: { [key: string]: unknown; name: string; version: string };
  astro: { [key: string]: unknown; version: string };
  target: string;
  buildOutput: string;
  base: string;
  artifacts: {
    [key: string]: unknown;
    client: {
      [key: string]: unknown;
      path: string;
      files: Array<{
        [key: string]: unknown;
        path: string;
        url: string;
        objectKey: string;
      }>;
    };
    function?: Record<string, unknown>;
  };
  routes: {
    [key: string]: unknown;
    prerendered: Array<{ url: string; objectKey: string }>;
    onDemand: Array<{ pattern: string }>;
  };
}

function staticManifest(): ManifestInput {
  return {
    schemaVersion: 1,
    adapter: {
      name: "@astro-yandex-cloud/adapter",
      version: "0.1.0",
    },
    astro: { version: "7.1.0" },
    target: "object-storage",
    buildOutput: "static",
    base: "/",
    artifacts: {
      client: {
        path: "client",
        files: [{ path: "index.html", url: "/", objectKey: "index.html" }],
      },
    },
    routes: {
      prerendered: [{ url: "/", objectKey: "index.html" }],
      onDemand: [],
    },
  };
}

describe("Deployment Manifest consumers", () => {
  it("accepts a schema version 1 manifest", () => {
    const manifest = staticManifest();

    expect(parseDeploymentManifest(manifest)).toBe(manifest);
  });

  it("accepts additive fields within schema version 1", () => {
    const manifest = staticManifest();
    manifest.futureRequirement = true;
    manifest.adapter.futureVersionFact = "supported";
    manifest.artifacts.client.files[0]!.futureObjectFact = 1;

    expect(parseDeploymentManifest(manifest)).toBe(manifest);
  });

  it("rejects unknown schema versions", () => {
    const manifest = staticManifest();
    manifest.schemaVersion = 2;

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest.*schemaVersion.*equal to constant/i,
    );
  });

  it.each([
    ["unknown Target", (manifest: ManifestInput) => (manifest.target = "vm")],
    ["invalid base", (manifest: ManifestInput) => (manifest.base = "docs/")],
    [
      "absolute artifact path",
      (manifest: ManifestInput) => (manifest.artifacts.client.path = "/client"),
    ],
    [
      "absolute Object Storage key",
      (manifest: ManifestInput) =>
        (manifest.artifacts.client.files[0]!.objectKey = "/index.html"),
    ],
  ])("rejects an %s", (_name, change) => {
    const manifest = staticManifest();
    change(manifest);

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest/,
    );
  });

  it.each([
    [
      "Static-only Build with a Function Artifact",
      (manifest: ManifestInput) => {
        manifest.artifacts.function = {
          path: "function",
          runtime: "nodejs22",
          format: "esm",
          entrypoint: "index.handler",
          support: { sharp: "unsupported" },
        };
      },
    ],
    [
      "Runtime Build without a Function Artifact",
      (manifest: ManifestInput) => {
        manifest.target = "object-storage-functions";
        manifest.buildOutput = "server";
        manifest.routes.onDemand = [{ pattern: "/runtime" }];
      },
    ],
    [
      "Object Storage Target with an On-demand Route",
      (manifest: ManifestInput) => {
        manifest.routes.onDemand = [{ pattern: "/runtime" }];
      },
    ],
  ])("rejects the invalid combination: %s", (_name, change) => {
    const manifest = staticManifest();
    change(manifest);

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest/,
    );
  });

  it("rejects Client Artifact placement outside the required base", () => {
    const manifest = staticManifest();
    manifest.base = "/docs";

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest.*base/i,
    );
  });

  it("rejects a Prerendered Route that does not reference an uploaded client file", () => {
    const manifest = staticManifest();
    manifest.routes.prerendered[0]!.objectKey = "missing.html";

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest.*Prerendered Route/i,
    );
  });

  it.each([
    "/docs/../index.html",
    "/docs/%2e%2e/index.html",
    "/docs/index.html?download=1",
    "/docs/index.html#file",
  ])("rejects the non-canonical URL path %s", (url) => {
    const manifest = staticManifest();
    manifest.base = "/docs";
    manifest.artifacts.client.files[0] = {
      path: "index.html",
      url,
      objectKey: "docs/index.html",
    };
    manifest.routes.prerendered[0] = {
      url,
      objectKey: "docs/index.html",
    };

    expect(() => parseDeploymentManifest(manifest)).toThrow(
      /Invalid Deployment Manifest/,
    );
  });
});
