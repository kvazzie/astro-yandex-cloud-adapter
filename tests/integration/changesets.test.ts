import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
const registries: ReturnType<typeof createServer>[] = [];
const name = "@astro-yandex-cloud/adapter";
const intent = (bump: string, summary = "Explain the package change.") =>
  `---\n"${name}": ${bump}\n---\n\n${summary}\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adapter-changesets-"));
  roots.push(root);
  const command = (file: string, args: string[]) =>
    run(file, args, { cwd: root, timeout: 120_000 });
  const git = (...args: string[]) =>
    command("git", [
      "-c",
      "user.name=Changeset test",
      "-c",
      "user.email=changeset@example.test",
      ...args,
    ]);
  const write = async (file: string, text: string) => {
    await writeFile(join(root, file), text);
  };
  let published = false;
  const registry = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (!published) {
      response.writeHead(404).end('{"error":"not_found"}');
      return;
    }
    const pkg = { name, version: "0.1.0-beta.1" };
    response.end(
      JSON.stringify(
        request.url?.endsWith(pkg.version)
          ? pkg
          : {
              name,
              "dist-tags": { beta: pkg.version },
              versions: { [pkg.version]: pkg },
            },
      ),
    );
  });
  registries.push(registry);
  await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
  const address = registry.address();
  if (!address || typeof address === "string")
    throw new Error("Registry did not listen");
  await write(".npmrc", `registry=http://127.0.0.1:${address.port}/\n`);
  await mkdir(join(root, ".changeset"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "packages/adapter"), { recursive: true });
  for (const file of [
    "check-changesets.mjs",
    "release-state.mjs",
    "release-version.mjs",
  ]) {
    await cp(resolve("scripts", file), join(root, "scripts", file));
  }
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await write(".gitignore", "node_modules\n");
  await write(
    "package.json",
    JSON.stringify({
      private: true,
      packageManager: "pnpm@12.15.0",
      scripts: {
        "release:version":
          "node scripts/release-version.mjs && pnpm exec prettier --write .changeset/ledger.yaml packages/adapter/package.json packages/adapter/CHANGELOG.md",
      },
    }),
  );
  await write(
    "pnpm-workspace.yaml",
    `packages:\n  - packages/*\nverifyDepsBeforeRun: false\nversioning:\n  lanes:\n    "${name}": beta\n  changelog:\n    storage: repository\n`,
  );
  await write(
    "packages/adapter/package.json",
    JSON.stringify({ name, version: "0.1.0-beta.0" }),
  );
  await write(".changeset/existing.md", intent("patch"));
  await git("init", "--initial-branch=main");
  await git("add", ".");
  await git("commit", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  return {
    root,
    write,
    command,
    publishFirstBeta: () => {
      published = true;
    },
    commit: async () => {
      await git("add", ".");
      await git("commit", "-m", "Change");
    },
    check: () =>
      command(process.execPath, ["scripts/check-changesets.mjs", "--base", base]),
    prepared: () =>
      command(process.execPath, [
        "--input-type=module",
        "-e",
        'import { assertPreparedRelease } from "./scripts/release-state.mjs"; await assertPreparedRelease(process.cwd());',
      ]),
  };
}

afterEach(async () => {
  await Promise.all(
    registries
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          ),
      ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("prepares beta.2 after beta.1 is published and preserves the beta lane", async () => {
  const f = await fixture();
  await f.command("pnpm", ["release:version"]);
  f.publishFirstBeta();
  await f.write(
    ".changeset/correction.md",
    intent("patch", "Fix the published beta."),
  );
  await f.command("pnpm", ["release:version"]);
  expect(
    JSON.parse(
      await readFile(join(f.root, "packages/adapter/package.json"), "utf8"),
    ),
  ).toHaveProperty("version", "0.1.0-beta.2");
  await expect(f.prepared()).resolves.toBeDefined();
});

it.each(["patch", "none"])(
  "accepts a new %s intent with an explanation",
  async (bump) => {
    const f = await fixture();
    await f.write(".changeset/fresh.md", intent(bump));
    await f.commit();
    await expect(f.check()).resolves.toHaveProperty(
      "stdout",
      "Checked 1 new changeset(s).\n",
    );
  },
);

it.each([
  {
    file: "README.md",
    text: "Documentation only.\n",
    message: "Add a new changeset",
  },
  {
    file: ".changeset/existing.md",
    text: intent("patch", "Edit an old intent."),
    message: "Version PR differs",
  },
  {
    file: ".changeset/fresh.md",
    text: intent("invalid"),
    message: "Invalid changeset bump",
  },
  {
    file: ".changeset/fresh.md",
    text: intent("none", ""),
    message: "Explain the user-facing change",
  },
  {
    file: ".changeset/fresh.md",
    text: "---\n{}\n---\n\nNo explanation of a package decision.\n",
    message: "Use --bump none",
  },
  {
    file: "packages/adapter/package.json",
    text: JSON.stringify({ name, version: "0.1.0-beta.99" }),
    message: "Version PR differs",
  },
])(
  "rejects $file without a valid new intent or generated release",
  async ({ file, text, message }) => {
    const f = await fixture();
    await f.write(file, text);
    await f.commit();
    await expect(f.check()).rejects.toThrow(message);
  },
);

it("prepares exactly beta.1, verifies the version PR, and blocks newly pending intents at publication", async () => {
  const f = await fixture();
  await expect(f.prepared()).rejects.toThrow("Only prepared 0.1.0 betas");
  await f.command("pnpm", ["release:version"]);
  expect(
    JSON.parse(
      await readFile(join(f.root, "packages/adapter/package.json"), "utf8"),
    ),
  ).toHaveProperty("version", "0.1.0-beta.1");
  await expect(f.prepared()).resolves.toBeDefined();
  await f.commit();
  await expect(f.check()).resolves.toHaveProperty(
    "stdout",
    "Version PR matches regeneration from its base.\n",
  );
  await f.write(".changeset/next.md", intent("patch"));
  await expect(f.prepared()).rejects.toThrow("release intents are still pending");
  await f.write(".changeset/next.md", intent("none", "Only CI changed."));
  await expect(f.prepared()).resolves.toBeDefined();
});

it("rejects edits mixed into a generated version PR", async () => {
  const f = await fixture();
  await f.command("pnpm", ["release:version"]);
  await f.write("packages/adapter/CHANGELOG.md", "Invented release notes.\n");
  await f.commit();
  await expect(f.check()).rejects.toThrow("Version PR differs");
});
