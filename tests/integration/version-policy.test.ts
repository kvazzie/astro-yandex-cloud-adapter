import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);
const checker = resolve("scripts/check-version-policy.mjs");
const repository = "kvazzie/astro-yandex-cloud-adapter";
const sourceCommit = "a".repeat(40);
const successfulRun = {
  id: 17,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: sourceCommit,
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};

/** Exercise the workflow policy through its CLI, replacing only GitHub responses. */
async function scenario(
  change: {
    ci?: Partial<typeof successfulRun> | null;
    trigger?: Partial<typeof successfulRun>;
    main?: string;
    movedMain?: string;
    eventName?: string;
    ref?: string;
    sha?: string;
    repository?: string;
    expectedSha?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "adapter-version-policy-"));
  const output = join(root, "output");
  await writeFile(output, "");
  const eventPath = join(root, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "completed",
      workflow_run: { ...successfulRun, ...change.trigger },
    }),
  );
  await writeFile(
    join(root, "gh"),
    `#!${process.execPath}
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
assert.equal(args[0], "api");
assert(!args.includes("--method"), "The policy must not write to GitHub");
if (args[1] === "repos/${repository}/git/ref/heads/main") {
  const counter = join(dirname(process.argv[1]), "main-lookups.txt");
  const count = Number(await readFile(counter, "utf8").catch(() => "0"));
  await writeFile(counter, String(count + 1));
  console.log(JSON.stringify({ object: { sha: count > 0 ? ${JSON.stringify(change.movedMain ?? change.main ?? sourceCommit)} : ${JSON.stringify(change.main ?? sourceCommit)} } }));
} else {
  assert.equal(args[1], "repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${change.main ?? sourceCommit}&event=push&branch=main&per_page=1");
  console.log(${JSON.stringify(JSON.stringify({ workflow_runs: change.ci === null ? [] : [{ ...successfulRun, ...change.ci }] }))});
}
`,
  );
  await chmod(join(root, "gh"), 0o755);
  return {
    check: () =>
      run(
        process.execPath,
        [
          checker,
          ...(change.expectedSha ? ["--expected-sha", change.expectedSha] : []),
        ],
        {
          env: {
            ...process.env,
            GITHUB_REPOSITORY: change.repository ?? repository,
            GITHUB_REF: change.ref ?? "refs/heads/main",
            GITHUB_SHA: change.sha ?? sourceCommit,
            GITHUB_EVENT_NAME: change.eventName ?? "workflow_run",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: output,
            PATH: `${root}:${process.env.PATH ?? ""}`,
          },
        },
      ),
    output,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("permits version preparation only for successful CI on the current main commit", async () => {
  const fixture = await scenario();
  try {
    await fixture.check();
    expect(await readFile(fixture.output, "utf8")).toBe(`sha=${sourceCommit}\n`);
  } finally {
    await fixture.cleanup();
  }
});

it("rejects a workflow_run for an older main commit before version preparation", async () => {
  const fixture = await scenario({ main: "b".repeat(40) });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "The selected commit is no longer main",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("rejects pull request CI even when a workflow_run reports success on main", async () => {
  const fixture = await scenario({ trigger: { event: "pull_request" } });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "Only successful main push CI may prepare a version",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("rejects a newer in-progress CI attempt even when the triggering attempt passed", async () => {
  const fixture = await scenario({
    ci: { status: "in_progress", conclusion: "success" },
  });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "The latest main push CI must be completed successfully",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("rejects manual dispatch on a feature branch", async () => {
  const fixture = await scenario({
    eventName: "workflow_dispatch",
    ref: "refs/heads/feature",
  });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "Version preparation requires the approved repository and main branch",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("rechecks the previously approved commit before Changesets can change files", async () => {
  const fixture = await scenario({ expectedSha: "b".repeat(40) });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "main changed after version preparation was approved",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("rejects main advancing while the policy reads the CI result", async () => {
  const fixture = await scenario({ movedMain: "b".repeat(40) });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "main changed while checking CI",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("requires the workflow context SHA to match the checked main push CI", async () => {
  const fixture = await scenario({ sha: "b".repeat(40) });
  try {
    await expect(fixture.check()).rejects.toThrow(
      "The workflow source must match the checked commit",
    );
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});

it("permits manual dispatch after current-main CI succeeds", async () => {
  const fixture = await scenario({
    eventName: "workflow_dispatch",
    expectedSha: sourceCommit,
  });
  try {
    await fixture.check();
    expect(await readFile(fixture.output, "utf8")).toBe(`sha=${sourceCommit}\n`);
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  { title: "missing CI", change: { ci: null } },
  { title: "failed CI", change: { ci: { conclusion: "failure" } } },
  { title: "cancelled CI", change: { ci: { conclusion: "cancelled" } } },
  {
    title: "CI for a different commit",
    change: { ci: { head_sha: "b".repeat(40) } },
  },
  {
    title: "CI from a fork",
    change: { ci: { head_repository: { full_name: "fork/adapter" } } },
  },
  {
    title: "CI on a different branch",
    change: { ci: { head_branch: "feature" } },
  },
  {
    title: "an unrelated workflow",
    change: { ci: { path: ".github/workflows/other.yml" } },
  },
])(
  "rejects $title before producing an approved version commit",
  async ({ change }) => {
    const fixture = await scenario(change);
    try {
      await expect(fixture.check()).rejects.toThrow(
        "The latest main push CI must be completed successfully",
      );
      expect(await readFile(fixture.output, "utf8")).toBe("");
    } finally {
      await fixture.cleanup();
    }
  },
);

it.each([
  {
    title: "a fork workflow",
    change: { repository: "fork/adapter" },
    message: "approved repository and main branch",
  },
  {
    title: "a fork CI trigger",
    change: { trigger: { head_repository: { full_name: "fork/adapter" } } },
    message: "Only successful main push CI",
  },
  {
    title: "a failed CI trigger",
    change: { trigger: { conclusion: "failure" } },
    message: "Only successful main push CI",
  },
  {
    title: "an unsupported trigger",
    change: { eventName: "push" },
    message: "workflow_run or workflow_dispatch",
  },
  {
    title: "a stale manual dispatch",
    change: { eventName: "workflow_dispatch", sha: "b".repeat(40) },
    message: "The selected commit is no longer main",
  },
])("rejects $title before preparing a version", async ({ change, message }) => {
  const fixture = await scenario(change);
  try {
    await expect(fixture.check()).rejects.toThrow(message);
    expect(await readFile(fixture.output, "utf8")).toBe("");
  } finally {
    await fixture.cleanup();
  }
});
