## Agent skills

### Exports

Prefer `export` on the declaration so visibility is clear where
the value is defined. Re-export facades are allowed.

Good:

```ts
export default function createAdapter() {}
```

Bad:

```ts
function createAdapter() {}
export default createAdapter;
```

### Issue tracker

Issues and specs live in this repository's GitHub Issues. See
`docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels. See
`docs/agents/triage-labels.md`.

### Domain docs

Before domain work or changes to source file names, read
`docs/agents/domain.md`.

### Releases

When preparing or verifying the first beta release, read
[the release checklist in issue #17](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/17).
For stable promotion, read
[issue #83](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/83).

### Setup

`.agents/skills/` is gitignored. After clone or worktree
checkout, restore it with:

```sh
node scripts/setup-skills.mjs
```
