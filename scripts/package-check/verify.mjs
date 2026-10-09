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
const { fetch, structuredClone } = globalThis;
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

/**
 * Reject package imports absent from the candidate's declared dependencies,
 * including imports that the clean application's dependencies would mask.
 * @param {string} specifier Import or export source found in a packed file.
 */
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
  /**
   * Walk a packed file's syntax tree and audit static imports, exports,
   * import types, and literal dynamic imports or require calls.
   * @param {import("typescript").Node} node Syntax node in the current file.
   */
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

const minimalFunctionManifest = {
  schemaVersion: 1,
  adapter: { version: candidate.version },
  target: "object-storage-functions",
  modifiers: { apiGateway: false, recursive404: false, functions: "shared" },
  base: "/docs",
  artifacts: {
    client: { id: "client:primary", path: "client" },
    functions: [
      {
        id: "function:shared",
        path: "function",
        runtime: "nodejs22",
        entrypoint: "index.handler",
      },
    ],
  },
  directInvocation: { requestTargetParameter: "__astro_path" },
  routes: {
    prerendered: [],
    onDemand: [
      {
        kind: "endpoint",
        pattern: "/docs/api/ping",
        artifactId: "function:shared",
      },
    ],
    notFound: [],
  },
};

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
import adapter, { type AdapterOptions, type Target, type DependencyStrategy, type FunctionPartition, type DeploymentManifestV1,
  type YandexCloudRuntime, type YandexCloudInvocationContext, type YandexCloudHttpEvent, type YandexCloudHttpResult } from "${name}";
import type { YandexCloudRuntime as Runtime, YandexCloudHttpResult as Result } from "${name}/runtime";
import { parseDeploymentManifest, defineDeploymentManifest } from "${name}/deployment-manifest";
const target: Target = "object-storage-functions";
const strategy: DependencyStrategy = "install";
const partition: FunctionPartition = "separate";
const options: AdapterOptions = { target, dependencyStrategy: strategy, apiGateway: true, recursive404: true, functions: partition };
const direct: AdapterOptions = { target, directOrigin: "https://static.example" };
adapter(direct);
adapter(options);
export function useTypes(runtime: Runtime, result: Result): [YandexCloudRuntime, YandexCloudHttpResult, YandexCloudHttpEvent, YandexCloudInvocationContext] {
  return [runtime, result, runtime.event, runtime.context];
}
const manifest: DeploymentManifestV1 = defineDeploymentManifest(${JSON.stringify(minimalFunctionManifest)});
parseDeploymentManifest(manifest);
const copies: readonly string[] | undefined = manifest.routes.notFound[0]?.functionArtifactIds;
const emittedPartition: FunctionPartition | undefined = manifest.modifiers.functions;
const emitted404: boolean | undefined = manifest.modifiers.recursive404;
void [copies, emittedPartition, emitted404];
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
assert.deepEqual(
  parseDeploymentManifest(minimalFunctionManifest),
  minimalFunctionManifest,
);
assert(
  validateManifest(minimalFunctionManifest),
  JSON.stringify(validateManifest.errors),
);
const additiveManifest = structuredClone(minimalFunctionManifest);
additiveManifest.future = { compatible: true };
additiveManifest.modifiers.future = "compatible";
additiveManifest.artifacts.functions[0].future = true;
additiveManifest.routes.onDemand[0].future = "compatible";
assert.deepEqual(parseDeploymentManifest(additiveManifest), additiveManifest);
assert(
  validateManifest(additiveManifest),
  JSON.stringify(validateManifest.errors),
);
for (const invalid of [
  { ...minimalFunctionManifest, schemaVersion: 2 },
  {
    ...minimalFunctionManifest,
    modifiers: { ...minimalFunctionManifest.modifiers, functions: "invalid" },
  },
  {
    ...minimalFunctionManifest,
    modifiers: { ...minimalFunctionManifest.modifiers, recursive404: "yes" },
  },
]) {
  assert.throws(
    () => parseDeploymentManifest(invalid),
    /Invalid Deployment Manifest/,
  );
  assert.equal(validateManifest(invalid), false);
}
assert.throws(
  () =>
    parseDeploymentManifest({
      ...minimalFunctionManifest,
      target: "object-storage",
    }),
  /Object Storage Target/,
);
const checks = ["exports", "manifest-contract"];

