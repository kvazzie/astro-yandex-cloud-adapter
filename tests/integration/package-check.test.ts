import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
const checker = resolve("scripts/validate-pack.mjs");
let root: string;
let candidate: string;
let astroVersion: string;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  astroVersion = (
    JSON.parse(await readFile(require.resolve("astro/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  root = await mkdtemp(join(tmpdir(), "adapter-package-check-test-"));
  const { stdout } = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
    { cwd: resolve("packages/adapter") },
  );
  const [{ filename }] = JSON.parse(stdout) as [{ filename: string }];
  await run("tar", ["-xzf", join(root, filename), "-C", root]);
  const manifestPath = join(root, "package/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string;
  };
  // The candidate must supply version metadata, even when the workspace differs.
  manifest.version = "0.0.0-package-check";
  await writeFile(manifestPath, JSON.stringify(manifest));
  candidate = join(root, "explicit-candidate.tgz");
  await run("tar", ["-czf", candidate, "-C", root, "package"]);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("requires an explicit candidate tarball", async () => {
  await expect(run(process.execPath, [checker])).rejects.toMatchObject({
    stderr: expect.stringContaining("Usage:") as unknown,
  });
});

it.each([
  {
    title: "different installed registry bytes",
    integrity: "sha512-wrong",
    message: "The registry installation differs",
  },
  {
    title: "missing verified registry provenance",
    message: "npm did not verify provenance",
  },
])(
  "rejects $title before trusting a registry installation",
  async ({ integrity, message }) => {
    const bin = await mkdtemp(join(root, "registry-command-"));
    const expectedIntegrity = `sha512-${createHash("sha512")
      .update(await readFile(candidate))
      .digest("base64")}`;
    const fakeNpm = join(bin, "npm");
    await writeFile(
      fakeNpm,
      `#!${process.execPath}
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "install") {
  assert(args.includes("--registry=https://registry.npmjs.org"));
  await writeFile("package-lock.json", JSON.stringify({ packages: {
    "node_modules/@astro-yandex-cloud/adapter": {
      version: "0.0.0-package-check", integrity: ${JSON.stringify(integrity ?? expectedIntegrity)}
    }
  } }));
} else {
  assert.deepEqual(args, ["audit", "signatures", "--json", "--include-attestations", "--registry=https://registry.npmjs.org"]);
  console.log(JSON.stringify({ invalid: [], missing: [], verified: [] }));
}
`,
    );
    await chmod(fakeNpm, 0o755);
    const report = join(bin, "registry-validation.json");
    await writeFile(report, '{"stale":true}');
    await expect(
      run(
        process.execPath,
        [checker, candidate, "--registry", "--report", report],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        },
      ),
    ).rejects.toThrow(message);
    await expect(readFile(report)).rejects.toHaveProperty("code", "ENOENT");
  },
);

it.each(["minimum", "workspace"])(
  "checks the candidate against %s Astro in clean applications and records the bytes that passed",
  async (version) => {
    const report = join(root, `validation-${version}.json`);
    await run(
      process.execPath,
      [
        checker,
        candidate,
        "--report",
        report,
        "--astro-version",
        version === "minimum" ? "7.1.0" : astroVersion,
      ],
      {
        timeout: 300_000,
        maxBuffer: 10_000_000,
        env: { ...process.env, _: "/home/package-check-caller/node" },
      },
    );
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      name: "@astro-yandex-cloud/adapter",
      version: "0.0.0-package-check",
      tarball: candidate,
      sha512: createHash("sha512")
        .update(await readFile(candidate))
        .digest("hex"),
      checks: [
        "exports",
        "object-storage:/",
        "object-storage:/docs",
        "object-storage-functions:static:/docs",
        "object-storage-functions:bundle:/docs",
        "object-storage-functions:install:/docs",
      ],
    });
  },
  300_000,
);

async function brokenCandidate(change: (directory: string) => Promise<void>) {
  const staging = await mkdtemp(join(root, "broken-"));
  await cp(join(root, "package"), join(staging, "package"), { recursive: true });
  await change(join(staging, "package"));
  const tarball = join(staging, "candidate.tgz");
  await run("tar", ["-czf", tarball, "-C", staging, "package"]);
  return tarball;
}

it.each(["preview.js", "index.d.ts", "deployment-manifest.schema.json"])(
  "rejects a candidate missing %s and removes stale success evidence",
  async (file) => {
    const tarball = await brokenCandidate((directory) =>
      rm(join(directory, "dist", file)),
    );
    const report = `${tarball}.validation.json`;
    await writeFile(report, '{"passed":true}');
    await expect(run(process.execPath, [checker, tarball])).rejects.toThrow(
      `Missing packed file: ./dist/${file}`,
    );
    await expect(readFile(report)).rejects.toHaveProperty("code", "ENOENT");
  },
);

it("rejects an undeclared dependency even when the clean app installs it", async () => {
  const tarball = await brokenCandidate((directory) =>
    appendFile(join(directory, "dist/index.js"), '\nimport "nanoid";\n'),
  );
  await expect(
    run(process.execPath, [checker, tarball], {
      timeout: 300_000,
      maxBuffer: 10_000_000,
    }),
  ).rejects.toThrow("Undeclared packed dependency: nanoid");
}, 300_000);

it("rejects a missing declaration imported by a public type entrypoint", async () => {
  const tarball = await brokenCandidate(async (directory) => {
    const chunk = (await readdir(join(directory, "dist"))).find((file) =>
      /^runtime-.+\.d\.ts$/.test(file),
    );
    expect(chunk).toBeDefined();
    await rm(join(directory, "dist", chunk!));
  });
  await expect(
    run(process.execPath, [checker, tarball], {
      timeout: 300_000,
      maxBuffer: 10_000_000,
    }),
  ).rejects.toThrow("Cannot find module './runtime-");
}, 300_000);
