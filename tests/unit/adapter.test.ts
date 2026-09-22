import { describe, expect, it } from "vitest";

import yandexCloud from "../../packages/adapter/src/index.js";
import type { AdapterOptions } from "../../packages/adapter/src/types.js";

async function adapterDescription(options?: AdapterOptions) {
  const hook = yandexCloud(options).hooks["astro:config:done"];
  let description: unknown;

  await hook?.({
    config: {},
    injectTypes: () => {},
    setAdapter: (adapter: unknown) => {
      description = adapter;
    },
  } as never);

  return description;
}

describe("adapter options and routes", () => {
  it("defaults to object-storage", () => {
    expect(yandexCloud().name).toBe("@astro-yandex-cloud/adapter");
  });

  it("rejects unknown targets", () => {
    expect(() => yandexCloud({ target: "vm" as never })).toThrow(
      /Unknown.*target/,
    );
  });

  it("rejects on-demand routes for object storage", () => {
    const hook = yandexCloud().hooks["astro:routes:resolved"];
    expect(() =>
      hook?.({
        routes: [
          {
            type: "page",
            origin: "project",
            params: ["id"],
            segments: [],
            pattern: "/api/[id]",
            patternRegex: /^\/api\/([^/]+?)$/,
            entrypoint: "src/pages/api/[id].ts",
            isPrerendered: false,
            fallbackRoutes: [],
            generate: () => "/api/id",
          },
        ],
        logger: {} as never,
      }),
    ).toThrow(/cannot serve on-demand routes.*\/api\/\[id\]/);
  });

  it("declares only the features supported by the Object Storage Target", async () => {
    expect(await adapterDescription()).toMatchObject({
      adapterFeatures: {
        buildOutput: "static",
        middlewareMode: "classic",
        preserveBuildClientDir: true,
        preserveBuildServerDir: true,
      },
      supportedAstroFeatures: {
        staticOutput: "stable",
        hybridOutput: "unsupported",
        serverOutput: "unsupported",
        sharpImageService: "stable",
        envGetSecret: "stable",
        i18nDomains: "unsupported",
      },
    });
  });

  it("declares runtime and limited Sharp support for the Object Storage + Cloud Functions Target", async () => {
    expect(
      await adapterDescription({ target: "object-storage-functions" }),
    ).toMatchObject({
      supportedAstroFeatures: {
        staticOutput: "stable",
        hybridOutput: "stable",
        serverOutput: "stable",
        sharpImageService: {
          support: "limited",
          message:
            "Sharp is externalized and has limited support in Yandex Cloud Functions.",
        },
        envGetSecret: "stable",
        i18nDomains: "unsupported",
      },
    });
  });

  it("preserves every configured Rolldown output for a Runtime Build", () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
    }).hooks["astro:build:setup"];
    let updatedConfig: unknown;

    void hook?.({
      target: "server",
      vite: {
        build: {
          rolldownOptions: {
            output: [
              { entryFileNames: "first.js" },
              { entryFileNames: "second.js" },
            ],
          },
        },
      },
      updateConfig: (config: unknown) => {
        updatedConfig = config;
      },
    } as never);

    expect(updatedConfig).toMatchObject({
      build: {
        rolldownOptions: {
          output: [
            {
              entryFileNames: "first.js",
              chunkFileNames: "chunks/[name]-[hash].js",
            },
            {
              entryFileNames: "second.js",
              chunkFileNames: "chunks/[name]-[hash].js",
            },
          ],
        },
      },
    });
  });
});
