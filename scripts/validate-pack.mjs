import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const artifacts = resolve(".artifacts");
const tarball = (await readdir(artifacts)).find((file) => file.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack did not create a tarball.");

const expectedEntrypoints = [
  "index.js",
  "index.d.ts",
  "runtime.js",
  "runtime.d.ts",
];
for (const entrypoint of expectedEntrypoints) {
  await access(resolve("packages/adapter/dist", entrypoint));
}

const tarballPath = resolve(artifacts, tarball);
const { stdout: listing } = await execFileAsync("tar", ["-tf", tarballPath]);
for (const entrypoint of expectedEntrypoints) {
  if (!listing.split("\n").includes(`package/dist/${entrypoint}`)) {
    throw new Error(`Packed tarball is missing dist/${entrypoint}.`);
  }
}

const adapter = await import(
  pathToFileURL(resolve("packages/adapter/dist/index.js")).href
);
const runtime = await import(
  pathToFileURL(resolve("packages/adapter/dist/runtime.js")).href
);
if (
  typeof adapter.default !== "function" ||
  typeof runtime.toWebRequest !== "function"
) {
  throw new Error("Published JavaScript exports are invalid.");
}

stdout.write(`Validated ${tarball} and package exports.\n`);
