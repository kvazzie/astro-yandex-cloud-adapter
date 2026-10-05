import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    report: { type: "string" },
    "astro-version": { type: "string", default: "7.1.0" },
  },
});
if (positionals.length !== 1) {
  throw new Error(
    "Usage: node scripts/validate-pack.mjs <tarball> [--report <json>] [--astro-version <version>]",
  );
}

const tarball = resolve(positionals[0]);
const report = resolve(values.report ?? `${tarball}.validation.json`);
assert.notEqual(report, tarball, "The report must not overwrite the candidate.");
await rm(report, { force: true });
const bytes = await readFile(tarball);
const sha512 = createHash("sha512").update(bytes).digest("hex");
const root = await mkdtemp(join(tmpdir(), "astro-yandex-packed-"));
// Never inherit module-resolution hooks or workspace NODE_PATH from the caller.
const env = { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: "1" };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

async function command(file, args, commandEnv = env) {
  try {
    return await run(file, args, {
      cwd: root,
      env: commandEnv,
      timeout: 300_000,
      maxBuffer: 10_000_000,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
}

try {
  // Install a private snapshot so replacing the source archive cannot change inputs.
  const snapshot = join(root, "candidate.tgz");
  await writeFile(snapshot, bytes);
  const { stdout: manifestSource } = await command("tar", [
    "-xOf",
    snapshot,
    "package/package.json",
  ]);
  const candidate = JSON.parse(manifestSource);
  assert.equal(candidate.name, "@astro-yandex-cloud/adapter");
  const { stdout: listing } = await command("tar", ["-tf", snapshot]);
  const files = new Set(listing.trim().split("\n"));
  function packedFile(path) {
    assert(
      files.has(`package/${path.replace(/^\.\//, "")}`),
      `Missing packed file: ${path}`,
    );
  }
  function entryFiles(entry) {
    if (typeof entry === "string") packedFile(entry);
    else for (const value of Object.values(entry)) entryFiles(value);
  }
  for (const entry of Object.values(candidate.exports)) entryFiles(entry);
  packedFile("dist/server.js");

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [candidate.name]: "file:./candidate.tgz",
        astro: values["astro-version"],
        typescript: "5.9.3",
        "@types/node": "22.19.7",
        ajv: "8.20.0",
        nanoid: "3.3.17",
      },
      // Astro's transitive unifont update requires a newer Node than our minimum.
      overrides: { unifont: "0.7.4" },
    }),
  );
  // No hoisting: adapter imports cannot borrow its dependencies' dependencies.
  await command("npm", [
    "install",
    "--install-strategy=nested",
    "--engine-strict",
    "--no-audit",
    "--no-fund",
  ]);
  await cp(
    join(import.meta.dirname, "package-check/verify.mjs"),
    join(root, "verify.mjs"),
  );
  for (const fixture of ["static", "actions"]) {
    for (const directory of ["src", "public"]) {
      await cp(
        join(import.meta.dirname, "../tests/fixtures", fixture, directory),
        join(root, "fixtures", fixture, directory),
        { recursive: true },
      );
    }
  }
  // The build is reproducible and cannot inline the caller's shell variables.
  const { stdout } = await command(process.execPath, [join(root, "verify.mjs")], {
    PATH: env.PATH,
    SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  });
  process.stdout.write(stdout);
  const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  assert.equal(
    createHash("sha512")
      .update(await readFile(tarball))
      .digest("hex"),
    sha512,
    "The candidate changed during validation.",
  );
  await writeFile(
    report,
    `${JSON.stringify(
      {
        name: candidate.name,
        version: candidate.version,
        tarball,
        sha512,
        size: bytes.length,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `Validated ${candidate.name}@${candidate.version}; identity recorded in ${report}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
