import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { PreviewServer } from "astro";
import type * as Astro from "astro";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const runCommand = promisify(execFile);
let root: string;
let astro: typeof Astro;
let applicationCount = 0;

async function expectBrowserAsset(page: string, origin: string, prefix: string) {
  const assetPath = page.match(/src="([^"]+)"/)?.[1];
  expect(assetPath).toMatch(new RegExp(`^${prefix}/_astro/`));
  const asset = await fetch(`${origin}${assetPath}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toBe("image/svg+xml");
  expect(await asset.text()).toContain("<svg");
}

async function startPreview(
  fixture: "static" | "static-functions" | "mixed" | "actions",
  target: "object-storage" | "object-storage-functions",
  base = "/",
  configOverrides: Pick<Astro.AstroUserConfig, "build" | "trailingSlash"> = {},
  adapterOptions: { apiGateway?: boolean; recursive404?: boolean } = {},
): Promise<{ server: PreviewServer; origin: string; application: string }> {
  const application = join(root, `application-${applicationCount++}`);
  await cp(join(fixtures, fixture, "src"), join(application, "src"), {
    recursive: true,
  });
  await cp(join(fixtures, fixture, "public"), join(application, "public"), {
    recursive: true,
  });
  await writeFile(
    join(application, "public/preview.mjs"),
    "export const preview = true;\n",
  );
  if (adapterOptions.recursive404) {
    await mkdir(join(application, "src/pages/guide"), { recursive: true });
    await writeFile(
      join(application, "src/pages/guide/404.astro"),
      "<h1>Guide missing page</h1>",
    );
  }
  if (fixture === "mixed") {
    await cp(
      join(fixtures, "static/src/pages/about.astro"),
      join(application, "src/pages/about.astro"),
    );
  }
  await writeFile(
    join(application, "astro.config.mjs"),
    `import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig, passthroughImageService } from "astro/config";
export default defineConfig({
  adapter: yandexCloud({ target: ${JSON.stringify(target)}, apiGateway: ${String(fixture === "mixed" || fixture === "actions")}, ...${JSON.stringify(adapterOptions)} }),
  base: ${JSON.stringify(base)},
  site: "https://fixture.example",
  output: ${JSON.stringify(fixture === "actions" ? "server" : "static")},
  image: { service: passthroughImageService() },
  server: { headers: { "x-preview-header": "configured" } },
  ...${JSON.stringify(configOverrides)},
});
`,
  );
  const config = { root: `${application}/`, logLevel: "silent" as const };
  await astro.build(config);
  const server = await astro.preview({
    ...config,
    server: { host: "127.0.0.1", port: 0 },
  });
  return { server, origin: `http://127.0.0.1:${server.port}`, application };
}

