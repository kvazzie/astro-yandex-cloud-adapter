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

  it("rejects unknown dependency strategies", () => {
    expect(() => yandexCloud({ dependencyStrategy: "copy" as never })).toThrow(
      /Unknown.*dependency strategy/,
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

  it("defaults Function Artifacts to bundle and rejects native Sharp", async () => {
    expect(
      await adapterDescription({ target: "object-storage-functions" }),
    ).toMatchObject({
      supportedAstroFeatures: {
        staticOutput: "stable",
        hybridOutput: "stable",
        serverOutput: "stable",
        sharpImageService: {
          support: "unsupported",
          message:
            'Sharp is a native runtime dependency and cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install".',
        },
        envGetSecret: "stable",
        i18nDomains: "unsupported",
      },
    });
  });

  it("exposes the artifact-wide install strategy for its follow-up implementation", async () => {
    expect(
      await adapterDescription({
        target: "object-storage-functions",
        dependencyStrategy: "install",
      }),
    ).toMatchObject({
      supportedAstroFeatures: {
        sharpImageService: {
          support: "limited",
          message: "Sharp support is experimental in Yandex Cloud Functions.",
        },
      },
    });
  });

  it("keeps runtime package imports external for the install strategy", () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
      dependencyStrategy: "install",
    }).hooks["astro:build:setup"];
    interface UpdatedServerBuild {
      ssr?: { external?: unknown; noExternal?: unknown };
      build?: { rolldownOptions?: { output?: unknown } };
    }
    let updatedConfig: UpdatedServerBuild | undefined;

    void hook?.({
      target: "server",
      vite: {
        ssr: { external: ["nanoid"], noExternal: true },
        build: {
          rolldownOptions: { output: [{ entryFileNames: "first.js" }] },
        },
      },
      updateConfig: (config: unknown) => {
        updatedConfig = config as UpdatedServerBuild;
      },
    } as never);

    expect(updatedConfig?.ssr?.external).toEqual(["nanoid"]);
    expect(updatedConfig?.ssr?.noExternal).not.toBe(true);
    expect(updatedConfig?.build?.rolldownOptions?.output).toEqual([
      {
        entryFileNames: "first.js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    ]);
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
