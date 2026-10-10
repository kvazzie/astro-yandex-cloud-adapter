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

function optionsError(options: unknown): unknown {
  try {
    yandexCloud(options as AdapterOptions);
  } catch (error) {
    return error;
  }
  throw new Error("Expected the adapter to reject invalid options.");
}

describe("adapter options and routes", () => {
  it("defaults to object-storage", () => {
    expect(yandexCloud().name).toBe("@astro-yandex-cloud/adapter");
  });

  it("rejects recursive 404 without Gateway", () => {
    expect(optionsError({ recursive404: true })).toHaveProperty(
      "cause._tag",
      "ParseError",
    );
  });

  it("rejects unknown targets", () => {
    expect.assertions(2);
    try {
      yandexCloud({ target: "vm" as never });
    } catch (error) {
      expect(error).toHaveProperty("hook", "integration:options");
      expect(error).toHaveProperty(
        "cause.message",
        expect.stringMatching(/\["target"\][\s\S]*actual "vm"/),
      );
    }
  });

  it("rejects unknown dependency strategies", () => {
    expect.assertions(2);
    try {
      yandexCloud({ dependencyStrategy: "copy" as never });
    } catch (error) {
      expect(error).toHaveProperty("hook", "integration:options");
      expect(error).toHaveProperty(
        "cause.message",
        expect.stringMatching(/\["dependencyStrategy"\][\s\S]*actual "copy"/),
      );
    }
  });

  it("rejects install dependencies for Object Storage", () => {
    expect(
      optionsError({ target: "object-storage", dependencyStrategy: "install" }),
    ).toHaveProperty("cause._tag", "ParseError");
  });

  it.each([
    { dependencyStrategy: "install" },
    { functions: "separate" },
    { target: "object-storage", functions: "separate" },
    { directOrigin: "https://static.example" },
    { target: "object-storage", directOrigin: "https://static.example" },
    {
      target: "object-storage-functions",
      apiGateway: true,
      directOrigin: "https://static.example",
    },
  ])("rejects incompatible options while decoding: %j", (options) => {
    expect(optionsError(options)).toHaveProperty("cause._tag", "ParseError");
  });

  it.each([
    "not-an-origin",
    "ftp://static.example",
    "https://user:password@static.example",
    "https://static.example/path",
    "https://static.example?query=value",
    "https://static.example#fragment",
  ])(
    "rejects invalid direct origins while decoding options: %s",
    (directOrigin) => {
      expect(
        optionsError({ target: "object-storage-functions", directOrigin }),
      ).toHaveProperty("cause._tag", "ParseError");
    },
  );

  it.each([
    { dependencyStrategy: "bundle", functions: "shared" },
    { apiGateway: true, recursive404: true },
    {
      target: "object-storage-functions",
      apiGateway: true,
      recursive404: true,
      dependencyStrategy: "install",
      functions: "separate",
    },
    {
      target: "object-storage-functions",
      apiGateway: false,
      recursive404: false,
      directOrigin: "http://localhost:8080",
    },
  ] satisfies AdapterOptions[])("accepts compatible options: %j", (options) => {
    expect(() => yandexCloud(options)).not.toThrow();
  });

  it("embeds the normalized direct origin in the Function runtime config", async () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
      directOrigin: "https://STATIC.EXAMPLE:443/",
    }).hooks["astro:config:setup"];
    let runtimeSource: unknown;

    await hook?.({
      config: { vite: {}, outDir: new URL("file:///tmp/adapter-options/") },
      updateConfig: (patch: {
        vite: { plugins: [{ load: (id: string) => unknown }] };
      }) => {
        runtimeSource = patch.vite.plugins[0].load(
          "\0virtual:yandex-cloud-runtime-config",
        );
      },
    } as never);

    expect(runtimeSource).toContain(
      'export const directOrigin = "https://static.example";',
    );
  });

  it("rejects on-demand routes for object storage", async () => {
    const hooks = yandexCloud().hooks;
    const hook = hooks["astro:routes:resolved"];
    await hook?.({
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
    });
    await expect(
      hooks["astro:config:done"]?.({
        config: {},
        injectTypes: () => {},
        setAdapter: () => {},
      } as never),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/cannot serve on-demand routes.*\/api\/\[id\]/),
    );
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
          message:
            "Sharp and runtime image transformation are experimental in Yandex Cloud Functions.",
        },
      },
    });
  });

  it("rejects blanket noExternal before an install build merges Vite config", async () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
      dependencyStrategy: "install",
    }).hooks["astro:config:setup"];
    await expect(
      hook?.({
        config: { vite: { ssr: { noExternal: true } } },
        updateConfig: () => {},
      } as never),
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("vite.ssr.noExternal: true"),
    );
  });

  it("keeps runtime package imports external for the install strategy", async () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
      dependencyStrategy: "install",
    }).hooks["astro:build:setup"];
    interface UpdatedServerBuild {
      ssr?: { external?: unknown; noExternal?: unknown };
      build?: { rolldownOptions?: { output?: unknown } };
    }
    let updatedConfig: UpdatedServerBuild | undefined;

    await hook?.({
      target: "server",
      vite: {
        ssr: { external: ["nanoid"], noExternal: ["bundled-package"] },
        build: {
          rolldownOptions: { output: [{ entryFileNames: "first.js" }] },
        },
      },
      updateConfig: (config: unknown) => {
        updatedConfig = config as UpdatedServerBuild;
      },
    } as never);

    expect(updatedConfig?.ssr?.external).toEqual(["nanoid"]);
    expect(updatedConfig?.ssr?.noExternal).toEqual(["bundled-package"]);
    expect(updatedConfig?.build?.rolldownOptions?.output).toEqual([
      {
        entryFileNames: "first.js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    ]);
  });

  it("preserves every configured Rolldown output for a Runtime Build", async () => {
    const hook = yandexCloud({
      target: "object-storage-functions",
    }).hooks["astro:build:setup"];
    let updatedConfig: unknown;

    await hook?.({
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
