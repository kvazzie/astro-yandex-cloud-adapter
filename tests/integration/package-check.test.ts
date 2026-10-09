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
let npmExecutable: string;
const sourceCommit = "a".repeat(40);

/** Model npm's already-verified SLSA v1 output for a publication source. */
function verifiedProvenance({
  repository = "https://github.com/kvazzie/astro-yandex-cloud-adapter",
  path = ".github/workflows/release.yml",
  commit = sourceCommit,
  dependencyRepository = repository,
  ref = "refs/heads/main",
}: {
  repository?: string;
  path?: string;
  commit?: string;
  dependencyRepository?: string;
  ref?: string;
} = {}) {
  const predicateType = "https://slsa.dev/provenance/v1";
  const statement = {
    predicateType,
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository, path, ref } },
        resolvedDependencies: [
          {
            uri: `git+${dependencyRepository}@${ref}`,
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  return {
    name: "@astro-yandex-cloud/adapter",
    version: "0.0.0-package-check",
    attestations: { provenance: { predicateType } },
    attestationBundles: [
      {
        predicateType,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  };
}

beforeAll(async () => {
  npmExecutable = (await run("which", ["npm"])).stdout.trim();
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
  {
    title: "provenance from another repository",
    provenance: verifiedProvenance({
      repository: "https://github.com/unapproved/repository",
    }),
    message: "Verified provenance does not match",
  },
  {
    title: "provenance from another workflow",
    provenance: verifiedProvenance({ path: ".github/workflows/unapproved.yml" }),
    message: "Verified provenance does not match",
  },
  {
    title: "provenance from another commit",
    provenance: verifiedProvenance({ commit: "b".repeat(40) }),
    message: "Verified provenance does not match",
  },
  {
    title: "a commit from a different dependency repository",
    provenance: verifiedProvenance({
      dependencyRepository: "https://github.com/unapproved/repository",
    }),
    message: "Verified provenance does not match",
  },
  {
    title: "provenance from another ref",
    provenance: verifiedProvenance({ ref: "refs/heads/unapproved" }),
    message: "Verified provenance does not match",
  },
  {
    title: "missing verified provenance bundles",
    provenance: { ...verifiedProvenance(), attestationBundles: [] },
    message: "Verified provenance does not match",
  },
  {
    title: "unsupported provenance format",
    provenance: {
      ...verifiedProvenance(),
      attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v0.2" }],
    },
    message: "Verified provenance does not match",
  },
  {
    title: "an approved publication source",
    provenance: verifiedProvenance(),
    succeeds: true,
    message: "",
  },
])(
  "checks $title before trusting a registry installation",
  async ({ integrity, provenance, succeeds, message }) => {
    const bin = await mkdtemp(join(root, "registry-command-"));
    const expectedIntegrity = `sha512-${createHash("sha512")
      .update(await readFile(candidate))
      .digest("base64")}`;
    const fakeNpm = join(bin, "npm");
    await writeFile(
      fakeNpm,
      `#!${process.execPath}
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
/** Forward the fake npm process to the real CLI for commands outside this fixture. */
function forward() {
  const result = spawnSync(${JSON.stringify(npmExecutable)}, args, { stdio: "inherit" });
  assert.equal(result.status, 0);
}
if (args[0] === "install") {
  assert(args.includes("--registry=https://registry.npmjs.org"));
  let lock;
  if (${String(succeeds ?? false)}) {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    pkg.dependencies["@astro-yandex-cloud/adapter"] = "file:./candidate.tgz";
    await writeFile("package.json", JSON.stringify(pkg));
    forward();
    lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    lock.packages["node_modules/@astro-yandex-cloud/adapter"].integrity = ${JSON.stringify(expectedIntegrity)};
  } else lock = { packages: {
    "node_modules/@astro-yandex-cloud/adapter": {
      version: "0.0.0-package-check", integrity: ${JSON.stringify(integrity ?? expectedIntegrity)}
    }
  } };
  await writeFile("package-lock.json", JSON.stringify(lock));
} else if (args[0] === "audit") {
  assert.deepEqual(args, ["audit", "signatures", "--json", "--include-attestations", "--registry=https://registry.npmjs.org"]);
  console.log(JSON.stringify({ invalid: [], missing: [], verified: ${JSON.stringify(provenance ? [provenance] : [])} }));
} else forward();
`,
    );
    await chmod(fakeNpm, 0o755);
    const report = join(bin, "registry-validation.json");
    await writeFile(report, '{"stale":true}');
    const check = run(
      process.execPath,
      [
        checker,
        candidate,
        "--registry",
        "--source-commit",
        sourceCommit,
        "--report",
        report,
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    if (succeeds) {
      await check;
      expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
        sourceCommit,
        checks: [
          "exports",
          "manifest-contract",
          "object-storage:/",
          "object-storage:/docs",
          "object-storage-functions:static:/docs",
          "object-storage-functions:bundle:/docs",
          "object-storage-functions:install:/docs",
        ],
      });
    } else {
      await expect(check).rejects.toThrow(message);
      await expect(readFile(report)).rejects.toHaveProperty("code", "ENOENT");
    }
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
        "manifest-contract",
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

/** Repack a private copy after applying the corruption required by a rejection case. */
async function brokenCandidate(change: (directory: string) => Promise<void>) {
  const staging = await mkdtemp(join(root, "broken-"));
  await cp(join(root, "package"), join(staging, "package"), { recursive: true });
  await change(join(staging, "package"));
  const tarball = join(staging, "candidate.tgz");
  await run("tar", ["-czf", tarball, "-C", staging, "package"]);
  return tarball;
}

it("rejects a candidate requiring support claims in its Manifest schema", async () => {
  const tarball = await brokenCandidate(async (directory) => {
    const path = join(directory, "dist/deployment-manifest.schema.json");
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      properties: {
        artifacts: {
          properties: { functions: { items: { required: string[] } } };
        };
      };
    };
    schema.properties.artifacts.properties.functions.items.required.push(
      "support",
    );
    await writeFile(path, JSON.stringify(schema));
  });
  await expect(
    run(process.execPath, [checker, tarball], {
      timeout: 300_000,
      maxBuffer: 10_000_000,
    }),
  ).rejects.toThrow("must have required property 'support'");
}, 300_000);

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
