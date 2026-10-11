import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import yandexCloud from "../../packages/adapter/src/index.js";

describe("artifact size reports", () => {
  it("reports exact local bytes including nested, hidden, and binary Client Artifact files", async () => {
    const root = await mkdtemp(join(tmpdir(), "astro-yandex-report-"));
    try {
      const outDir = pathToFileURL(`${root}/dist/`);
      const client = new URL("client/", outDir);
      await mkdir(new URL("nested/", client), { recursive: true });
      await writeFile(new URL("hello.txt", client), "hello");
      await writeFile(join(root, "dist/client/nested/space # %.txt"), "é");
      await writeFile(new URL(".binary", client), Buffer.from([0, 1, 255]));
      const hooks = yandexCloud().hooks;
      await hooks["astro:config:done"]?.({
        config: {
          root: pathToFileURL(`${root}/`),
          outDir,
          base: "/",
          trailingSlash: "ignore",
          image: { endpoint: { route: "/_image" } },
          build: { client, server: new URL("function/", outDir) },
        },
        injectTypes: () => {},
        setAdapter: () => {},
      } as never);
      const logger = { info: vi.fn(), warn: vi.fn() };
      await hooks["astro:build:done"]?.({
        pages: [],
        assets: new Map(),
        logger,
      } as never);

      expect(logger.info).toHaveBeenCalledWith(
        "Client Artifact client: 10 local bytes in 3 files; largest file: 5 bytes.",
      );
      expect(logger.info.mock.calls.flat().join("\n")).not.toContain(root);
      expect(logger.info.mock.calls.flat().join("\n")).not.toContain(
        "Function Artifact",
      );
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { bytes: 0, expectedBytes: 141, largestBytes: 108, warning: false },
    {
      bytes: 128_000_001,
      expectedBytes: 128_000_142,
      largestBytes: 128_000_001,
      warning: false,
    },
    {
      bytes: 679_999_859,
      expectedBytes: 680_000_000,
      largestBytes: 679_999_859,
      warning: false,
    },
    {
      bytes: 680_000_000,
      expectedBytes: 680_000_141,
      largestBytes: 680_000_000,
      warning: true,
    },
  ])(
    "reports finalized Function bytes with $bytes source bytes without enforcing ZIP limits",
    async ({ bytes, expectedBytes, largestBytes, warning }) => {
      const root = await mkdtemp(join(tmpdir(), "astro-yandex-report-"));
      try {
        const outDir = pathToFileURL(`${root}/dist/`);
        const client = new URL("client/", outDir);
        const server = new URL("function/", outDir);
        await mkdir(client, { recursive: true });
        await mkdir(server, { recursive: true });
        await writeFile(
          new URL("index.js", server),
          "export const handler = () => {};\n",
        );
        // A sparse file exercises the real size boundary without a large allocation.
        await writeFile(new URL("large.bin", server), "");
        await truncate(new URL("large.bin", server), bytes);
        const hooks = yandexCloud({ target: "object-storage-functions" }).hooks;
        await hooks["astro:routes:resolved"]?.({
          routes: [
            {
              type: "endpoint",
              origin: "project",
              pattern: "/api/test",
              patternRegex: /^\/api\/test\/?$/,
              entrypoint: "src/pages/api/test.ts",
              isPrerendered: false,
            },
          ],
          logger: {},
        } as never);
        await hooks["astro:config:done"]?.({
          config: {
            root: pathToFileURL(`${root}/`),
            outDir,
            base: "/",
            trailingSlash: "ignore",
            image: { endpoint: { route: "/_image" } },
            build: { client, server },
          },
          injectTypes: () => {},
          setAdapter: () => {},
        } as never);
        const logger = { info: vi.fn(), warn: vi.fn() };
        await hooks["astro:build:done"]?.({
          pages: [],
          assets: new Map(),
          logger,
        } as never);

        expect(logger.info).toHaveBeenCalledWith(
          "Client Artifact client: 0 local bytes in 0 files; largest file: 0 bytes.",
        );
        expect(logger.info).toHaveBeenCalledWith(
          `Function Artifact function: ${expectedBytes} local bytes in 3 files; largest file: ${largestBytes} bytes.`,
        );
        if (warning) {
          expect(logger.warn).toHaveBeenCalledWith(
            "Function Artifact function exceeds the advisory 680 MB expanded-code comparison. The build continues; the Deployment Product must check the final archive.",
          );
        } else {
          expect(logger.warn).not.toHaveBeenCalled();
        }
        expect(logger.info.mock.calls.flat().join("\n")).not.toContain(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
