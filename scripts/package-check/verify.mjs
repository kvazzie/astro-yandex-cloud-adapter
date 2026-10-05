// This runner is copied into the clean app. Every package import resolves there.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isBuiltin } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build, preview } from "astro";
import yandexCloud from "@astro-yandex-cloud/adapter";
import { parseDeploymentManifest } from "@astro-yandex-cloud/adapter/deployment-manifest";
import Ajv from "ajv/dist/2020.js";
import ts from "typescript";

const run = promisify(execFile);
const { fetch } = globalThis;
const root = import.meta.dirname;
const name = "@astro-yandex-cloud/adapter";
const packageRoot = dirname(
  fileURLToPath(import.meta.resolve(`${name}/package.json`)),
);
const candidate = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
const declaredDependencies = new Set([
  ...Object.keys(candidate.dependencies ?? {}),
  ...Object.keys(candidate.peerDependencies ?? {}),
  name,
]);

// Audit even imports masked by an app dependency or a package's transitive deps.
function checkSpecifier(specifier) {
  if (
    specifier.startsWith(".") ||
    isBuiltin(specifier) ||
    specifier === "virtual:yandex-cloud-runtime-config"
  )
    return;
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  assert(
    declaredDependencies.has(packageName),
    `Undeclared packed dependency: ${packageName}`,
  );
}
for (const file of await readdir(join(packageRoot, "dist"), { recursive: true })) {
  if (!/\.(?:m?js|d\.ts)$/.test(file)) continue;
  const source = ts.createSourceFile(
    file,
    await readFile(join(packageRoot, "dist", file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require")
    )
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier))
      checkSpecifier(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

let typeProbe = "";
for (const [subpath, entry] of Object.entries(candidate.exports)) {
  const specifier = subpath === "." ? name : `${name}${subpath.slice(1)}`;
  const javascript =
    typeof entry === "string" ? entry : (entry.import ?? entry.default);
  assert(javascript, `No JavaScript entrypoint for ${specifier}`);
  const resolved = fileURLToPath(import.meta.resolve(specifier));
  assert.equal(resolved, resolve(packageRoot, javascript));
  await access(resolved);
  const module = await import(
    specifier,
    javascript.endsWith(".json") ? { with: { type: "json" } } : undefined
  );
  for (const helper of [
    "toWebRequest",
    "fromWebResponse",
    "getClientAddress",
    "runtimeLocals",
    "invoke",
  ]) {
    assert(!(helper in module), `Runtime helper must be private: ${helper}`);
  }
  if (typeof entry === "object" && entry.types) {
    typeProbe += `import type * as Entry${typeProbe.length} from ${JSON.stringify(specifier)};\n`;
  }
}
assert.equal(typeof yandexCloud, "function");
typeProbe += `
import adapter, { type AdapterOptions, type Target, type DependencyStrategy, type DeploymentManifestV1,
  type YandexCloudRuntime, type YandexCloudInvocationContext, type YandexCloudHttpEvent, type YandexCloudHttpResult } from "${name}";
import type { YandexCloudRuntime as Runtime, YandexCloudHttpResult as Result } from "${name}/runtime";
import { parseDeploymentManifest, defineDeploymentManifest } from "${name}/deployment-manifest";
const target: Target = "object-storage-functions";
const strategy: DependencyStrategy = "install";
const options: AdapterOptions = { target, dependencyStrategy: strategy };
adapter(options);
export function useTypes(runtime: Runtime, result: Result): [YandexCloudRuntime, YandexCloudHttpResult, YandexCloudHttpEvent, YandexCloudInvocationContext] {
  return [runtime, result, runtime.event, runtime.context];
}
const manifest: DeploymentManifestV1 = parseDeploymentManifest({});
defineDeploymentManifest(manifest);
`;
await writeFile(join(root, "entrypoints.ts"), typeProbe);
const program = ts.createProgram([join(root, "entrypoints.ts")], {
  noEmit: true,
  strict: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  types: ["node"],
});
// Check the consumer and all candidate declarations. Astro's own declarations
// reference optional integrations and globals outside this package's contract.
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter(
    ({ file }) =>
      !file ||
      file.fileName === join(root, "entrypoints.ts") ||
      file.fileName.startsWith(join(packageRoot, "dist/")),
  );
assert.equal(
  diagnostics.length,
  0,
  ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }),
);
const schema = JSON.parse(
  await readFile(
    fileURLToPath(import.meta.resolve(`${name}/deployment-manifest.schema.json`)),
    "utf8",
  ),
);
const validateManifest = new Ajv({ strict: false }).compile(schema);
const checks = ["exports"];

