import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import semver from "semver";

// A fixed Node row tests the latest Astro in its range that supports that
// runtime. New Astro releases can raise their Node minimum within a major.
const requested = process.argv[2];
assert(requested, "Pass the Astro version range or dist-tag from the CI matrix.");
const response = await globalThis.fetch("https://registry.npmjs.org/astro", {
  headers: { accept: "application/vnd.npm.install-v1+json" },
});
assert(response.ok, `Could not read Astro versions: HTTP ${response.status}`);
const metadata = await response.json();
const range = metadata["dist-tags"]?.[requested] ?? requested;
const version = Object.keys(metadata.versions)
  .filter(
    (version) =>
      semver.satisfies(version, range) &&
      semver.satisfies(
        process.versions.node,
        metadata.versions[version].engines?.node ?? "*",
      ),
  )
  .sort(semver.rcompare)[0];
assert(
  version,
  `No astro@${requested} release supports Node ${process.versions.node}.`,
);
process.stdout.write(
  `Testing Astro ${version} on Node ${process.versions.node}.\n`,
);
execFileSync(
  "pnpm",
  ["--include-workspace-root", "--recursive", "update", `astro@${version}`],
  { stdio: "inherit" },
);
