import { describe, expect, it } from "vitest";

import yandexCloud from "../../packages/adapter/src/index.js";

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
