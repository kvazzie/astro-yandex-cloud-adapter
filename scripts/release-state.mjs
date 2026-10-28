import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";

export const adapterName = "@astro-yandex-cloud/adapter";

/** Read the standard Changesets frontmatter and its changelog summary. */
export function readIntent(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  assert(match, "A changeset must contain YAML frontmatter.");
  const packages = parse(match[1]);
  assert(packages && typeof packages === "object" && !Array.isArray(packages));
  assert(
    Object.keys(packages).length > 0,
    "Use --bump none for an explicit no-release decision.",
  );
  for (const [name, bump] of Object.entries(packages)) {
    assert.equal(
      name,
      adapterName,
      "Name the published adapter package in the changeset.",
    );
    assert(
      ["none", "patch", "minor", "major"].includes(bump),
      "Invalid changeset bump type.",
    );
  }
  const summary = match[2].trim();
  assert(summary, "Explain the user-facing change, or why no release is needed.");
  return { packages, summary };
}

/** Load the native pnpm ledger and intents without making registry requests. */
export async function releaseState(root) {
  const pkg = JSON.parse(
    await readFile(join(root, "packages/adapter/package.json"), "utf8"),
  );
  const workspace = parse(
    await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  let ledger = {};
  try {
    ledger =
      parse(await readFile(join(root, ".changeset/ledger.yaml"), "utf8")) ?? {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const consumed = new Set(
    Object.values(ledger).flatMap((entry) => entry.intents),
  );
  const intents = [];
  for (const file of await readdir(join(root, ".changeset"))) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const intent = readIntent(
      await readFile(join(root, ".changeset", file), "utf8"),
    );
    intents.push({ id: basename(file, ".md"), ...intent });
  }
  const pending = intents.filter(
    (intent) =>
      !consumed.has(intent.id) && intent.packages[adapterName] !== "none",
  );
  return { pkg, workspace, ledger, pending };
}

/** Publication requires a prepared beta and no unconsumed release intents. */
export async function assertPreparedRelease(root) {
  const state = await releaseState(root);
  assert.match(
    state.pkg.version,
    /^0\.1\.0-beta\.[1-9]\d*$/,
    "Only prepared 0.1.0 betas may be published.",
  );
  assert.equal(state.workspace.versioning?.lanes?.[adapterName], "beta");
  const entry = state.ledger[`${adapterName}@${state.pkg.version}`];
  assert(
    entry?.dir === "packages/adapter" && entry.intents?.length > 0,
    "Merge the version pull request first.",
  );
  assert.equal(
    state.pending.length,
    0,
    "Merge the version pull request first: release intents are still pending.",
  );
}