async function portableOutput(directory) {
  for (const file of await readdir(directory, { recursive: true })) {
    const path = join(directory, file);
    if (!(await stat(path)).isFile()) continue;
    let source = await readFile(path, "utf8");
    if (/\.m?js$/.test(file)) {
      // Only the Astro-owned records documented in docs/artifact-reports.md.
      source = source
        .replace(/\bdeserializeManifest\((\{[^\n]+\})\);/g, (_match, json) => {
          const metadata = JSON.parse(json);
          for (const field of [
            "rootDir",
            "srcDir",
            "publicDir",
            "outDir",
            "cacheDir",
            "buildClientDir",
            "buildServerDir",
          ]) {
            assert.match(metadata[field], /^file:\/\/\//);
            delete metadata[field];
          }
          metadata.entryModules = Object.entries(metadata.entryModules).map(
            ([key, value]) => [
              key.startsWith("/") ? "<Astro module ID>" : key,
              value,
            ],
          );
          return `deserializeManifest(${JSON.stringify(metadata)});`;
        })
        .replace(
          /\}, "[^"\n]+\.astro", (?:void 0|undefined)\)/g,
          '}, "<Astro component>", undefined)',
        )
        .replace(
          /\bvar \$\$file = "[^"\n]+\.astro";/g,
          'var $$file = "<Astro component>";',
        );
    }
    for (const buildRoot of [root, homedir()])
      assert(!source.includes(buildRoot), `Absolute build path in ${file}`);
    assert.doesNotMatch(
      source,
      /file:\/\/\/|\/(?:home|Users|tmp|private\/(?:tmp|var\/folders))\/|\b[A-Za-z]:[\\/]/,
      `Absolute path in ${file}`,
    );
  }
}

const context = {
  functionFolderId: "packed-check",
  functionName: "packed-check",
  functionVersion: "packed-check",
  memoryLimitInMB: "128",
  requestId: "packed-check",
  getPayload: () => undefined,
  getRemainingTimeInMillis: () => 30_000,
};
function actionRequest(origin) {
  return {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: "session=session-123",
    },
    body: JSON.stringify({ name: "Ada" }),
  };
}
const actionResult = [
  { message: 1, session: 2, middleware: 3 },
  "Hello, Ada",
  "session-123",
  "active",
];

