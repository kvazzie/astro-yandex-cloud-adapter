import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { adapterName, releaseState } from "./release-state.mjs";

const root = resolve(import.meta.dirname, "..");
const { pkg, workspace, pending } = await releaseState(root);
assert.equal(
  workspace.versioning?.lanes?.[adapterName],
  "beta",
  "Stable promotion requires its own reviewed workflow change.",
);
assert.match(pkg.version, /^0\.1\.0-beta\.\d+$/);
// pnpm debuts an unpublished package at its manifest version. Preserve the
// first-beta contract while leaving the checked-in seed unpublished.
if (pkg.version === "0.1.0-beta.0" && pending.length > 0) {
  pkg.version = "0.1.0-beta.1";
  await writeFile(
    join(root, "packages/adapter/package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}
const releases = JSON.parse(
  execFileSync("pnpm", ["version", "-r", "--no-git-checks", "--json"], {
    cwd: root,
    encoding: "utf8",
  }),
);
for (const release of releases) {
  assert.equal(release.name, adapterName);
  assert.match(
    release.newVersion,
    /^0\.1\.0-beta\.[1-9]\d*$/,
    "Changing the stable target requires a reviewed release-policy change.",
  );
}
