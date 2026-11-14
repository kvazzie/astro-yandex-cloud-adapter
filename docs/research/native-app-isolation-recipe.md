# Native App isolation recipe

This is an archived disposable research probe for
[native App isolation](native-app-isolation.md), not a test
runner or production implementation. It uses the checkout's
installed packages and asserts the exact Astro/Vite/Rolldown
versions. No new package installation or second application
bundler occurs. It writes only temporary fixtures and standalone
directories.

From the repository root after `pnpm install --frozen-lockfile`:

````sh
probe="$(mktemp /tmp/native-app-probe-XXXXXX.mjs)"
node --input-type=module - "$probe" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
const archive = await readFile('docs/research/native-app-isolation-recipe.md', 'utf8');
const source = archive.split('```js\n')[1].split('\n```')[0];
await writeFile(process.argv[2], source + '\n');
JS
node "$probe" "$PWD"
````

To repeat with another installed Node binary, use it for the last
command. The child handlers use the same binary as the probe.
Recorded runs used Node 22.12.0 and 26.13.0. A successful run
exits zero and prints the output location plus runtime results.
Raw `results.json` and per-fixture `manifest.json` files remain
in the printed output directory. Native `generateBundle` records
are in `results[].chunks`; the checked-in evidence omits that
full-build debug graph but retains every standalone file and its
final edges.

The fixture directory is renamed to `fixture-unavailable` before
executing the copied handlers. Copies live in separate
`/tmp/isolated-*` directories with no `node_modules`. There is no
automatic cleanup, so the output remains available for
inspection. Delete only the directories reported by your run when
finished.

The unsupported-Sharp diagnostic and missing-component errors
from negative controls are expected. Do not treat a successful
exit as coverage of the features excluded by the research note.

## Archived source

