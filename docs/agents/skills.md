# Matt Pocock skills audit

Reviewed on 2026-10-26 against [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2), package version 1.3.1. The upstream commit is `5beb35b040e3de97e54fa9e386d7e42d15c295c2`, dated 2026-10-19.

## Existing installation

The 16 existing local skill directories already matched the reviewed upstream snapshot byte for byte, including support files and Codex invocation policies. Ten committed lock hashes were stale; reinstalling refreshes those entries. These are newly added to this project, not necessarily newly released upstream.

## Selection

The selected installation contains all 27 skills from the upstream `engineering` and `productivity` directories. It adds the following 11 skills and keeps the workflow described by `ask-matt` available without missing commands.

| Added skill                | Why it fits                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `ask-matt`                 | Choose a skill or workflow without memorizing the full catalog.                                   |
| `diagnosing-bugs`          | Reproduce adapter, runtime, routing, and packaging failures with a tight feedback loop.           |
| `implement-spec`           | Work the repository's issue dependency graph in parallel worktrees, only when explicitly invoked. |
| `pr`                       | Keep PR descriptions focused on the change, before/after evidence, and rollback risk.             |
| `retro`                    | Use completed sessions to find missing navigation, checks, and review guidance.                   |
| `setup-matt-pocock-skills` | Make the existing per-repository setup command available on a fresh clone.                        |
| `wizard`                   | Guide human-only cloud credentials, release permissions, and dashboard steps.                     |
| `handoff`                  | Carry references and decisions between the repository's long-running branches and sessions.       |
| `teach`                    | Optional teaching workflow; included to keep ask-matt's advertised command set available.         |
| `wait-what`                | Re-explain a confusing message using the project's vocabulary.                                    |
| `writing-for-agents`       | Maintain agent instructions and skill configuration with one source of truth.                     |

`diagnosing-bugs`, `wizard`, and `writing-for-agents` are also installed globally on the current machine. Project-local lock entries make them available to other contributors and fresh worktrees. `setup-matt-pocock-skills` was global only and differed from the reviewed upstream version.

## Deferred skills

All 11 remaining upstream skills are excluded.

- Experimental `in-progress`: `chief-of-staff`, `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`. They introduce unfinished orchestration, Claude-specific handoff, new architecture tooling, or writing workflows outside this adapter's current needs.
- Specialized `misc`: `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`. The repository has CI and established test tooling. Hooks, a new test-data library, and course scaffolding need their own concrete requirement.

All selected lock entries pin the reviewed upstream commit through `ref`. Skill support files and Codex invocation policies are installed with each skill.

## Repository setup

GitHub Issues, the five canonical triage labels, and a single shared domain glossary with `docs/adr/` are already configured. All five triage labels exist in GitHub. The workspace contains the adapter, examples, and fixtures; these use the same domain vocabulary.

The upstream instructions use `GLOSSARY.md`. The project's authoritative glossary is `CONTEXT.md`. A relative `GLOSSARY.md -> CONTEXT.md` compatibility symlink is proposed separately, pending setup confirmation. `CLAUDE.md` continues to link to `AGENTS.md`.

Edit `docs/agents/*.md` directly when repository conventions change. Setup does not need to be rerun for ordinary skill updates.
