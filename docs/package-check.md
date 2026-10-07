# Check a publication candidate

Run `pnpm pack:check` to build the adapter, pack one candidate, check that archive,
and dry-run publication of the same archive. The command takes the filename from
`pnpm pack --json`; existing archives in `.artifacts` do not select the candidate.
CI fails when any part of the check fails and retains the tarball and
`.artifacts/package-check.json` as the `checked-package` artifact.

To check an already packed candidate, pass its exact path:

```sh
node scripts/validate-pack.mjs .artifacts/astro-yandex-cloud-adapter-0.1.0-beta.1.tgz \
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

The separate **Publish beta** workflow runs `pnpm release:publish` after approval
through the protected `npm` environment. The command requires a prepared
`0.1.0-beta.N` version with no pending Changesets. It skips an already published
version, otherwise packs and checks a candidate using the same procedure. It
verifies the recorded identity immediately before passing that exact tarball to
`npm publish` with provenance, script execution disabled, and the explicit `beta`
dist-tag. It cannot publish a stable release or the initial versioning seed.

The workflow retains the archive and report as `publication-candidate` evidence.
CI also rehearses version preparation and retains the `rehearsed-beta` artifact.
No package is published by `pnpm pack:check`. See the [maintainer release
procedure](beta-releases.md) for setup, approval, first-publication credentials,
trusted publishing, and recovery.

## Public runtime types

The root entrypoint keeps `AdapterOptions`, `Target`, `DependencyStrategy`, and
runtime/context types. `@astro-yandex-cloud/adapter/runtime` is a type-only
entrypoint. Translation helpers are internal to the generated server and have no
public package exports.
