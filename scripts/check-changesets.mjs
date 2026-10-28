import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { readIntent } from "./release-state.mjs";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "origin/main" },
    head: { type: "string", default: "HEAD" },
  },
});
const root = process.cwd();
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
const head = git("rev-parse", "--verify", `${values.head}^{commit}`).trim();
const base = git("merge-base", values.base, head).trim();
const changed = git("diff", "--name-only", "-z", base, head)
  .split("\0")
  .filter(Boolean);
assert(
  changed.length > 0,
  "No committed changes to check against the selected base.",
);
const added = git(
  "diff",
  "--no-renames",
  "--diff-filter=A",
  "--name-only",
  "-z",
  base,
  head,
)
  .split("\0")
  .filter(
    (file) =>
      /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md",
  );
if (added.length > 0) {
  for (const file of added) readIntent(git("show", `${head}:${file}`));
  process.stdout.write(`Checked ${added.length} new changeset(s).\n`);
} else {
  // A version PR is accepted only when every byte matches regeneration from
  // its base. A branch name or a label never grants an exemption.
  const generated =
    /^(?:packages\/adapter\/(?:package\.json|CHANGELOG\.md)|pnpm-lock\.yaml|\.changeset\/(?:ledger\.yaml|[^/]+\.md))$/;
  assert(
    changed.every((file) => generated.test(file)),
    "Add a new changeset with pnpm change, or use --bump none and explain why no release is needed.",
  );
  const temporary = await mkdtemp(join(tmpdir(), "adapter-version-pr-"));
  try {
    const archive = join(temporary, "base.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", archive, base], {
      cwd: root,
    });
    execFileSync("tar", ["-xf", archive, "-C", temporary]);
    await symlink(
      resolve(root, "node_modules"),
      join(temporary, "node_modules"),
      "dir",
    );
    execFileSync("pnpm", ["release:version"], {
      cwd: temporary,
      stdio: "pipe",
      timeout: 120_000,
    });
    const candidates = new Set([
      ...changed,
      ...git(
        "ls-tree",
        "-r",
        "--name-only",
        base,
        ".changeset",
        "packages/adapter/package.json",
        "packages/adapter/CHANGELOG.md",
        "pnpm-lock.yaml",
      )
        .trim()
        .split("\n"),
      ".changeset/ledger.yaml",
      "packages/adapter/CHANGELOG.md",
    ]);
    for (const file of candidates) {
      if (!generated.test(file)) continue;
      let expected;
      try {
        expected = await readFile(join(temporary, file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      let actual;
      try {
        actual = execFileSync("git", ["show", `${head}:${file}`], {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        /* A generated deletion must also be absent from the PR. */
      }
      assert.deepEqual(
        actual,
        expected,
        `Version PR differs from pnpm release:version at ${file}. Add a changeset for ordinary changes.`,
      );
    }
    process.stdout.write("Version PR matches regeneration from its base.\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