/**
 * Reject build and home paths in emitted files after excluding the documented
 * Astro-owned metadata records from the diagnostic scan.
 * @param {string} directory Completed build output to scan recursively.
 */
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
/**
 * Build a JSON Action submission with the origin and session cookie exercised
 * by the generated handler and preview checks.
 * @param {string} origin Application origin used for Astro's origin check.
 */
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

/**
 * Builds each listed Function outside the consumer tree and installs its own
 * declared dependencies, so handlers cannot resolve packages from the fixture.
 * @param {string} output Completed application output.
 * @param {object} manifest Validated deployment contract.
 * @param {string} strategy Bundle or install dependency selection.
 * @param {(handlers: Map<string, Function>) => Promise<void>} check Handler assertions.
 */
async function isolatedHandlers(output, manifest, strategy, check) {
  const directories = [];
  const handlers = new Map();
  try {
    for (const artifact of manifest.artifacts.functions) {
      const directory = await mkdtemp(join(tmpdir(), "packed-function-"));
      directories.push(directory);
      await cp(join(output, artifact.path), directory, { recursive: true });
      const functionPackage = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (strategy === "install") {
        assert.equal(functionPackage.dependencies.nanoid, "3.3.17");
        await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
          cwd: directory,
          timeout: 120_000,
          maxBuffer: 10_000_000,
        });
      } else assert.deepEqual(functionPackage.dependencies, {});
      const { handler } = await import(
        pathToFileURL(join(directory, "index.js")).href
      );
      handlers.set(artifact.id, handler);
    }
    await check(handlers);
  } finally {
    for (const directory of directories)
      await rm(directory, { recursive: true, force: true });
  }
}

/** Creates a direct stateless form consumer without Astro-internal endpoints. */
async function directApplication(application) {
  await rm(join(application, "src"), { recursive: true, force: true });
  await mkdir(join(application, "src/pages/api/items"), { recursive: true });
  await writeFile(
    join(application, "src/pages/index.astro"),
    `<h1>Static fixture</h1>
<form method="post" action="https://functions.yandexcloud.net/function-id?__astro_path=%2Fdocs%2Fapi%2Fsubmit%3Fsource%3Dstatic%26__astro_path%3Dapplication">
<input name="name" /><button type="submit">Send</button></form>`,
  );
  await writeFile(
    join(application, "src/pages/api/submit.ts"),
    `export const prerender = false;
export const POST = async ({ request, url }) => {
  const form = await request.formData();
  return Response.json({ name: form.get("name"), origin: url.origin, pathname: url.pathname,
    source: url.searchParams.get("source"), applicationParameter: url.searchParams.get("__astro_path") });
};`,
  );
  await writeFile(
    join(application, "src/pages/api/items/[slug].ts"),
    `export const prerender = false;
export const GET = ({ params, url }) => Response.json({ slug: params.slug, values: url.searchParams.getAll("value") });`,
  );
}

/**
 * Builds an installed-candidate scenario, validates placement and routing, then
 * invokes isolated handlers and starts Astro's actual preview entrypoint.
 * @param {{ id: string, target: string, base: string, strategy?: string,
 *   direct?: boolean, recursive404?: boolean, functions?: "shared" | "separate",
 *   apiGateway?: boolean }} scenario Candidate matrix scenario.
 */
