import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const name = "@astro-yandex-cloud/adapter";
const version = "0.1.0-beta.1";
const sourceCommit = "a".repeat(40);
const bytes = Buffer.from("the approved publication candidate");
const sha512 = createHash("sha512").update(bytes).digest("hex");
const metadata = {
  name,
  version,
  "dist-tags": { beta: version },
  dist: {
    integrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    attestations: {
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};

async function scenario(
  change: { metadata?: unknown; bytes?: string; validationFails?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "adapter-registry-check-"));
  const report = join(root, "report.json");
  const candidate = join(root, "candidate.json");
  await writeFile(candidate, JSON.stringify({ name, version, sha512 }));
  await writeFile(report, '{"stale":true}');
  await writeFile(
    join(root, "metadata.json"),
    JSON.stringify(change.metadata ?? metadata),
  );
  await writeFile(join(root, "candidate.tgz"), change.bytes ?? bytes);
  // Substitute only external registry responses and the separately tested clean-app checker.
  await cp(
    resolve("scripts/verify-registry.mjs"),
    join(root, "verify-registry.mjs"),
  );
  const commands = `#!${process.execPath}
import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
assert.equal(process.env.NPM_TOKEN, undefined);
const args = process.argv.slice(2);
assert(args.includes("https://registry.npmjs.org"));
assert(args.includes(${JSON.stringify(`${name}@${version}`)}));
if (basename(process.argv[1]) === "pnpm") {
  assert.equal(args[0], "view");
  console.log(await readFile(join(process.env.FIXTURE_ROOT, "metadata.json"), "utf8"));
} else {
  assert.equal(args[0], "pack");
  assert(args.includes("--ignore-scripts"));
  await copyFile(join(process.env.FIXTURE_ROOT, "candidate.tgz"), "download.tgz");
  console.log(JSON.stringify([{ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, filename: "download.tgz" }]));
}
`;
  for (const command of ["pnpm", "npm"]) {
    await writeFile(join(root, command), commands);
    await chmod(join(root, command), 0o755);
  }
  await writeFile(
    join(root, "validate-pack.mjs"),
    `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
assert(process.argv.includes("--registry"));
assert.equal(process.argv[process.argv.indexOf("--source-commit") + 1], ${JSON.stringify(sourceCommit)});
if (${String(change.validationFails ?? false)}) throw new Error("Consumer preview failed");
await writeFile(process.argv[process.argv.indexOf("--report") + 1], JSON.stringify({
  name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, sha512: ${JSON.stringify(sha512)}, sourceCommit: ${JSON.stringify(sourceCommit)},
  tarball: process.argv[2], checks: ["exports", "object-storage:/", "object-storage-functions:bundle:/docs"],
  provenance: { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} }
}));
`,
  );
  return {
    report,
    candidate,
    check: (commit: string | null = sourceCommit) =>
      run(
        process.execPath,
        [
          join(root, "verify-registry.mjs"),
          "--candidate-report",
          candidate,
          "--report",
          report,
          ...(commit ? ["--source-commit", commit] : []),
        ],
        {
          env: {
            ...process.env,
            FIXTURE_ROOT: root,
            PATH: `${root}:${process.env.PATH ?? ""}`,
            NODE_AUTH_TOKEN: "must-not-reach-registry-commands",
            NPM_TOKEN: "must-not-reach-registry-commands",
          },
        },
      ),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("records registry identity, tags, provenance and clean-application results for the publication bytes", async () => {
  const fixture = await scenario();
  try {
    await fixture.check();
    const report = JSON.parse(await readFile(fixture.report, "utf8")) as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({
      name,
      version,
      sha512,
      sourceCommit,
      registry: "https://registry.npmjs.org",
      distTags: { beta: version },
      checks: [
        "exports",
        "object-storage:/",
        "object-storage-functions:bundle:/docs",
      ],
      provenance: { name, version },
    });
    expect(report).not.toHaveProperty("tarball");
    expect(report).toHaveProperty("verifiedAt");
    expect(JSON.parse(await readFile(fixture.candidate, "utf8"))).toEqual({
      name,
      version,
      sha512,
    });
  } finally {
    await fixture.cleanup();
  }
});

it.each([null, "abc123"])(
  "requires a full approved source commit (%s)",
  async (commit) => {
    const fixture = await scenario();
    try {
      await expect(fixture.check(commit)).rejects.toThrow(
        "requires the full approved --source-commit SHA",
      );
      await expect(readFile(fixture.report)).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

it.each([
  {
    title: "a wrong beta tag",
    metadata: { ...metadata, "dist-tags": { beta: "0.1.0-beta.2" } },
    message: "The beta tag must select this candidate",
  },
  {
    title: "publication under latest",
    metadata: { ...metadata, "dist-tags": { beta: version, latest: version } },
    message: "A beta must not use latest",
  },
  {
    title: "a wrong registry version",
    metadata: { ...metadata, version: "0.1.0-beta.2" },
    message: "0.1.0-beta.2",
  },
  {
    title: "a different registry integrity",
    metadata: {
      ...metadata,
      dist: { ...metadata.dist, integrity: "sha512-wrong" },
    },
    message: "Registry integrity differs",
  },
  {
    title: "missing provenance",
    metadata: { ...metadata, dist: { integrity: metadata.dist.integrity } },
    message: "The registry must advertise provenance",
  },
  {
    title: "different downloaded bytes",
    bytes: "another archive",
    message: "Registry bytes differ",
  },
  {
    title: "a failing consumer",
    validationFails: true,
    message: "Consumer preview failed",
  },
])(
  "rejects $title and removes stale success evidence",
  async ({ message, ...change }) => {
    const fixture = await scenario(change);
    try {
      await expect(fixture.check()).rejects.toThrow(message);
      await expect(readFile(fixture.report)).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);
