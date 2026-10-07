import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const name = "@astro-yandex-cloud/adapter";
const registry = "https://registry.npmjs.org";
const { values } = parseArgs({
  options: {
    "candidate-report": { type: "string" },
    report: { type: "string", default: ".artifacts/registry-check.json" },
  },
});
assert(
  values["candidate-report"],
  "Usage: node scripts/verify-registry.mjs --candidate-report <publication package-check.json> [--report <json>]",
);
const candidatePath = resolve(values["candidate-report"]);
const report = resolve(values.report);
assert.notEqual(
  report,
  candidatePath,
  "The registry report must not overwrite publication evidence.",
);
await rm(report, { force: true });
const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
assert.equal(candidate.name, name);
assert.match(candidate.version, /^0\.1\.0-beta\.[1-9]\d*$/);
assert.match(candidate.sha512, /^[a-f0-9]{128}$/);
const integrity = `sha512-${Buffer.from(candidate.sha512, "hex").toString("base64")}`;
const spec = `${name}@${candidate.version}`;
const root = await mkdtemp(join(tmpdir(), "astro-yandex-registry-"));
// Public registry verification needs no publication credential or module hooks.
const env = { ...process.env };
delete env.NODE_AUTH_TOKEN;
delete env.NPM_TOKEN;
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

async function command(file, args) {
  try {
    return await run(file, args, {
      cwd: root,
      env,
      timeout: 600_000,
      maxBuffer: 20_000_000,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
}

try {
  const { stdout: metadataSource } = await command("pnpm", [
    "view",
    spec,
    "name",
    "version",
    "dist",
    "dist-tags",
    "--json",
    "--registry",
    registry,
  ]);
  const metadata = JSON.parse(metadataSource);
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, candidate.version);
  assert.equal(
    metadata["dist-tags"].beta,
    candidate.version,
    "The beta tag must select this candidate.",
  );
  assert.notEqual(
    metadata["dist-tags"].latest,
    candidate.version,
    "A beta must not use latest.",
  );
  assert.equal(
    metadata.dist.integrity,
    integrity,
    "Registry integrity differs from the publication candidate.",
  );
  assert(
    metadata.dist.attestations?.provenance,
    "The registry must advertise provenance.",
  );
  const { stdout: packedSource } = await command("npm", [
    "pack",
    spec,
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    root,
    "--registry",
    registry,
  ]);
  const packed = JSON.parse(packedSource);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, name);
  assert.equal(packed[0].version, candidate.version);
  assert.equal(packed[0].filename, basename(packed[0].filename));
  const tarball = join(root, packed[0].filename);
  assert.equal(
    createHash("sha512")
      .update(await readFile(tarball))
      .digest("hex"),
    candidate.sha512,
    "Registry bytes differ from the publication candidate.",
  );
  const validationPath = join(root, "validation.json");
  const { stdout } = await command(process.execPath, [
    join(import.meta.dirname, "validate-pack.mjs"),
    tarball,
    "--report",
    validationPath,
    "--registry",
  ]);
  process.stdout.write(stdout);
  const validation = JSON.parse(await readFile(validationPath, "utf8"));
  assert.equal(validation.name, name);
  assert.equal(validation.version, candidate.version);
  assert.equal(validation.sha512, candidate.sha512);
  // The archive is temporary. Retain its identity and the clean-install results.
  delete validation.tarball;
  await mkdir(dirname(report), { recursive: true });
  await writeFile(
    report,
    `${JSON.stringify(
      {
        ...validation,
        verifiedAt: new Date().toISOString(),
        registry,
        distTags: metadata["dist-tags"],
        dist: metadata.dist,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `Verified ${spec} from npm; evidence recorded in ${report}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