async function checkApplication({
  id,
  target,
  base,
  strategy,
  direct = false,
  recursive404 = false,
  functions = "shared",
  apiGateway = Boolean(strategy) && !direct,
}) {
  const runtime = Boolean(strategy);
  const application = join(root, `application with spaces-${checks.length}`);
  await cp(
    join(root, "fixtures", runtime && !direct ? "actions" : "static"),
    application,
    {
      recursive: true,
    },
  );
  if (direct) await directApplication(application);
  else if (runtime) {
    await mkdir(join(application, "src/pages/api"), { recursive: true });
    await writeFile(
      join(application, "src/pages/api/id.ts"),
      `import { nanoid } from "nanoid";
export const GET = () => Response.json({ id: nanoid() });\n`,
    );
    await writeFile(
      join(application, "src/pages/api/missing.ts"),
      `export const GET = () => new Response("Endpoint-owned 404", { status: 404, headers: { "x-endpoint": "preserved" } });`,
    );
  }
  if (recursive404) {
    await mkdir(join(application, "src/pages/guide"), { recursive: true });
    for (const [path, title] of [
      ["404.astro", "Root custom 404"],
      ["guide/404.astro", "Guide custom 404"],
    ])
      await writeFile(
        join(application, "src/pages", path),
        `---\nexport const prerender = true;\n---\n<h1>${title}</h1>`,
      );
  }
  const options = {
    target,
    apiGateway,
    recursive404,
    ...(runtime ? { dependencyStrategy: strategy, functions } : {}),
    ...(direct ? { directOrigin: "https://static.example" } : {}),
  };
  await writeFile(
    join(application, "astro.config.mjs"),
    `import adapter from "${name}";
import { defineConfig, passthroughImageService } from "astro/config";
export default defineConfig({ adapter: adapter(${JSON.stringify(options)}),
base: ${JSON.stringify(base)}, output: "${runtime && !direct ? "server" : "static"}",
site: "https://static.example", image: { service: passthroughImageService() } });\n`,
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
  assert.equal(manifest.modifiers.apiGateway, apiGateway);
  assert.equal(manifest.modifiers.recursive404, recursive404);
  if (runtime) assert.equal(manifest.modifiers.functions, functions);
  if (!runtime) assert.equal(manifest.artifacts.functions.length, 0);
  else if (functions === "shared")
    assert.equal(manifest.artifacts.functions.length, 1);
  else {
    assert.equal(
      manifest.artifacts.functions.length,
      manifest.routes.onDemand.length,
    );
    assert(manifest.artifacts.functions.length > 1);
    assert.equal(
      new Set(manifest.routes.onDemand.map(({ artifactId }) => artifactId)).size,
      manifest.artifacts.functions.length,
    );
  }
  for (const artifact of manifest.artifacts.functions) {
    assert(
      !Object.hasOwn(artifact, "support"),
      "Function Artifact emits support claims.",
    );
    assert.equal(artifact.runtime, "nodejs22");
    assert.equal(artifact.entrypoint, "index.handler");
    await access(join(output, artifact.path, "index.js"));
  }
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
  if (apiGateway) {
    assert.equal(manifest.gatewayTemplate.path, "yandex-api-gateway.json");
    assert(!Object.hasOwn(manifest, "directInvocation"));
    const template = JSON.parse(
      await readFile(join(output, manifest.gatewayTemplate.path), "utf8"),
    );
    assert.equal(template.openapi, "3.0.0");
    for (const route of manifest.routes.prerendered)
      assert.equal(
        template.paths[route.url].get["x-yc-apigateway-integration"].object,
        route.objectKey,
      );
    for (const variable of Object.values(template["x-yc-apigateway"].variables))
      assert.match(variable.default, /^REPLACE_ME_INVALID_/);
    if (recursive404) {
      assert.equal(
        template.paths["/docs/guide/{_+}"]["x-yc-apigateway-any-method"][
          "x-yc-apigateway-integration"
        ].object,
        "docs/guide/404/index.html",
      );
      assert.equal(
        template.paths["/docs/guide/{_+}"]["x-yc-apigateway-any-method"].responses[
          "200"
        ]["x-yc-status-mapping"],
        404,
      );
    }
  } else if (runtime) {
    assert.deepEqual(manifest.directInvocation, {
      requestTargetParameter: "__astro_path",
    });
    assert(!Object.hasOwn(manifest, "gatewayTemplate"));
    assert(manifest.routes.onDemand.every(({ kind }) => kind === "endpoint"));
  }
  await portableOutput(output);
  if (runtime) {
    await isolatedHandlers(output, manifest, strategy, async (handlers) => {
      const handlerFor = (pattern) => {
        const route = manifest.routes.onDemand.find(
          (route) => route.pattern === pattern,
        );
        assert(route, `No Function route for ${pattern}`);
        return handlers.get(route.artifactId);
      };
      const event = (path, overrides = {}) => ({
        httpMethod: "GET",
        url: path,
        path,
        headers: { host: "packed.example" },
        ...overrides,
      });
      if (direct) {
        const handler = handlerFor("/docs/api/submit");
        const form = await handler(
          {
            httpMethod: "POST",
            path: "/function-id",
            queryStringParameters: {
              __astro_path:
                "/docs/api/submit?source=static&__astro_path=application",
            },
            headers: {
              host: "functions.yandexcloud.net",
              origin: "https://static.example",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: "name=Ada",
          },
          context,
        );
        assert.equal(form.statusCode, 200);
        assert.deepEqual(JSON.parse(form.body), {
          name: "Ada",
          origin: "https://static.example",
          pathname: "/docs/api/submit",
          source: "static",
          applicationParameter: "application",
        });
        const item = await handler(
          {
            httpMethod: "GET",
            path: "/function-id",
            headers: { host: "functions.yandexcloud.net" },
            queryStringParameters: {
              __astro_path: "/docs/api/items/Ada?value=one&value=two",
            },
          },
          context,
        );
        assert.equal(item.statusCode, 200);
        assert.deepEqual(JSON.parse(item.body), {
          slug: "Ada",
          values: ["one", "two"],
        });
        const rejected = await handler(
          {
            httpMethod: "POST",
            path: "/function-id",
            queryStringParameters: { __astro_path: "/docs/api/submit" },
            headers: {
              host: "functions.yandexcloud.net",
              origin: "https://untrusted.example",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: "name=Ada",
          },
          context,
        );
        assert.equal(rejected.statusCode, 403);
      } else {
        const action = handlerFor("/docs/_actions/[...path]");
        const request = actionRequest("https://packed.example");
        const response = await action(
          event("/docs/_actions/greet", {
            httpMethod: request.method,
            headers: { ...request.headers, host: "packed.example" },
            body: request.body,
          }),
          context,
        );
        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), actionResult);
        assert.equal(response.multiValueHeaders["set-cookie"].length, 2);
        const endpoint = await handlerFor("/docs/api/id")(
          event("/docs/api/id"),
          context,
        );
        assert.equal(endpoint.statusCode, 200);
        assert.equal(JSON.parse(endpoint.body).id.length, 21);
        const missing = await handlerFor("/docs/api/missing")(
          event("/docs/api/missing"),
          context,
        );
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.body, "Endpoint-owned 404");
        assert.equal(missing.headers["x-endpoint"], "preserved");
        if (functions === "separate") {
          const crossRoute = await handlerFor("/docs/api/id")(
            event("/docs/_actions/greet", {
              httpMethod: request.method,
              headers: { ...request.headers, host: "packed.example" },
              body: request.body,
            }),
            context,
          );
          assert.equal(crossRoute.statusCode, 404);
        }
        if (recursive404) {
          const page = handlerFor("/docs/");
          for (const [path, title] of [
            ["/docs/guide/missing", "Guide custom 404"],
            ["/docs/guide/404", "Guide custom 404"],
            ["/docs/api/unknown", "Root custom 404"],
          ]) {
            const missingPage = await page(event(path), context);
            assert.equal(missingPage.statusCode, 404);
            assert(missingPage.body.includes(title));
          }
          const scope = manifest.routes.notFound.find(
            ({ scope }) => scope === "/docs/guide",
          );
          assert(scope);
          const pageId = manifest.routes.onDemand.find(
            ({ pattern }) => pattern === "/docs/",
          ).artifactId;
          assert(scope.functionArtifactIds.includes(pageId));
        }
      }
    });
  }
  const server = await preview({
    ...config,
    server: { host: "127.0.0.1", port: 0 },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const page = await fetch(
      `${origin}${prefix}/${runtime && !direct ? "prerendered/" : ""}`,
    );
    assert.equal(page.status, 200);
    assert(
      (await page.text()).includes(
        runtime && !direct ? "Prerendered Actions page" : "Static fixture",
      ),
    );
    if (runtime && !direct) {
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
      const missing = await fetch(`${origin}/docs/api/missing`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), "Endpoint-owned 404");
    }
    if (direct) {
      const form = await fetch(
        `${origin}/docs/api/submit?source=preview&__astro_path=application`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: "name=Ada",
        },
      );
      assert.equal(form.status, 200);
      assert.deepEqual(await form.json(), {
        name: "Ada",
        origin,
        pathname: "/docs/api/submit",
        source: "preview",
        applicationParameter: "application",
      });
    }
    if (recursive404) {
      const missing = await fetch(`${origin}/docs/guide/unknown`);
      assert.equal(missing.status, 404);
      assert((await missing.text()).includes("Guide custom 404"));
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
  {
    id: "object-storage:gateway-404:/docs",
    target: "object-storage",
    base: "/docs",
    apiGateway: true,
    recursive404: true,
  },
  {
    id: "object-storage-functions:direct-form:/docs",
    target: "object-storage-functions",
    base: "/docs",
    strategy: "bundle",
    direct: true,
  },
  {
    id: "object-storage-functions:separate-gateway-404:/docs",
    target: "object-storage-functions",
    base: "/docs",
    strategy: "bundle",
    functions: "separate",
    recursive404: true,
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
