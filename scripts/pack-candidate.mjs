import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({
  options: { publish: { type: "boolean", default: false } },
});
const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages/adapter");
const pkg = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8"),
);

async function command(file, args, cwd = root) {
  try {
    const result = await run(file, args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 10_000_000,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result;
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
}

if (values.publish) {
  // Match Changesets' immutable-version behavior. Only E404 means unpublished.
  try {
    await run("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"], {
      cwd: root,
    });
    process.stdout.write(`${pkg.name}@${pkg.version} is already published.\n`);
    process.exit(0);
  } catch (error) {
    const response = JSON.parse(error.stdout);
    if (response.error?.code !== "E404") throw error;
  }
}

const artifacts = join(root, ".artifacts");
await mkdir(artifacts, { recursive: true });
const { stdout } = await command(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts],
  packageDirectory,
);
const packed = JSON.parse(stdout);
assert.equal(packed.length, 1);
const tarball = join(artifacts, packed[0].filename);
const report = join(artifacts, "package-check.json");
const require = createRequire(import.meta.url);
const astro = require("astro/package.json");
await command(process.execPath, [
  join(root, "scripts/validate-pack.mjs"),
  tarball,
  "--report",
  report,
  "--astro-version",
  astro.version,
]);
const identity = JSON.parse(await readFile(report, "utf8"));
assert.equal(identity.tarball, tarball);
assert.equal(identity.name, pkg.name);
assert.equal(identity.version, pkg.version);
assert.equal(
  identity.sha512,
  createHash("sha512")
    .update(await readFile(tarball))
    .digest("hex"),
  "Refusing to publish a candidate that changed after validation.",
);
const tag = pkg.version.includes("-")
  ? pkg.version.split("-")[1].split(".")[0]
  : "latest";
await command("npm", [
  "publish",
  tarball,
  "--ignore-scripts",
  "--access",
  "public",
  "--tag",
  tag,
  ...(values.publish ? ["--provenance"] : ["--dry-run", "--provenance=false"]),
]);
if (values.publish) {
  // Preserve the Changesets action's existing tag and GitHub release handling.
  await command("pnpm", ["changeset", "tag"]);
}