<!-- prettier-ignore -->
```js
// Disposable research recipe, not an adapter implementation or repository test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire, isBuiltin } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  copyFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
const repo = resolve(process.argv[2] ?? process.cwd());
const output = await mkdtemp(join(tmpdir(), "native-app-isolation-"));
const require = createRequire(join(repo, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("astro")));
const ts = require("typescript");
const viteRequire = createRequire(require.resolve("vite"));
const versions = {
  node: process.version,
  astro: require("astro/package.json").version,
  vite: require("vite/package.json").version,
  rolldown: viteRequire("rolldown/package.json").version,
};
assert.deepEqual(
  [versions.astro, versions.vite, versions.rolldown],
  ["7.1.6", "8.2.0", "1.2.3"],
);
async function put(path, body) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
const cases = [
  {
    name: "endpoints",
    base: "/",
    routes: [
      {
        name: "one",
        file: "one.ts",
        path: "/one",
        marker: "PROBE_ONE_ONLY",
        source: `export const GET = () => new Response('PROBE_ONE_ONLY');`,
      },
      {
        name: "two",
        file: "two.ts",
        path: "/two",
        marker: "PROBE_TWO_ONLY",
        source: `export const GET = () => new Response('PROBE_TWO_ONLY');`,
      },
    ],
  },
  {
    name: "page-base-precedence",
    base: "/nested/",
    routes: [
      {
        name: "specific",
        file: "specific.astro",
        path: "/specific",
        marker: "PROBE_PAGE_ONLY",
        source: `---\nconst message = 'PROBE_PAGE_ONLY';\n---\n<html><head><title>probe</title></head><body><h1>{message}</h1></body></html>`,
      },
      {
        name: "rest",
        file: "[...rest].ts",
        path: "/anything",
        marker: "PROBE_REST_ONLY",
        source: `export const GET = ({ params }) => new Response('PROBE_REST_ONLY:' + params.rest);`,
      },
    ],
  },
];
const results = [];
for (const scenario of cases) {
  const root = join(output, scenario.name, "fixture");
  await mkdir(root, { recursive: true });
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  await put(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  for (const route of scenario.routes)
    await put(join(root, "src/pages", route.file), route.source);
  const seed = join(root, "seed.mjs");
  const runtime = join(root, "runtime.mjs");
  await put(
    seed,
    `import { createApp } from 'astro/app/entrypoint';\nexport const app = createApp();\n`,
  );
  await put(runtime, `export { App, deserializeManifest } from 'astro/app';\n`);
  let pages, manifest, chunks;
  const events = [];
  const plugin = {
    name: "research-selected-sources",
    applyToEnvironment: (env) => env.name === "ssr",
    buildStart() {
      events.push("ssr:buildStart");
      this.emitFile({
        type: "chunk",
        id: runtime,
        fileName: "runtime.mjs",
        preserveSignature: "strict",
      });
      for (const route of scenario.routes) {
        const page = pages.find(
          (p) => p.component === "src/pages/" + route.file,
        );
        assert.ok(page, route.file);
        route.component = page.component;
        route.moduleSpecifier = page.moduleSpecifier;
        this.emitFile({
          type: "chunk",
          id: page.moduleSpecifier,
          fileName: route.name + ".mjs",
          preserveSignature: "strict",
        });
      }
    },
    generateBundle(_, bundle) {
      events.push("ssr:generateBundle");
      chunks = Object.values(bundle)
        .filter((c) => c.type === "chunk")
        .map((c) => ({
          file: c.fileName,
          imports: c.imports,
          dynamicImports: c.dynamicImports,
          moduleIds: c.moduleIds,
          facadeModuleId: c.facadeModuleId,
          sha256AtGenerate: createHash("sha256").update(c.code).digest("hex"),
        }));
    },
  };
  await build({
    root,
    configFile: false,
    base: scenario.base,
    output: "server",
    cacheDir: join(root, "cache"),
    outDir: join(root, "dist"),
    logLevel: "error",
    vite: { ssr: { noExternal: true } },
    adapter: {
      name: "research-app-isolation",
      hooks: {
        "astro:config:done"({ setAdapter }) {
          setAdapter({
            name: "research-app-isolation",
            entrypointResolution: "auto",
            serverEntrypoint: seed,
            supportedAstroFeatures: {
              staticOutput: "stable",
              serverOutput: "stable",
              hybridOutput: "stable",
            },
          });
        },
        "astro:build:setup"({ target, pages: data, updateConfig }) {
          if (target !== "server") return;
          pages = [...data.values()];
          events.push("astro:build:setup");
          updateConfig({ plugins: [plugin] });
        },
        "astro:build:ssr"({ manifest: data }) {
          events.push("astro:build:ssr");
          manifest = JSON.parse(JSON.stringify(data));
        },
        "astro:build:done"() {
          events.push("astro:build:done");
        },
      },
    },
    build: { serverEntry: "seed.mjs" },
  });
  assert.ok(manifest);
  const server = join(root, "dist/server");
  const graph = new Map(chunks.map((c) => [c.file, c]));
  const functions = [];
  for (const selected of scenario.routes) {
    const files = new Set(),
      external = new Set(),
      todo = ["runtime.mjs", selected.name + ".mjs"];
    while (todo.length) {
      const file = todo.pop();
      if (files.has(file)) continue;
      const chunk = graph.get(file);
      if (!chunk) {
        assert.ok(isBuiltin(file), `External package: ${file}`);
        external.add(file);
        continue;
      }
      files.add(file);
      todo.push(...chunk.imports, ...chunk.dynamicImports);
    }
    const directory = await mkdtemp(
      join(tmpdir(), `isolated-${scenario.name}-${selected.name}-`),
    );
    const evidence = [];
    for (const file of [...files].sort()) {
      const source = await readFile(join(server, file), "utf8");
      assert.equal(
        createHash("sha256").update(source).digest("hex"),
        graph.get(file).sha256AtGenerate,
      );
      for (const other of scenario.routes.filter((r) => r !== selected)) {
        assert.ok(
          !graph
            .get(file)
            .moduleIds.some((id) => id.endsWith("/src/pages/" + other.file)),
        );
      }
      // Compare actual final imports with native graph instead of trusting pre-final code.
      const actualEdges = [];
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      function edge(node) {
        assert.ok(
          node && ts.isStringLiteralLike(node),
          `Nonliteral import in ${file}`,
        );
        const specifier = node.text;
        if (isBuiltin(specifier)) actualEdges.push(specifier);
        else {
          assert.ok(
            specifier.startsWith("./") || specifier.startsWith("../"),
            `Bare import ${specifier}`,
          );
          const target = posix.normalize(
            posix.join(posix.dirname(file), specifier),
          );
          assert.ok(
            files.has(target),
            `Missing final edge ${file} -> ${target}`,
          );
          actualEdges.push(target);
        }
      }
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        )
          edge(node.moduleSpecifier);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        )
          edge(node.arguments[0]);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      assert.deepEqual(
        [...new Set(actualEdges)].sort(),
        [
          ...new Set([
            ...graph.get(file).imports,
            ...graph.get(file).dynamicImports,
          ]),
        ].sort(),
      );
      for (const other of scenario.routes.filter((r) => r !== selected))
        assert.ok(!source.includes(other.marker), `Foreign marker in ${file}`);
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await copyFile(join(server, file), join(directory, file));
      evidence.push({
        file,
        bytes: Buffer.byteLength(source),
        sha256: createHash("sha256").update(source).digest("hex"),
        edges: actualEdges,
      });
    }
    assert.ok(
      (
        await Promise.all(
          [...files].map((f) => readFile(join(directory, f), "utf8")),
        )
      ).some((s) => s.includes(selected.marker)),
    );
    const glue = `import { App, deserializeManifest } from './runtime.mjs';
