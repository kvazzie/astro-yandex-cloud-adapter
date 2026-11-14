# Native App loader expansion recipe

Archived disposable probe extending
[#95's recipe](native-app-isolation-recipe.md). Read the
[results and limits](native-app-loader-expansion.md) before
interpreting an exit code. A successful run asserts the
documented negative results as well as the positive controls. It
does not mean the isolation policy passed.

## Extract and reproduce

Run from the repository root with Node 26.13.0 and pnpm 10.34.9
available. Both Astro versions meet their engines on that Node
version. These commands write only to fresh temporary
directories. The root package and lockfile stay unchanged.
`--ignore-scripts` was used in the recorded dependency installs.
The archived locks pin the transitive versions, including
optional platform packages. Network access to the package
registry is needed for installation.

````sh
loader_work="$(mktemp -d /tmp/native-loader-reproduction-XXXXXX)"
node --input-type=module - "$loader_work" <<'JS'
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const work = process.argv[2];
const archive = await readFile('docs/research/native-app-loader-expansion-recipe.md', 'utf8');
const source = archive.split('```js\n')[1].split('\n```')[0] + '\n';
const evidence = JSON.parse(await readFile('docs/research/native-app-loader-expansion-results.json', 'utf8'));
assert.equal(createHash('sha256').update(source).digest('hex'), evidence.recipeSha256);
await writeFile(work + '/probe.mjs', source);
for (const astro of ['7.1.6', '7.4.8']) {
  const env = work + '/env-' + astro;
  await mkdir(env);
  await writeFile(env + '/package.json', JSON.stringify({ private:true, type:'module', packageManager:'pnpm@10.34.9', dependencies:{ astro, '@astrojs/preact':'6.0.0', preact:'10.29.8', 'preact-render-to-string':'6.8.2', typescript:'5.9.3' }}));
  await writeFile(env + '/pnpm-lock.yaml', evidence.dependencyLockfiles[astro]);
}
JS
for astro_version in 7.1.6 7.4.8; do
  pnpm --dir "$loader_work/env-$astro_version" install --ignore-scripts --frozen-lockfile
  node "$loader_work/probe.mjs" "$PWD" "$loader_work/env-$astro_version" "$astro_version" > "$loader_work/$astro_version.log" 2>&1 || exit "$?"
done
````

Each log prints its output directory. Raw `results.json`,
manifests and native graphs remain there. Independent copies have
`/tmp/isolated-*` paths. Each run performs five builds, one per
fixture, with no second application bundler. Reference apps
execute from the original completed build in fresh child
processes. Then the fixture is renamed and the entire dependency
environment's `node_modules` is renamed while copied handlers
execute in separate fresh processes with `NODE_PATH` and
`NODE_OPTIONS` cleared. Renaming prevents normal resolution
through original paths; it is not an OS sandbox. Run the two
versions with different dependency environments and do not share
an environment between concurrent probe invocations.

The `finally` block restores the dependency directory. An
interruption or killed process can leave
`node_modules-unavailable`; rename it back before reuse. No
temporary directories are automatically deleted. Delete only
paths printed by your run after inspecting them.

The checker walks the complete candidate graph even when it finds
foreign code. It records every violation, copies final emitted
bytes verbatim, compares parsed final ESM edges with native
edges, scans markers and module IDs, and checks the physical file
set. Glue imports are parsed too. On 7.4.8, candidates
deliberately execute **after rejection** to distinguish working
responses from code exclusion. Their `runtimeCaveat` must
accompany any quoted response. A successful run requires a
foreign-source rejection on that version; removing the checker is
not an accepted reproduction.

The minimal adapter logs an unsupported-Sharp diagnostic.
Missing-component and intentional route errors are expected
child-process controls. No authored CSS, assets, hydration
directives, Actions or server islands appear in these fixtures.

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
const environment = resolve(process.argv[3]);
const expectedAstro = process.argv[4];
const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
assert.ok(["7.1.6", "7.4.8"].includes(expectedAstro));
const output = await mkdtemp(join(tmpdir(), "native-app-loader-expansion-"));
const require = createRequire(join(environment, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("astro")));
const ts = require("typescript");
const astroRequire = createRequire(require.resolve("astro"));
const viteRequire = createRequire(astroRequire.resolve("vite"));
const preact = (await import(pathToFileURL(require.resolve("@astrojs/preact"))))
  .default;
const versions = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  pnpm: execFileSync("pnpm", ["--version"], {
    cwd: environment,
    encoding: "utf8",
  }).trim(),
  astro: require("astro/package.json").version,
  vite: astroRequire("vite/package.json").version,
  preactIntegration: require("@astrojs/preact/package.json").version,
  preact: require("preact/package.json").version,
  preactRenderToString: require("preact-render-to-string/package.json").version,
  typescript: require("typescript/package.json").version,
  astroEngines: require("astro/package.json").engines,
  rolldown: viteRequire("rolldown/package.json").version,
};
assert.equal(versions.astro, expectedAstro);
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node
  .split(".")
  .map(Number);
