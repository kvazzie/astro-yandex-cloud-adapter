# Reproduce production rewrite and error behavior

This is an archived disposable diagnostic, not a repository test
framework or an implementation of transition policy. See
[the report](rewrite-error-contract.md) before interpreting it.
The recorded source SHA-256 is
`014cc11a4ed8ed905e535f2581408c41dc0df7cb7e0b1921e9ca214274302d64`.

## Extract and run

Use the existing research checkout, Node 26.13.0 for the probe,
and the repository's declared pnpm for its build. The recorded
isolated installs used pnpm 12.18.0, while the probe's pnpm
version command ran in the repository and returned 10.33.2. Do
not change machine configuration or root dependencies to run this
recipe. Use an installed compatible Node or an isolated
toolchain. Astro 7.4.8 requires Node >=22.23.4.

Run from the repository root. Build the unchanged adapter with
its frozen workspace graph first. The extraction writes the
archived environment locks, so a fresh run does not select new
framework versions. Temporary paths in results are provenance,
not inputs required by the extraction.

````sh
pnpm install --frozen-lockfile
pnpm build
contract_work=$(mktemp -d /tmp/rewrite-error-contract-repro-XXXXXX)
node --input-type=module - "$contract_work" <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const work = process.argv[2];
const recipe = await readFile('docs/research/rewrite-error-contract-recipe.md','utf8');
const source = recipe.split('\n```js\n')[1].split('\n```')[0] + '\n';
const evidence = JSON.parse(await readFile('docs/research/rewrite-error-contract-results.json','utf8'));
assert.equal(createHash('sha256').update(source).digest('hex'), evidence.versions[0].sourceSha256);
await writeFile(work + '/probe.mjs', source);
for (const entry of evidence.versions) {
  const env = work + '/env-' + entry.astro;
  await mkdir(env, { recursive: true });
  await writeFile(env + '/package.json', JSON.stringify({ private:true, type:'module', dependencies:{astro:entry.astro,vite:'8.3.7',sharp:'0.34.5'} }));
  await writeFile(env + '/pnpm-lock.yaml', entry.environmentLock);
}
JS
for astro_version in 7.1.6 7.4.8; do
  pnpm --dir "$contract_work/env-$astro_version" install --ignore-scripts --frozen-lockfile
  node "$contract_work/probe.mjs" "$PWD" "$contract_work/env-$astro_version" "$astro_version" > "$contract_work/$astro_version.log" 2>&1 || exit "$?"
done
````

Each version creates six fixture families and builds each once
with the full reference entry, once with production shared mode,
and once with production separate mode. Every direct handler/App
observation uses a fresh Node process. The actual shipped
PreviewModule listens on a temporary loopback port for requests
and is stopped before continuing; this is diagnostic HTTP
execution, not a browser preview or a server for presenting a
visual. Output is under the disposable environment. The probe
copies built adapter files, links their existing locked workspace
dependencies, and binds Astro to the chosen environment. It does
not modify the copied production code or replace its App.

The probe records outcomes, including negative results;
successful completion alone does not mean all semantics agree.
Inspect each `build`, `kind`, `status`, `body`, `calls`, `loads`,
`error` and `preview`. A rejection has no invented HTTP status.
The report's table is a bounded interpretation of those fields.
The observer asserts actual SSR Astro module resolution, rather
than trusting just the version of the build API that was loaded.

## Archived source

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [repo, environment, expectedVersion] = process.argv
  .slice(2)
  .map((x, i) => (i < 2 ? resolve(x) : x));
