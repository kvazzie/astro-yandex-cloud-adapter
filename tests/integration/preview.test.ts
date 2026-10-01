import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PreviewServerParams } from "astro";
import { expect, it } from "vitest";

import preview from "../../packages/adapter/src/preview.js";

it("serves a Static-only Client Artifact until preview stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "astro-yandex-preview-"));
  const client = join(root, "client");
  await mkdir(join(client, "about"), { recursive: true });
  await writeFile(join(client, "about", "index.html"), "<h1>About</h1>");
  const params = {
    outDir: pathToFileURL(`${root}/`),
    client: pathToFileURL(`${client}/`),
    server: pathToFileURL(`${root}/function/`),
    serverEntrypoint: pathToFileURL(`${root}/function/index.js`),
    root: pathToFileURL(`${root}/`),
    host: "127.0.0.1",
    port: 0,
    base: "/",
    logger: { error: () => {} },
  } as unknown as PreviewServerParams;

  try {
    const server = await preview(params);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/about/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>About</h1>");
    } finally {
      await server.stop();
      await server.closed();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
