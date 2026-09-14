## Agent skills

### Issue tracker

Issues and specs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Releases

When preparing or verifying a release, read [the release checklist](docs/release-readiness.md).

### Setup

`.agents/skills/` is gitignored. After clone or worktree checkout, restore it with:

```sh
node scripts/setup-skills.mjs
```
