import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values } = parseArgs({
  options: { "expected-sha": { type: "string" } },
});
const repository = "kvazzie/astro-yandex-cloud-adapter";
assert(
  process.env.GITHUB_REPOSITORY === repository &&
    process.env.GITHUB_REF === "refs/heads/main",
  "Version preparation requires the approved repository and main branch.",
);
assert(
  ["workflow_run", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME),
  "Version preparation requires workflow_run or workflow_dispatch.",
);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (process.env.GITHUB_EVENT_NAME === "workflow_run") {
  assert(
    event.action === "completed" &&
      event.workflow_run?.event === "push" &&
      event.workflow_run.head_branch === "main" &&
      event.workflow_run.head_repository?.full_name === repository &&
      event.workflow_run.path === ".github/workflows/ci.yml" &&
      event.workflow_run.name === "CI" &&
      event.workflow_run.status === "completed" &&
      event.workflow_run.conclusion === "success",
    "Only successful main push CI may prepare a version.",
  );
}
const selectedSha =
  process.env.GITHUB_EVENT_NAME === "workflow_run"
    ? event.workflow_run.head_sha
    : process.env.GITHUB_SHA;
assert.match(
  selectedSha ?? "",
  /^[a-f0-9]{40}$/,
  "A full main commit SHA is required.",
);
assert.equal(
  process.env.GITHUB_SHA,
  selectedSha,
  "The workflow source must match the checked commit.",
);

/** Read GitHub policy evidence without creating or changing repository resources. */
async function github(path) {
  const { stdout } = await run("gh", ["api", `repos/${repository}/${path}`]);
  return JSON.parse(stdout);
}

const main = await github("git/ref/heads/main");
const sha = main.object.sha;
assert.match(
  sha ?? "",
  /^[a-f0-9]{40}$/,
  "GitHub did not return the full main commit SHA.",
);
if (values["expected-sha"]) {
  assert.equal(
    sha,
    values["expected-sha"],
    "main changed after version preparation was approved.",
  );
}
assert.equal(selectedSha, sha, "The selected commit is no longer main.");
const ci = await github(
  `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=1`,
);
const latest = ci.workflow_runs[0];
assert(
  latest?.event === "push" &&
    latest.head_branch === "main" &&
    latest.head_sha === sha &&
    latest.head_repository?.full_name === repository &&
    latest.path === ".github/workflows/ci.yml" &&
    latest.name === "CI" &&
    latest.status === "completed" &&
    latest.conclusion === "success",
  "The latest main push CI must be completed successfully.",
);
assert.equal(
  (await github("git/ref/heads/main")).object.sha,
  sha,
  "main changed while checking CI.",
);
await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