describe.sequential("preview from an installed adapter tarball", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "astro-yandex-preview-"));
    // The suite builds the adapter first; prepack would rebuild it during other tests.
    await runCommand(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", root],
      {
        cwd: resolve(import.meta.dirname, "../../packages/adapter"),
      },
    );
    const tarball = (await readdir(root)).find((file) => file.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    const astroPackage = JSON.parse(
      await readFile(
        createRequire(import.meta.url).resolve("astro/package.json"),
        "utf8",
      ),
    ) as { version: string };
    const workspacePackage = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { pnpm: { overrides: { unifont: string } } };
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@astro-yandex-cloud/adapter": `file:./${tarball!}`,
          astro: astroPackage.version,
          nanoid: "3.3.17",
        },
        // Match the workspace's Astro dependency pin on the supported Node minimum.
        overrides: { unifont: workspacePackage.pnpm.overrides.unifont },
      }),
    );
    await runCommand(
      "npm",
      ["install", "--engine-strict", "--no-audit", "--no-fund"],
      {
        cwd: root,
        timeout: 120_000,
        env: { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" },
      },
    );
    const require = createRequire(join(root, "package.json"));
    astro = (await import(
      pathToFileURL(require.resolve("astro")).href
    )) as typeof Astro;
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["object-storage", "/"],
    ["object-storage", "/docs"],
    ["object-storage-functions", "/"],
    ["object-storage-functions", "/docs"],
  ] as const)(
    "serves the %s Client Artifact under %s without a Function Artifact until stopped",
    async (target, base) => {
      const { server, origin, application } = await startPreview(
        "static",
        target,
        base,
      );
      const prefix = base === "/" ? "" : base;
      try {
        const response = await fetch(`${origin}${prefix}/`);
        expect(response.status).toBe(200);
        const page = await response.text();
        expect(page).toContain("<h1>Static fixture</h1>");
        expect(response.headers.get("x-preview-header")).toBe("configured");
        await expectBrowserAsset(page, origin, prefix);
        const about = await fetch(`${origin}${prefix}/about/`);
        expect(about.status).toBe(200);
        expect(await about.text()).toContain("<p>Static about page</p>");
        const endpoint = await fetch(`${origin}${prefix}/api/items/a.json`);
        expect(endpoint.status).toBe(200);
        expect(await endpoint.json()).toEqual({ slug: "a" });
        const head = await fetch(`${origin}${prefix}/`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await head.text()).toBe("");
        await expect(
          readFile(join(application, "dist/function/index.js")),
        ).rejects.toHaveProperty("code", "ENOENT");
        if (prefix) {
          expect((await fetch(`${origin}/about/`)).status).toBe(404);
          expect((await fetch(`${origin}/docs-other/about/`)).status).toBe(404);
        }
      } finally {
        await server.stop();
        await server.closed();
      }
      await expect(fetch(`${origin}${prefix}/`)).rejects.toThrow();
    },
  );

  it("previews nearest recursive 404 pages and explicit 404 URLs without a Function Artifact", async () => {
    const { server, origin } = await startPreview(
      "static",
      "object-storage",
      "/docs",
      {},
      { apiGateway: true, recursive404: true },
    );
    try {
      for (const path of [
        "/docs/guide/missing",
        "/docs/guide/404",
        "/docs/guide/404/",
      ]) {
        const missing = await fetch(`${origin}${path}`);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(await missing.text()).toContain("Guide missing page");
      }
      const rootMissing = await fetch(`${origin}/docs/elsewhere`);
      expect(rootMissing.status).toBe(404);
      expect(await rootMissing.text()).toContain("Missing page");
      const head = await fetch(`${origin}/docs/guide/missing`, { method: "HEAD" });
      expect(head.status).toBe(404);
      expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await head.text()).toBe("");
      expect(await (await fetch(`${origin}/docs-other/missing`)).text()).toBe(
        "Not Found",
      );
      const existing = await fetch(`${origin}/docs/about/`);
      expect(existing.status).toBe(200);
      expect(await existing.text()).toContain("Static about page");
    } finally {
      await server.stop();
      await server.closed();
    }
  });

  it.each([
    {
      build: "Static-only Build",
      fixture: "static-functions",
      target: "object-storage",
    },
    {
      build: "Runtime Build",
      fixture: "mixed",
      target: "object-storage-functions",
    },
  ] as const)(
    "serves file-format Prerendered Routes with trailing slashes in a $build",
    async ({ fixture, target }) => {
      const { server, origin } = await startPreview(fixture, target, "/docs", {
        build: { format: "file" },
        trailingSlash: "always",
      });
      try {
        const response = await fetch(`${origin}/docs/about/`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("<title>About</title>");
        expect(response.headers.get("x-fixture-middleware")).toBeNull();
        const assetPage = await fetch(`${origin}/docs/`);
        expect(assetPage.status).toBe(200);
        await expectBrowserAsset(await assetPage.text(), origin, "/docs");
      } finally {
        await server.stop();
        await server.closed();
      }
    },
  );

  it("serves JavaScript module assets with a browser-compatible content type", async () => {
    const { server, origin } = await startPreview(
      "static",
      "object-storage-functions",
      "/docs",
    );
    try {
      const response = await fetch(`${origin}/docs/preview.mjs`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      );
      expect(await response.text()).toBe("export const preview = true;\n");
    } finally {
      await server.stop();
      await server.closed();
    }
  });

  describe.each(["/", "/docs"])("Runtime Build under %s", (base) => {
    let server: PreviewServer;
    let origin: string;
    const prefix = base === "/" ? "" : base;
    beforeAll(async () => {
      ({ server, origin } = await startPreview(
        "mixed",
        "object-storage-functions",
        base,
      ));
    });
    afterAll(async () => {
      if (server) {
        await server.stop();
        await server.closed();
      }
    });

    it("preserves the local HTTP origin for same-origin runtime POST requests", async () => {
      const response = await fetch(
        `${origin}${prefix}/api/inspect/text?value=first&value=second`,
        {
          method: "POST",
          headers: {
            origin,
            "content-type": "text/plain",
            "x-repeated": "first, second",
            "x-forwarded-host": "attacker.example",
            "x-forwarded-proto": "https",
          },
          body: "hello",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        origin,
        method: "POST",
        pathname: `${prefix}/api/inspect/text`,
        bodyBase64: "aGVsbG8=",
        values: ["first", "second"],
        repeatedHeader: "first, second",
      });
    });

    it.each(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])(
      "passes the %s request method through the generated handler",
      async (method) => {
        const response = await fetch(`${origin}${prefix}/api/inspect/method`, {
          method,
          headers: { origin },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-inspected-method")).toBe(method);
        expect(response.headers.get("x-fixture-middleware")).toBe("runtime");
        expect(response.headers.get("x-preview-header")).toBe("configured");
        if (method === "HEAD") expect(await response.text()).toBe("");
        else expect(await response.json()).toMatchObject({ method, origin });
      },
    );

    it("serves Prerendered Routes, browser assets, and public files from the Client Artifact", async () => {
      const response = await fetch(`${origin}${prefix}/`);
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain("<h1>Prerendered home</h1>");
      expect(response.headers.get("x-fixture-middleware")).toBeNull();
      await expectBrowserAsset(page, origin, prefix);
      const publicFile = await fetch(`${origin}${prefix}/public.txt`);
      expect(publicFile.status).toBe(200);
      expect(await publicFile.text()).toBe("public fixture asset\n");
    });

    it("passes binary request and response bodies without changing bytes", async () => {
      const response = await fetch(`${origin}${prefix}/api/inspect/binary`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Uint8Array.from([0, 1, 2, 255]),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ bodyBase64: "AAEC/w==" });
      const binary = await fetch(`${origin}${prefix}/api/binary`);
      expect(binary.status).toBe(200);
      expect(binary.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await binary.arrayBuffer())).toEqual(
        Uint8Array.from([0, 1, 2, 255]),
      );
    });

    it("renders an On-demand Route and preserves multiple Set-Cookie headers", async () => {
      const response = await fetch(`${origin}${prefix}/runtime`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Runtime</title>");
      expect(response.headers.get("x-fixture-middleware")).toBe("runtime");
      expect(response.headers.getSetCookie()).toEqual([
        "runtime=true; Path=/; HttpOnly",
        "second=two; Path=/; SameSite=Strict",
      ]);
    });

    it.each([
      ["redirect", 307, "/runtime"],
      ["empty", 204, null],
    ] as const)(
      "preserves %s response status, headers, and empty body",
      async (kind, status, location) => {
        const response = await fetch(`${origin}${prefix}/api/response/${kind}`, {
          redirect: "manual",
        });
        expect(response.status).toBe(status);
        expect(response.headers.get("location")).toBe(location);
        expect(await response.text()).toBe("");
      },
    );

    it("stops listening and resolves closed after serving runtime requests", async () => {
      const closed = server.closed();
      await server.stop();
      await closed;
      await server.closed();
      await expect(fetch(`${origin}${prefix}/runtime`)).rejects.toThrow();
    });
  });

  it("passes incoming cookies and returns Action cookies over local HTTP", async () => {
    const { server, origin } = await startPreview(
      "actions",
      "object-storage-functions",
      "/docs",
    );
    try {
      const response = await fetch(`${origin}/docs/_actions/greet`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: "session=session-123",
        },
        body: JSON.stringify({ name: "Ada" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/json+devalue",
      );
      expect(response.headers.get("x-actions-middleware")).toBe("active");
      expect(await response.json()).toEqual([
        { message: 1, session: 2, middleware: 3 },
        "Hello, Ada",
        "session-123",
        "active",
      ]);
      expect(response.headers.getSetCookie()).toEqual([
        "action-first=one; Path=/; HttpOnly",
        "action-second=two; Path=/; SameSite=Lax",
      ]);
    } finally {
      await server.stop();
      await server.closed();
    }
  });
});
