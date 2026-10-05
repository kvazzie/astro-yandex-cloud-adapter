# Check a publication candidate

Run `pnpm pack:check` to build the adapter, pack one candidate, check that archive,
and dry-run publication of the same archive. The command takes the filename from
`npm pack --json`; existing archives in `.artifacts` do not select the candidate.
CI fails when any part of the check fails and retains the tarball and
`.artifacts/package-check.json` as the `checked-package` artifact.

To check an already packed candidate, pass its exact path:

```sh
node scripts/validate-pack.mjs .artifacts/astro-yandex-cloud-adapter-0.1.0.tgz \
  --report .artifacts/package-check.json --astro-version 7.1.0
```

The checker copies the candidate bytes into a temporary directory outside the
workspace and installs them with npm's nested dependency strategy. It removes
`NODE_PATH` and `NODE_OPTIONS` from installation and gives the build runner only
`PATH` and the Sharp installation setting. The application
contains only the installed candidate, Astro, and the check's declared tools and
fixture dependency. Fixture source is copied from the repository; adapter code,
declarations, schema, and internal server entrypoint come from the archive.

The check resolves every declared JavaScript and type entrypoint and loads the
published Deployment Manifest JSON Schema. It audits imports in packed JavaScript
and declarations for undeclared dependencies. TypeScript checks the consumer and
the candidate's declarations; diagnostics in upstream declarations are excluded
because Astro references optional integrations and environment globals.

The applications cover:

- Static-only Builds under the Object Storage Target at `/` and `/docs`.
- A Static-only Build under the Object Storage + Cloud Functions Target at
  `/docs`, with no Function Artifact expected.
- Actions, prerendered pages, and an endpoint using `nanoid` under the Object
  Storage + Cloud Functions Target at `/docs`, with `bundle` and `install`.

Each build validates its Manifest through the packaged parser and schema, checks
its version against the candidate, verifies artifact and object placement, and
scans output for absolute paths. The scan permits only the documented
[Astro-owned metadata](artifact-reports.md#astro-owned-path-limitation).
Generated handlers run in a separate temporary directory. Bundled handlers run
without application dependencies; install handlers first run `npm ci` from their
generated lockfile. Preview checks serve Client Artifacts and run Actions and
endpoints through the Function Artifact, then stop the listener.

The report records the package name, version, original tarball path, byte size,
SHA-512 digest, tested Astro and Node versions, and completed scenarios. It is
written only after success. A failed recheck removes any old report, and changing
the input archive during validation fails the check.

## Publication

The release workflow's existing `npm` environment controls publication approval.
Its Changesets publish command runs `pnpm release:publish`. That command skips an
already published version, otherwise packs and checks a candidate using the same
procedure. It verifies the recorded identity immediately before passing that
tarball to `npm publish` with provenance. It never republishes the workspace
directory. Prereleases use their version's prerelease name as the dist-tag, such
as `beta`; stable versions use `latest`.

Changesets creates tags after successful publication so its action can retain
the existing GitHub release behavior. The workflow retains the archive and report
as `publication-candidate` evidence. No package is published by `pnpm pack:check`.

## Public runtime types

The root entrypoint keeps `AdapterOptions`, `Target`, `DependencyStrategy`, and
runtime/context types. `@astro-yandex-cloud/adapter/runtime` is a type-only
entrypoint. Translation helpers are internal to the generated server and have no
public package exports.