const envRequire = createRequire(join(environment, "package.json"));
const repoRequire = createRequire(join(repo, "packages/adapter/package.json"));
const astroVersion = envRequire("astro/package.json").version;
assert.equal(astroVersion, expectedVersion);
const { passthroughImageService } = await import(
  pathToFileURL(envRequire.resolve("astro/config"))
);
const { build } = await import(pathToFileURL(envRequire.resolve("astro")));
const put = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};
const adapterHome = join(environment, "adapter");
await cp(join(repo, "packages/adapter/dist"), join(adapterHome, "dist"), {
  recursive: true,
});
const adapterPackage = JSON.parse(
  await readFile(join(repo, "packages/adapter/package.json")),
);
await put(join(adapterHome, "package.json"), JSON.stringify(adapterPackage));
await mkdir(join(adapterHome, "node_modules"), { recursive: true });
for (const name of [...Object.keys(adapterPackage.dependencies), "astro"]) {
  const source =
    name === "astro"
      ? dirname(envRequire.resolve("astro/package.json"))
      : await realpath(join(repo, "packages/adapter/node_modules", name));
  await mkdir(dirname(join(adapterHome, "node_modules", name)), {
    recursive: true,
  });
  await symlink(source, join(adapterHome, "node_modules", name), "dir").catch(
    (e) => {
      if (e.code !== "EEXIST") throw e;
    },
  );
}
const { default: adapter } = await import(
  pathToFileURL(join(adapterHome, "dist/index.js"))
);
const sources = {};
function endpoint(name) {
  return `globalThis.contractLoads?.push('${name}');
export async function GET(ctx) {globalThis.contractCalls?.push('${name}:'+ctx.url.pathname);
if('${name}'!=='REST_ONLY'&&ctx.url.searchParams.has('throw'))throw new Error('CONTRACT_THROW_${name}');
if(ctx.url.searchParams.has('own404'))return new Response('OWN_404',{status:404});
const target=ctx.url.searchParams.get('to'); if(target)return ctx.rewrite(target);
return new Response('${name}|'+ctx.url.pathname+'|'+JSON.stringify(ctx.params)+'|'+(ctx.locals.trace??''));}`;
}
function page(name, custom = "") {
  return `---
${custom}
globalThis.contractCalls?.push('${name}:'+Astro.url.pathname);
if('${name}'!=='CUSTOM500'&&Astro.url.searchParams.has('throw'))throw new Error('CONTRACT_THROW_${name}');
const target=Astro.url.searchParams.get('to');if(target)return Astro.rewrite(target);
---
<html><body>${name}|{Astro.url.pathname}|{Astro.locals.trace??''}</body></html>`;
}
const cases = [
  { name: "plain", base: "/", rest: false, custom: false },
  { name: "rest", base: "/", rest: true, custom: false },
  { name: "custom", base: "/", rest: true, custom: true },
  { name: "nested", base: "/nested/", rest: true, custom: true },
  { name: "scoped", base: "/nested/", rest: false, custom: true },
  { name: "direct", base: "/nested/", rest: true, custom: false, direct: true },
];
const result = {
  base: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  astro: astroVersion,
  vite: envRequire("vite/package.json").version,
  environment,
  repo,
  scenarios: [],
};
const context = {
  functionFolderId: "probe",
  functionName: "probe",
  functionVersion: "probe",
  memoryLimitInMB: "128",
  requestId: "probe",
  getPayload: () => undefined,
  getRemainingTimeInMillis: () => 30000,
};
const eventSource = `const context=${JSON.stringify(context)}; context.getPayload=()=>undefined;context.getRemainingTimeInMillis=()=>30000;
function event(path,direct,parameter) {const url=new URL(path,'https://contract.example');return {httpMethod:'GET',path:direct?'/provider-id':url.pathname,url:direct?'/provider-id':url.pathname,headers:{host:'contract.example'},queryStringParameters:direct?{[parameter]:path}:Object.fromEntries(url.searchParams),rawQueryString:direct?new URLSearchParams({[parameter]:path}).toString():url.search.slice(1),requestContext:{identity:{sourceIp:'192.0.2.1'}},body:'',isBase64Encoded:false};}`;
for (const scenario of cases) {
  const record = { ...scenario, builds: [] };
  result.scenarios.push(record);
  const root = join(environment, "fixtures", scenario.name);
  await mkdir(root, { recursive: true });
  await symlink(
    join(environment, "node_modules"),
    join(root, "node_modules"),
    "dir",
  ).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  await put(join(root, "package.json"), '{"private":true,"type":"module"}');
  const files = {
    "ep.ts": endpoint("EP_ONLY"),
    "target.ts": endpoint("TARGET_ONLY"),
  };
  if (!scenario.direct) {
    files["page.astro"] = page("PAGE_ONLY");
    files["other.astro"] = page("OTHER_ONLY");
  }
  if (scenario.rest) files["[...rest].ts"] = endpoint("REST_ONLY");
  if (scenario.custom) {
    files["404.astro"] = page("CUSTOM404", "export const prerender=true;");
    files["500.astro"] = page("CUSTOM500");
  }
  files["../middleware.ts"] =
    `export const onRequest=async(ctx,next)=>{ctx.locals.trace=(ctx.locals.trace??'')+'>'+ctx.url.pathname;const target=ctx.url.searchParams.get('mw');return target?ctx.rewrite(target):next();};`;
  for (const [file, source] of Object.entries(files)) {
    await put(join(root, "src/pages", file), source);
    sources[scenario.name + "/" + file] = source;
  }
  await put(
    join(root, "seed.mjs"),
    `import {createApp}from'astro/app/entrypoint';export const app=createApp({streaming:false});`,
  );
  for (const mode of ["reference", "shared", "separate"]) {
    const out = join(root, "out-" + mode);
    const item = { mode, out };
    record.builds.push(item);
    item.astroModules = [];
    const observer = {
      name: "contract-observer",
      hooks: {
        "astro:build:setup"({ target, updateConfig }) {
          if (target !== "server") return;
          updateConfig({
            plugins: [
              {
                name: "contract-observer",
                applyToEnvironment: (env) => env.name === "ssr",
                generateBundle(_, bundle) {
                  item.astroModules = [
                    ...new Set(
                      Object.values(bundle)
                        .filter((c) => c.type === "chunk")
                        .flatMap((c) => c.moduleIds)
                        .filter((id) => id.includes("/astro/dist/core/")),
                    ),
                  ].sort();
                },
              },
            ],
          });
        },
      },
    };
    const options = {
      target: "object-storage-functions",
      apiGateway: !scenario.direct,
      functions: mode === "reference" ? "shared" : mode,
    };
    // Root fixture config makes the real preview module discover the same adapter.
    await put(
      join(root, "astro.config.mjs"),
      `import adapter from ${JSON.stringify(pathToFileURL(join(adapterHome, "dist/index.js")).href)};export default {output:'server',base:${JSON.stringify(scenario.base)},adapter:adapter(${JSON.stringify(options)})};`,
    );
    const referenceAdapter = {
      name: "contract-full-reference",
      hooks: {
        "astro:config:done"({ setAdapter }) {
          setAdapter({
            name: "contract-full-reference",
            entrypointResolution: "auto",
            serverEntrypoint: join(root, "seed.mjs"),
            supportedAstroFeatures: {
              staticOutput: "stable",
              serverOutput: "stable",
              hybridOutput: "stable",
            },
          });
        },
      },
    };
    try {
      await build({
        root,
        configFile: mode === "reference" ? false : undefined,
        outDir: out,
        base: scenario.base,
        output: "server",
        image: { service: passthroughImageService() },
        logLevel: "silent",
        integrations: [observer],
        adapter: mode === "reference" ? referenceAdapter : adapter(options),
        ...(mode === "reference"
          ? {
              vite: { ssr: { noExternal: true } },
              build: { serverEntry: "seed.mjs" },
            }
          : {}),
      });
      item.build = "ok";
      assert.ok(item.astroModules.some((id) => id.includes("/core/app/")));
      assert.ok(
        item.astroModules.every((id) =>
          id.includes("astro@" + expectedVersion + "_"),
        ),
        "Unexpected Astro resolution: " + item.astroModules.join(","),
      );
    } catch (e) {
      console.log(
        scenario.name,
        mode,
        "BUILD_REJECTED",
        e.message,
        e.cause?.message,
      );
      item.build = "rejected";
      item.error = {
        name: e.name,
        message: e.message,
        cause: e.cause?.message,
      };
      continue;
    }
    const manifest =
      mode === "reference"
        ? null
        : JSON.parse(await readFile(join(out, "yandex-cloud.json"), "utf8"));
    item.manifest = manifest;
    if (manifest)
      item.gateway = await readFile(
        join(out, "yandex-api-gateway.json"),
        "utf8",
      ).catch(() => null);
    const prefix =
      scenario.base === "/" ? "" : scenario.base.replace(/\/$/, "");
    const checks = [];
    for (const route of [
      "ep",
      ...(!scenario.direct ? ["page"] : []),
      "target",
      ...(scenario.rest ? ["anything"] : []),
    ]) {
      const path = prefix + "/" + route;
      checks.push({ id: route, path, owner: path });
      if (route === "ep" || route === "page")
        for (const [id, suffix] of [
          ["own404", "?own404=1"],
          ["same", "?to=/" + route],
          ["other", "?to=/target"],
          ["missing", "?to=/absent"],
          ["throw", "?throw=1"],
          ["mw-same", "?mw=/" + route],
          ["mw-other", "?mw=/target"],
          ["mw-missing", "?mw=/absent"],
          ...(prefix ? [["prefixed", "?to=" + prefix + "/target"]] : []),
        ])
          checks.push({
            id: route + "-" + id,
            path: path + suffix,
            owner: path,
          });
    }
    if (scenario.custom)
      checks.push(
        { id: "404", path: prefix + "/404", owner: prefix + "/page" },
        { id: "500", path: prefix + "/500", owner: prefix + "/500" },
      );
    if (scenario.rest)
      checks.push({
        id: "foreign-specific-on-rest",
        path: prefix + "/ep",
        owner: prefix + "/[...rest]",
      });
    checks.push({
      id: "unmatched",
      path: prefix + "/absent",
      owner: prefix + (scenario.direct ? "/ep" : "/page"),
    });
    item.responses = [];
    for (const check of checks) {
      let entry;
      if (mode === "reference") entry = join(out, "server/seed.mjs");
      else {
        const route =
          manifest.routes.onDemand.find((r) => r.pattern === check.owner) ??
          manifest.routes.onDemand.find(
            (r) => r.pattern === prefix + "/[...rest]",
          );
        const artifact = manifest.artifacts.functions.find(
          (a) => a.id === route?.artifactId,
        );
        assert.ok(artifact, check.owner);
        entry = join(out, artifact.path, "index.js");
      }
      const source = `globalThis.contractLoads=[];globalThis.contractCalls=[];${eventSource}
let outcome;try {const entry=await import(${JSON.stringify(pathToFileURL(entry).href)});let response;
${mode === "reference" ? `const req=new Request('https://contract.example'+${JSON.stringify(check.path)});const matched=entry.app.match(req)?.route;const r=await entry.app.render(req);response={kind:'http',status:r.status,body:await r.text(),matched};` : `const r=await entry.handler(event(${JSON.stringify(check.path)},${!!scenario.direct},${JSON.stringify(manifest?.directInvocation?.requestTargetParameter)}),context);response={kind:'http',status:r.statusCode,body:r.isBase64Encoded?Buffer.from(r.body,'base64').toString():r.body};`}
outcome=response;}catch(e){outcome={kind:'rejection',error:{name:e.name,message:e.message,cause:e.cause?.message}};}console.log('CONTRACT_RESULT:'+JSON.stringify({...outcome,loads:globalThis.contractLoads,calls:globalThis.contractCalls}));`;
      const child = join(root, "runner.mjs");
      await put(child, source);
      const output = execFileSync(process.execPath, [child], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10e6,
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const observed = JSON.parse(output.split("CONTRACT_RESULT:").at(-1));
      item.responses.push({ ...check, ...observed });
    }
    if (mode !== "reference") {
      // Exercise the actual PreviewModule: listen only while disposable checks run.
      const { default: preview } = await import(
        pathToFileURL(join(adapterHome, "dist/preview.js"))
      );
      const config = {
        client: pathToFileURL(join(out, "client/")),
        serverEntrypoint: pathToFileURL(join(out, "function/index.js")),
        base: scenario.base,
        host: "127.0.0.1",
        port: 0,
        headers: {},
        logger: { error: () => {} },
      };
      const server = await preview(config);
      item.preview = [];
      try {
        for (const check of checks.filter((c) =>
          [
            "ep",
            "page",
            "ep-other",
            "page-other",
            "ep-throw",
            "page-throw",
            "404",
            "unmatched",
          ].includes(c.id),
        )) {
          const r = await fetch("http://127.0.0.1:" + server.port + check.path);
          item.preview.push({
            ...check,
            status: r.status,
            body: await r.text(),
          });
        }
      } finally {
        await server.stop();
        await server.closed();
      }
      item.inventories = [];
      for (const artifact of manifest.artifacts.functions) {
        const path = join(out, artifact.path);
        const inventory = [];
        for (const name of await readdir(path, { recursive: true })) {
          try {
            const bytes = await readFile(join(path, name));
            inventory.push({
              file: name,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              markers: [
                "EP_ONLY",
                "TARGET_ONLY",
                "PAGE_ONLY",
                "OTHER_ONLY",
                "REST_ONLY",
                "CUSTOM500",
              ].filter((s) => bytes.includes(s)),
            });
          } catch (e) {
            if (e.code !== "EISDIR") throw e;
          }
        }
        item.inventories.push({ id: artifact.id, files: inventory });
      }
    }
    await put(
      join(environment, "partial-results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      scenario.name,
      mode,
      item.responses
        .map((r) => r.id + ":" + (r.kind === "http" ? r.status : r.kind))
        .join(" "),
    );
  }
}
result.sources = sources;
result.environmentLock = await readFile(
  join(environment, "pnpm-lock.yaml"),
  "utf8",
);
result.repositoryLockSha256 = createHash("sha256")
  .update(await readFile(join(repo, "pnpm-lock.yaml")))
  .digest("hex");
result.sourceSha256 = createHash("sha256")
  .update(await readFile(process.argv[1]))
  .digest("hex");
await put(
  join(environment, "results.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log("RESULTS", join(environment, "results.json"));
```
