## Agent skills

### Issue tracker

Issues and specs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Releases

When preparing or verifying the first beta release, read [the release checklist in issue #17](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/17). For stable promotion, read [issue #83](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/83).

### Setup

`.agents/skills/` is gitignored. After clone or worktree checkout, restore it with:

```sh
node scripts/setup-skills.mjs
```