async function checkApplication({ id, target, base, strategy }) {
  const runtime = Boolean(strategy);
  const application = join(root, `application with spaces-${checks.length}`);
  await cp(join(root, "fixtures", runtime ? "actions" : "static"), application, {
    recursive: true,
  });
  if (runtime) {
    await mkdir(join(application, "src/pages/api"), { recursive: true });
    await writeFile(
      join(application, "src/pages/api/id.ts"),
      `import { nanoid } from "nanoid";
export const GET = () => Response.json({ id: nanoid() });\n`,
    );
  }
  await writeFile(
    join(application, "astro.config.mjs"),
    `
import adapter from "${name}";
import { defineConfig, passthroughImageService } from "astro/config";
export default defineConfig({ adapter: adapter(${JSON.stringify({ target, dependencyStrategy: strategy })}),
base: ${JSON.stringify(base)}, output: "${runtime ? "server" : "static"}", image: { service: passthroughImageService() } });\n`,
  );
  const config = { root: `${application}/`, logLevel: "silent" };
  await build(config);
  const output = join(application, "dist");
  const manifest = parseDeploymentManifest(
    JSON.parse(await readFile(join(output, "yandex-cloud.json"), "utf8")),
  );
  assert(validateManifest(manifest), JSON.stringify(validateManifest.errors));
  assert.equal(manifest.adapter.version, candidate.version);
  assert.equal(manifest.target, target);
  assert.equal(manifest.base, base);
  assert.equal(manifest.artifacts.functions.length, runtime ? 1 : 0);
  await access(join(output, manifest.artifacts.client.path));
  const prefix = base === "/" ? "" : base;
  for (const route of manifest.routes.prerendered) {
    assert.equal(route.artifactId, manifest.artifacts.client.id);
    const keyPrefix = prefix ? `${prefix.slice(1)}/` : "";
    assert(route.objectKey.startsWith(keyPrefix));
    await access(
      join(
        output,
        manifest.artifacts.client.path,
        route.objectKey.slice(keyPrefix.length),
      ),
    );
  }
  await portableOutput(output);
  if (runtime) {
    assert(
      manifest.routes.onDemand.some(
        ({ pattern }) => pattern === "/docs/_actions/[...path]",
      ),
    );
    const artifact = manifest.artifacts.functions[0];
    const isolated = await mkdtemp(join(tmpdir(), "packed-function-"));
    try {
      await cp(join(output, artifact.path), isolated, { recursive: true });
      const functionPackage = JSON.parse(
        await readFile(join(isolated, "package.json"), "utf8"),
      );
      if (strategy === "install") {
        assert.equal(functionPackage.dependencies.nanoid, "3.3.17");
        await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
          cwd: isolated,
          timeout: 120_000,
          maxBuffer: 10_000_000,
        });
      } else assert.deepEqual(functionPackage.dependencies, {});
      const { handler } = await import(
        pathToFileURL(join(isolated, "index.js")).href
      );
      const request = actionRequest("https://packed.example");
      const response = await handler(
        {
          httpMethod: request.method,
          path: "/docs/_actions/greet",
          headers: { ...request.headers, host: "packed.example" },
          body: request.body,
        },
        context,
      );
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), actionResult);
      assert.equal(response.multiValueHeaders["set-cookie"].length, 2);
      const endpoint = await handler(
        {
          httpMethod: "GET",
          path: "/docs/api/id",
          headers: { host: "packed.example" },
        },
        context,
      );
      assert.equal(endpoint.statusCode, 200);
      assert.equal(JSON.parse(endpoint.body).id.length, 21);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  }
  const server = await preview({
    ...config,
    server: { host: "127.0.0.1", port: 0 },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(
      `${origin}${prefix}/${runtime ? "prerendered/" : ""}`,
    );
    assert.equal(page.status, 200);
    assert(
      (await page.text()).includes(
        runtime ? "Prerendered Actions page" : "Static fixture",
      ),
    );
    if (runtime) {
      const action = await fetch(
        `${origin}/docs/_actions/greet`,
        actionRequest(origin),
      );
      assert.equal(action.status, 200);
      assert.deepEqual(await action.json(), actionResult);
      assert.equal(action.headers.getSetCookie().length, 2);
      const endpoint = await fetch(`${origin}/docs/api/id`);
      assert.equal(endpoint.status, 200);
      assert.equal((await endpoint.json()).id.length, 21);
    }
  } finally {
    await server.stop();
    await server.closed();
  }
  await assert.rejects(fetch(`${origin}${prefix}/`));
  checks.push(id);
  process.stdout.write(`Passed ${id}\n`);
}

for (const scenario of [
  { id: "object-storage:/", target: "object-storage", base: "/" },
  { id: "object-storage:/docs", target: "object-storage", base: "/docs" },
  {
    id: "object-storage-functions:static:/docs",
    target: "object-storage-functions",
    base: "/docs",
  },
  {
    id: "object-storage-functions:bundle:/docs",
    target: "object-storage-functions",
    base: "/docs",
    strategy: "bundle",
  },
  {
    id: "object-storage-functions:install:/docs",
    target: "object-storage-functions",
    base: "/docs",
    strategy: "install",
  },
])
  await checkApplication(scenario);
const astroPackage = JSON.parse(
  await readFile(fileURLToPath(import.meta.resolve("astro/package.json")), "utf8"),
);
await writeFile(
  join(root, "result.json"),
  JSON.stringify({
    checks,
    astroVersion: astroPackage.version,
    nodeVersion: process.version,
  }),
);
