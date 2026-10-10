import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "astro";
import { describe, expect, it } from "vitest";
import type { YandexCloudManifestV1 } from "../../packages/adapter/src/types.js";

const fixtures = resolve(import.meta.dirname, "../fixtures");

describe.sequential("completed Manifest contract", () => {
  it("records resolved asset-prefix maps without guessing a single asset origin", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "yandex-manifest-assets-"));
    const assetsPrefix = {
      js: "https://scripts.example",
      css: "https://styles.example",
      fallback: "https://assets.example",
    };
    await build({
      root: `${join(fixtures, "static")}/`,
      outDir,
      build: { assetsPrefix },
      logLevel: "silent",
    });
    const manifest = JSON.parse(
      await readFile(join(outDir, "yandex-cloud.json"), "utf8"),
    ) as YandexCloudManifestV1;
    expect(manifest.assetsPrefix).toEqual(assetsPrefix);
  });
});