const manifest = deserializeManifest(${JSON.stringify(manifest)});
manifest.pageMap = new Map([[${JSON.stringify(selected.component)}, async () => ({ page: () => import('./${selected.name}.mjs') })]]);
const app = new App(manifest, false);
export const match = request => app.match(request)?.route;
export const unguarded = request => app.render(request);
export function handler(request) {
  const routeData = app.match(request);
  if (!routeData || !manifest.pageMap.has(routeData.component)) return new Response('Not Found', { status: 404 });
  return app.render(request, { routeData });
}
`;
    await put(join(directory, "index.mjs"), glue);
    evidence.unshift({
      file: "index.mjs",
      bytes: Buffer.byteLength(glue),
      sha256: createHash("sha256").update(glue).digest("hex"),
      edges: ["runtime.mjs", selected.name + ".mjs"],
    });
    for (const other of scenario.routes.filter((r) => r !== selected))
      assert.ok(!glue.includes(other.marker));
    const physicalFiles = (
      await readdir(directory, { recursive: true, withFileTypes: true })
    )
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(directory.length + 1))
      .sort();
    assert.deepEqual(physicalFiles, evidence.map((e) => e.file).sort());
    functions.push({
      selected: selected.name,
      directory,
      files: evidence,
      external: [...external].sort(),
      containsOwnMarker: true,
      containsForeignMarker: false,
      finalNativeBytesUnchanged: true,
    });
  }
  // Remove access to build source/output before executing copies in fresh processes.
  await rename(root, root + "-unavailable");
  for (const fn of functions) {
    const checks = scenario.routes.map((route) => ({
      path: scenario.base.replace(/\/$/, "") + route.path,
      own: route.name === fn.selected,
      marker: route.marker,
    }));
    const runner = `import { handler, match, unguarded } from './index.mjs';
const responses = [];
for (const check of ${JSON.stringify(checks)}) {
  const request = new Request('https://probe.invalid' + check.path);
  const response = await handler(request);
  responses.push({ ...check, matched: match(request), status: response.status, body: await response.text() });
}
const foreign = ${JSON.stringify(checks.find((c) => !c.own).path)};
let unguardedResult;
try { const r = await unguarded(new Request('https://probe.invalid' + foreign)); unguardedResult = { status: r.status, body: (await r.text()).slice(0, 160) }; }
catch (e) { unguardedResult = { error: e.message }; }
console.log(JSON.stringify({ responses, unguardedResult }));`;
    const raw = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", runner],
      {
        cwd: fn.directory,
        encoding: "utf8",
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      },
    );
    const runtimeResult = JSON.parse(raw.trim().split("\n").at(-1));
    fn.runtime = runtimeResult;
    for (const response of runtimeResult.responses) {
      assert.equal(response.status, response.own ? 200 : 404);
      if (response.own) assert.ok(response.body.includes(response.marker));
      else assert.equal(response.body, "Not Found");
    }
    if (scenario.name === "page-base-precedence") {
      assert.equal(runtimeResult.responses[0].matched, "/specific");
      assert.equal(runtimeResult.responses[1].matched, "/[...rest]");
      if (fn.selected === "rest") {
        assert.deepEqual(runtimeResult.unguardedResult, {
          status: 200,
          body: "PROBE_REST_ONLY:specific",
        });
      }
    }
  }
  const result = {
    name: scenario.name,
    base: scenario.base,
    events,
    sources: scenario.routes.map(({ source, ...route }) => ({
      ...route,
      facadeModuleId: graph.get(route.name + ".mjs").facadeModuleId,
    })),
    routeMetadata: manifest.routes.map((r) => r.routeData),
    functions,
    chunks,
  };
  results.push(result);
  await put(
    join(output, scenario.name, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await put(
    join(output, "results.json"),
    JSON.stringify({ versions, output, results }, null, 2),
  );
}
console.log(
  JSON.stringify(
    {
      versions,
      output,
      results: results.map((r) => ({
        name: r.name,
        functions: r.functions.map((f) => ({
          selected: f.selected,
          directory: f.directory,
          files: f.files.length,
          external: f.external,
          runtime: f.runtime,
        })),
      })),
    },
    null,
    2,
  ),
);
```
