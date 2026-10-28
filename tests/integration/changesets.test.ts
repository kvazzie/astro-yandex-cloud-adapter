import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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

/** Create a committed workspace with a local registry for release and hook checks. */
async function fixture(initialBump: "patch" | "none" | null = "patch") {
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
  /** Serve deterministic npm metadata for an unpublished or published first beta. */
  function respondToRegistry(request: IncomingMessage, response: ServerResponse) {
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
  }
  const registry = createServer(respondToRegistry);
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
  const workspace = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  await write(
    "package.json",
    JSON.stringify({
      private: true,
      packageManager: "pnpm@12.15.0",
      scripts: {
        "release:version": workspace.scripts["release:version"],
        "changeset:check": workspace.scripts["changeset:check"],
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
  await write(".changeset/README.md", "Release intents.\n");
  if (initialBump) await write(".changeset/existing.md", intent(initialBump));
  await git("init", "--initial-branch=main");
  await git("add", ".");
  await git("commit", "-m", "Base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  /** Send a Git pre-push update to the actual hook without changing local hook configuration. */
  const hook = (localRef: string, remoteRef: string, sha = base) => {
    const invocation = run(resolve(".githooks/pre-push"), ["origin"], {
      cwd: root,
      env: { ...process.env, CHANGESET_BASE: base },
    });
    invocation.child.stdin?.end(
      `${localRef} ${sha} ${remoteRef} ${"0".repeat(40)}\n`,
    );
    return invocation;
  };
  return {
    root,
    write,
    command,
    hook,
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

it.each(["none", null] as const)(
  "leaves the seed unpublished with only %s release intents",
  async (bump) => {
    const f = await fixture(bump);
    await f.command("pnpm", ["release:version"]);
    expect(
      JSON.parse(
        await readFile(join(f.root, "packages/adapter/package.json"), "utf8"),
      ),
    ).toHaveProperty("version", "0.1.0-beta.0");
    for (const file of [
      ".changeset/ledger.yaml",
      "packages/adapter/CHANGELOG.md",
    ]) {
      await expect(readFile(join(f.root, file))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    }
  },
);

it.each([
  ["refs/tags/v0.1.0-beta.1", "refs/tags/v0.1.0-beta.1"],
  ["refs/heads/main", "refs/tags/v0.1.0-beta.1"],
  ["refs/notes/review", "refs/notes/review"],
])(
  "skips a push of %s to non-branch destination %s",
  async (localRef, remoteRef) => {
    const f = await fixture();
    await expect(f.hook(localRef, remoteRef)).resolves.toHaveProperty(
      "stdout",
      "",
    );
  },
);

it.each(["refs/heads/main", "HEAD"])(
  "checks branch updates pushed from %s",
  async (localRef) => {
    const f = await fixture();
    await expect(f.hook(localRef, "refs/heads/main")).rejects.toThrow(
      "No committed changes",
    );
  },
);

it("skips a branch deletion in the pre-push hook", async () => {
  const f = await fixture();
  await expect(
    f.hook("refs/heads/main", "refs/heads/main", "0".repeat(40)),
  ).resolves.toHaveProperty("stdout", "");
});

it.each([
  ".changeset/ledger.yaml",
  "packages/adapter/CHANGELOG.md",
  ".changeset/existing.md",
])("rejects edits to %s even alongside a fresh none intent", async (file) => {
  const f = await fixture();
  await f.write(
    ".changeset/fresh.md",
    intent("none", "Only repository checks changed."),
  );
  await f.write(
    file,
    file.endsWith("existing.md")
      ? intent("patch", "Rewrite an old change.")
      : "Invented release data.\n",
  );
  await f.commit();
  await expect(f.check()).rejects.toThrow(
    "Ordinary PRs must not edit generated release files",
  );
});

it("rejects renaming an existing intent to make it look new", async () => {
  const f = await fixture();
  await f.write(
    ".changeset/renamed.md",
    await readFile(join(f.root, ".changeset/existing.md"), "utf8"),
  );
  await rm(join(f.root, ".changeset/existing.md"));
  await f.commit();
  await expect(f.check()).rejects.toThrow(
    "Ordinary PRs must not edit generated release files",
  );
});

it("rejects manually bumping the package alongside a fresh intent", async () => {
  const f = await fixture();
  await f.write(".changeset/fresh.md", intent("none", "Only CI changed."));
  await f.write(
    "packages/adapter/package.json",
    JSON.stringify({ name, version: "0.1.0-beta.99" }),
  );
  await f.commit();
  await expect(f.check()).rejects.toThrow(
    "Leave package version changes to the generated version PR",
  );
});

it("allows package metadata and lockfile changes with a fresh intent", async () => {
  const f = await fixture();
  await f.write(".changeset/fresh.md", intent("patch"));
  await f.write(
    "packages/adapter/package.json",
    JSON.stringify({
      name,
      version: "0.1.0-beta.0",
      description: "Clarify the package description.",
    }),
  );
  await f.write("pnpm-lock.yaml", 'lockfileVersion: "9.0"\n');
  await f.commit();
  await expect(f.check()).resolves.toHaveProperty(
    "stdout",
    "Checked 1 new changeset(s).\n",
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