assert.ok(
  nodeMajor > 22 ||
    (nodeMajor === 22 &&
      (expectedAstro === "7.1.6"
        ? nodeMinor >= 12
        : nodeMinor > 23 || (nodeMinor === 23 && nodePatch >= 4))),
  "Astro engines",
);
assert.equal(versions.vite, "8.3.7");
assert.equal(versions.rolldown, "1.2.18");
assert.equal(versions.preactIntegration, "6.0.0");
assert.equal(versions.preact, "10.29.8");
assert.equal(versions.preactRenderToString, "6.8.2");
const sourceSha256 = createHash("sha256")
  .update(await readFile(new URL(import.meta.url)))
  .digest("hex");
const lockfileSha256 = createHash("sha256")
  .update(await readFile(join(environment, "pnpm-lock.yaml")))
  .digest("hex");
const packageInventory = execFileSync(
  "pnpm",
  ["list", "--depth", "Infinity", "--json"],
  { cwd: environment, encoding: "utf8" },
);
const installed = new Set();
function collectPackages(node) {
  for (const category of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ])
    for (const [name, pkg] of Object.entries(node[category] ?? {})) {
      installed.add(name + "@" + pkg.version);
      collectPackages(pkg);
    }
}
for (const root of JSON.parse(packageInventory)) collectPackages(root);
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
// Extend #95 without changing the two original fixture sources.
for (const name of [
  "middleware-classic",
  "middleware-edge",
  "renderer-preact",
]) {
  const renderer = name === "renderer-preact";
  const action = `const mode = ctx.url.searchParams.get('mode');
if (mode === 'allowed') return ctx.rewrite('/allowed');
if (mode === 'foreign') return ctx.rewrite('/anything');
if (mode === 'error') throw new Error('PROBE_ROUTE_ERROR');`;
  cases.push({
    name,
    base: "/nested/",
    middleware: name === "middleware-edge" ? "edge" : "classic",
    renderer,
    routes: [
      {
        name: "specific",
        file: renderer ? "specific.astro" : "specific.ts",
        path: "/specific",
        marker: renderer ? "PROBE_PREACT_ONLY" : "PROBE_SPECIFIC_ONLY",
        extraSources: renderer ? ["src/components/Probe.jsx"] : [],
        source: renderer
          ? `---\nimport Probe from '../components/Probe.jsx';\nconst ctx = Astro;\n${action}\n---\n<html><head><title>probe</title></head><body><Probe trace={Astro.locals.trace} /></body></html>`
          : `export const GET = (ctx) => { ${action} return new Response('PROBE_SPECIFIC_ONLY:' + ctx.locals.trace); };`,
      },
      {
        name: "allowed",
        file: "allowed.ts",
        path: "/allowed",
        marker: "PROBE_ALLOWED_ONLY",
        source: `export const GET = (ctx) => new Response('PROBE_ALLOWED_ONLY:' + ctx.locals.trace);`,
      },
      {
        name: "error",
        file: "error.ts",
        path: "/error",
        marker: "PROBE_ERROR_ONLY",
        source: `export const GET = (ctx) => { if (ctx.url.searchParams.get('mode') === 'error') throw new Error('PROBE_ROUTE_ERROR'); return new Response('PROBE_ERROR_ONLY:' + ctx.locals.trace); };`,
      },
      {
        name: "rest",
        file: "[...rest].ts",
        path: "/anything",
        marker: "PROBE_REST_ONLY",
        source: `export const GET = (ctx) => new Response('PROBE_REST_ONLY:' + ctx.params.rest + ':' + ctx.locals.trace);`,
      },
    ],
    selections: [
      ["specific", "allowed"],
      ["rest", "error"],
    ],
  });
}
const results = [];
for (const scenario of cases) {
  const root = join(output, scenario.name, "fixture");
  await mkdir(root, { recursive: true });
  await symlink(
    join(environment, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  await put(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  for (const route of scenario.routes)
    await put(join(root, "src/pages", route.file), route.source);
  if (scenario.middleware) {
    await put(
      join(root, "src/middleware.ts"),
      `export const onRequest = async (ctx, next) => {
ctx.locals.trace += '>user';
const target = ctx.url.searchParams.get('mw');
const response = target ? await ctx.rewrite('/' + target) : await next();
response.headers.set('x-probe-user', 'USER_MIDDLEWARE'); return response; };`,
    );
    for (const order of ["pre", "post"])
      await put(
        join(root, order + ".ts"),
        `export const onRequest = async (ctx, next) => {
ctx.locals.trace = ${order === "pre" ? "'pre'" : "ctx.locals.trace + '>post'"};
const response = await next(); response.headers.set('x-probe-${order}', 'INJECTED_${order.toUpperCase()}'); return response; };`,
      );
  }
  if (scenario.renderer)
    await put(
      join(root, "src/components/Probe.jsx"),
      `export default function Probe({ trace }) { return <h1 data-framework="preact">PROBE_PREACT_ONLY:{trace}</h1>; }`,
    );
  const seed = join(root, "seed.mjs");
  const runtime = join(root, "runtime.mjs");
  await put(
    seed,
    `import { createApp } from 'astro/app/entrypoint';\nexport const app = createApp();\n`,
  );
  await put(runtime, `export { App, deserializeManifest } from 'astro/app';\n`);
  const middlewareSource = join(root, "compiled-middleware.mjs");
  const rendererSource = join(root, "compiled-renderers.mjs");
  await put(
    middlewareSource,
    `export { onRequest } from 'virtual:astro:middleware';\n`,
  );
  await put(
    rendererSource,
    `export { renderers } from 'virtual:astro:renderers';\n`,
  );
  let pages, manifest, chunks, middlewareEntryPoint;
  const acquisition = {};
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
      if (scenario.middleware === "classic")
        this.emitFile({
          type: "chunk",
          id: middlewareSource,
          fileName: "middleware.mjs",
          preserveSignature: "strict",
        });
      if (scenario.renderer)
        this.emitFile({
          type: "chunk",
          id: rendererSource,
          fileName: "renderers.mjs",
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
          generatedCode: c.code,
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
    integrations: [
      ...(scenario.renderer ? [preact()] : []),
      ...(scenario.middleware
        ? [
            {
              name: "probe-injected",
              hooks: {
                "astro:config:setup"({ addMiddleware }) {
                  addMiddleware({
                    entrypoint: join(root, "pre.ts"),
                    order: "pre",
                  });
                  addMiddleware({
                    entrypoint: join(root, "post.ts"),
                    order: "post",
                  });
                },
              },
            },
          ]
        : []),
    ],
    adapter: {
      name: "research-app-isolation",
      hooks: {
        "astro:config:done"({ setAdapter }) {
          setAdapter({
            name: "research-app-isolation",
            entrypointResolution: "auto",
            adapterFeatures: {
              middlewareMode: scenario.middleware ?? "classic",
            },
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
        "astro:build:ssr"({ manifest: data, middlewareEntryPoint: entry }) {
          middlewareEntryPoint = entry;
          acquisition.middlewareEntryPoint = entry?.href ?? null;
          acquisition.serializedRenderers = data.renderers;
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
  let middlewareFile;
  if (scenario.middleware === "edge") {
    assert.ok(middlewareEntryPoint, "Public edge entrypoint must exist");
    middlewareFile = middlewareEntryPoint.pathname.slice(server.length + 1);
    assert.ok(graph.has(middlewareFile));
  } else {
    assert.equal(middlewareEntryPoint, undefined);
    middlewareFile = scenario.middleware ? "middleware.mjs" : undefined;
  }
  acquisition.middlewareFile = middlewareFile ?? null;
  acquisition.middlewareMethod =
    scenario.middleware === "edge"
      ? "public astro:build:ssr URL"
      : scenario.middleware
        ? "private virtual:astro:middleware"
        : "none";
  acquisition.rendererMethod = scenario.renderer
    ? "private virtual:astro:renderers"
    : "none";
  acquisition.rendererEntryMetadata = scenario.renderer
    ? graph.get("renderers.mjs").moduleIds
    : [];
  await put(
    join(output, scenario.name, "native-graph.json"),
    JSON.stringify(
      chunks.map(({ generatedCode, ...chunk }) => chunk),
      null,
      2,
    ),
  );
  const functions = [];
  const selections =
    scenario.selections ?? scenario.routes.map((r) => [r.name]);
  for (const names of selections) {
    const selectedRoutes = scenario.routes.filter((r) =>
      names.includes(r.name),
    );
    const foreignRoutes = scenario.routes.filter(
      (r) => !names.includes(r.name),
    );
    const selected = selectedRoutes[0];
    const useRenderer = scenario.renderer && names.includes("specific");
    const violations = [];
    const files = new Set(),
      external = new Set(),
      todo = [
        "runtime.mjs",
        ...names.map((n) => n + ".mjs"),
        ...(middlewareFile ? [middlewareFile] : []),
        ...(useRenderer ? ["renderers.mjs"] : []),
      ];
    while (todo.length) {
      const file = todo.pop();
      if (files.has(file)) continue;
      const chunk = graph.get(file);
      if (!chunk) {
        if (!isBuiltin(file)) violations.push(`External package: ${file}`);
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
      const unchanged =
        createHash("sha256").update(source).digest("hex") ===
        graph.get(file).sha256AtGenerate;
      if (!unchanged) violations.push("Changed after generateBundle: " + file);
      for (const other of foreignRoutes) {
        for (const id of graph.get(file).moduleIds) {
          if (
            ["src/pages/" + other.file, ...(other.extraSources ?? [])].some(
              (source) => id.endsWith("/" + source),
            )
          )
            violations.push("Foreign source: " + id + " in " + file);
        }
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
        if (!node || !ts.isStringLiteralLike(node)) {
          violations.push(`Nonliteral import in ${file}`);
          return;
        }
        const specifier = node.text;
        if (isBuiltin(specifier)) actualEdges.push(specifier);
        else {
          if (!(specifier.startsWith("./") || specifier.startsWith("../"))) {
            violations.push(`Bare import ${specifier} in ${file}`);
            actualEdges.push(specifier);
            return;
          }
          const target = posix.normalize(
            posix.join(posix.dirname(file), specifier),
          );
          if (!files.has(target))
            violations.push(`Missing final edge ${file} -> ${target}`);
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
      for (const other of foreignRoutes)
        if (source.includes(other.marker))
          violations.push(`Foreign marker ${other.marker} in ${file}`);
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await copyFile(join(server, file), join(directory, file));
      assert.equal(await readFile(join(directory, file), "utf8"), source);
      evidence.push({
        file,
        bytes: Buffer.byteLength(source),
        sha256: createHash("sha256").update(source).digest("hex"),
        edges: actualEdges,
        moduleIds: graph.get(file).moduleIds,
        sha256AtGenerate: graph.get(file).sha256AtGenerate,
        unchangedSinceGenerate: unchanged,
      });
    }
    assert.ok(
      (
        await Promise.all(
          [...files].map((f) => readFile(join(directory, f), "utf8")),
        )
      ).some((s) => s.includes(selected.marker)),
    );
    const pageAssignments = selectedRoutes
      .map(
        (r) =>
          `[${JSON.stringify(r.component)}, async () => ({ page: () => import('./${r.name}.mjs') })]`,
      )
      .join(",");
    const glue = `import { App, deserializeManifest } from './runtime.mjs';
${useRenderer ? "import { renderers } from './renderers.mjs';" : ""}
export function makeApp({ middleware = true, renderer = true } = {}) {
const manifest = deserializeManifest(${JSON.stringify(manifest)});
manifest.pageMap = new Map([${pageAssignments}]);
${middlewareFile ? `if (middleware) manifest.middleware = () => import('./${middlewareFile}');` : ""}
${useRenderer ? "if (renderer) manifest.renderers = renderers;" : ""}
const app = new App(manifest, false);
return { app, manifest };
}
const { app, manifest } = makeApp();
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
      edges: [
        "runtime.mjs",
        ...names.map((n) => n + ".mjs"),
        ...(middlewareFile ? [middlewareFile] : []),
        ...(useRenderer ? ["renderers.mjs"] : []),
      ],
    });
    for (const other of foreignRoutes) assert.ok(!glue.includes(other.marker));
    const glueImports = [];
    function visitGlue(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        glueImports.push(node.moduleSpecifier.text.slice(2));
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        assert.ok(ts.isStringLiteralLike(node.arguments[0]));
        glueImports.push(node.arguments[0].text.slice(2));
      }
      ts.forEachChild(node, visitGlue);
    }
    visitGlue(
      ts.createSourceFile(
        "index.mjs",
        await readFile(join(directory, "index.mjs"), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
    );
    assert.deepEqual(
      [...new Set(glueImports)].sort(),
      [...new Set(evidence[0].edges)].sort(),
    );
    const physicalFiles = (
      await readdir(directory, { recursive: true, withFileTypes: true })
    )
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(directory.length + 1))
      .sort();
    assert.deepEqual(physicalFiles, evidence.map((e) => e.file).sort());
    functions.push({
      selected: names,
      directory,
      files: evidence,
      external: [...external].sort(),
      containsOwnMarker: true,
      copiedFinalBytesUnchanged: true,
      containsForeignMarker: violations.some((v) =>
        v.startsWith("Foreign marker"),
      ),
      finalNativeBytesUnchanged: !violations.some((v) =>
        v.startsWith("Changed after"),
      ),
      violations,
      closureAccepted: violations.length === 0,
    });
  }
  const checks = scenario.routes.map((route) => ({
    name: "ordinary-" + route.name,
    path: scenario.base.replace(/\/$/, "") + route.path,
    route: route.name,
    marker: route.marker,
  }));
  if (scenario.middleware) {
    checks.push(
      {
        name: "rewrite-allowed",
        path: "/nested/specific?mode=allowed",
        target: "allowed",
        expectedPolicy: 200,
      },
      {
        name: "rewrite-foreign",
        path: "/nested/specific?mode=foreign",
        target: "rest",
        expectedPolicy: 404,
      },
      {
        name: "middleware-rewrite-allowed",
        path: "/nested/specific?mw=allowed",
        target: "allowed",
        expectedPolicy: 200,
      },
      {
        name: "middleware-rewrite-foreign",
        path: "/nested/specific?mw=anything",
        target: "rest",
        expectedPolicy: 404,
      },
      {
        name: "error-specific",
        path: "/nested/specific?mode=error",
        expectedPolicy: 500,
      },
      {
        name: "error-rest",
        path: "/nested/error?mode=error",
        expectedPolicy: 500,
      },
    );
  }
  function runner(entry, reference, controls) {
    return `import * as entry from ${JSON.stringify(entry)};
const responses = [];
async function observe(render, check) {
try { const r = await render(new Request('https://probe.invalid' + check.path));
return { ...check, status: r.status, body: (await r.text()).slice(0, 2000), headers: Object.fromEntries(['x-probe-pre','x-probe-user','x-probe-post'].map(k => [k, r.headers.get(k)])) }; }
catch (e) { return { ...check, error: e.message }; }
}
const render = ${reference ? "r => entry.app.render(r)" : "entry.handler"};
for (const check of ${JSON.stringify(checks)}) responses.push({ ...(await observe(render, check)), matched: ${reference ? "entry.app.match" : "entry.match"}(new Request('https://probe.invalid' + check.path))${reference ? "?.route" : ""} });
const controls = [];
${controls ? `for (const check of ${JSON.stringify(checks)}) controls.push(await observe(entry.unguarded, check));` : ""}
const omissions = {};
${
  !reference && scenario.middleware
    ? `const withoutMiddleware = entry.makeApp({middleware:false}).app;
omissions.middleware = await observe(r => withoutMiddleware.render(r), ${JSON.stringify(checks[0])});`
    : ""
}
${
  !reference && scenario.renderer
    ? `const withoutRenderer = entry.makeApp({renderer:false}).app;
omissions.renderer = await observe(r => withoutRenderer.render(r), ${JSON.stringify(checks[0])});`
    : ""
}
console.log(JSON.stringify({responses, controls, omissions}));`;
  }
  function execute(cwd, code) {
    const raw = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      },
    );
    return JSON.parse(raw.trim().split("\n").at(-1));
  }
  const reference = execute(server, runner("./seed.mjs", true, false));
  for (const r of reference.responses.filter((r) => r.route)) {
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(r.marker));
  }
  if (scenario.middleware) {
    for (const name of ["rewrite-allowed", "middleware-rewrite-allowed"])
      assert.ok(
        reference.responses
          .find((r) => r.name === name)
          .body.includes("PROBE_ALLOWED_ONLY"),
      );
    for (const name of [
      "rewrite-foreign",
      "middleware-rewrite-foreign",
      "error-specific",
      "error-rest",
    ]) {
      const r = reference.responses.find((r) => r.name === name);
      assert.equal(r.status, 200);
      assert.ok(r.body.includes("PROBE_REST_ONLY"));
    }
  }
  // Break original resolution paths for source, node_modules and output.
  await rename(root, root + "-unavailable");
  await rename(
    join(environment, "node_modules"),
    join(environment, "node_modules-unavailable"),
  );
  try {
    for (const fn of functions) {
      assert.equal(
        fn.closureAccepted,
        expectedAstro === "7.1.6",
        "Version-specific closure outcome changed",
      );
      if (expectedAstro === "7.4.8") {
        assert.equal(
          fn.containsForeignMarker,
          true,
          "Latest negative control must expose foreign markers",
        );
        assert.ok(
          fn.violations.some((v) => v.startsWith("Foreign source")),
          "Latest negative control must expose foreign sources",
        );
        fn.runtimeCaveat =
          "Executed rejected closure containing foreign source; filesystem isolation not established";
      }
      const runtimeResult = execute(
        fn.directory,
        runner("./index.mjs", false, true),
      );
      fn.runtime = runtimeResult;
      for (const response of runtimeResult.responses.filter((r) => r.route)) {
        const own = fn.selected.includes(response.route);
        assert.equal(response.status, own ? 200 : 404);
        if (own) {
          assert.ok(response.body.includes(response.marker));
          if (scenario.middleware)
            assert.deepEqual(Object.values(response.headers), [
              "INJECTED_PRE",
              "USER_MIDDLEWARE",
              "INJECTED_POST",
            ]);
        } else assert.equal(response.body, "Not Found");
      }
      if (scenario.middleware && fn.selected.includes("specific")) {
        for (const name of ["rewrite-allowed", "middleware-rewrite-allowed"]) {
          const response = runtimeResult.responses.find((r) => r.name === name);
          assert.equal(response.status, 200);
          assert.ok(response.body.includes("PROBE_ALLOWED_ONLY"));
        }
        assert.equal(
          runtimeResult.omissions.middleware.headers["x-probe-user"],
          null,
        );
      }
      if (scenario.renderer && fn.selected.includes("specific")) {
        assert.ok(
          runtimeResult.responses[0].body.includes('data-framework="preact"'),
        );
        assert.ok(
          !runtimeResult.omissions.renderer.body?.includes("PROBE_PREACT_ONLY"),
        );
      }
      if (scenario.name === "page-base-precedence") {
        assert.equal(runtimeResult.responses[0].matched, "/specific");
        assert.equal(runtimeResult.responses[1].matched, "/[...rest]");
        if (fn.selected.includes("rest"))
          assert.equal(
            runtimeResult.controls[0].body,
            "PROBE_REST_ONLY:specific",
          );
      }
      fn.policyComparison = runtimeResult.responses
        .filter((r) => r.expectedPolicy)
        .map((r) => ({
          name: r.name,
          expected: fn.selected.includes("specific")
            ? r.name === "error-rest"
              ? 404
              : r.expectedPolicy
            : r.name === "error-rest"
              ? 500
              : 404,
          observed: r.status ?? "rejected promise",
          reference: reference.responses.find((x) => x.name === r.name),
        }));
      for (const r of fn.policyComparison)
        r.satisfied = r.expected === r.observed;
      if (scenario.middleware) {
        if (fn.selected.includes("specific")) {
          for (const name of [
            "rewrite-foreign",
            "middleware-rewrite-foreign",
            "error-specific",
          ]) {
            const r = runtimeResult.responses.find((r) => r.name === name);
            assert.match(r.error, /component instance.*rest/);
          }
        } else {
          const r = runtimeResult.responses.find(
            (r) => r.name === "error-rest",
          );
          assert.equal(r.status, 200);
          assert.ok(r.body.includes("PROBE_REST_ONLY:error"));
        }
      }
    }
  } finally {
    await rename(
      join(environment, "node_modules-unavailable"),
      join(environment, "node_modules"),
    );
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
    acquisition,
    reference,
    functions,
    chunks: chunks.map(({ generatedCode, ...chunk }) => chunk),
  };
  results.push(result);
  await put(
    join(output, scenario.name, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await put(
    join(output, "results.json"),
    JSON.stringify(
      {
        baseCommit,
        versions,
        sourceSha256,
        lockfileSha256,
        resolvedPackageGraph: [...installed].sort(),
        output,
        results,
      },
      null,
      2,
    ),
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
          closureAccepted: f.closureAccepted,
          violations: f.violations,
          policyComparison: f.policyComparison,
        })),
      })),
    },
    null,
    2,
  ),
);
```
