# Concentrate target policy in target drivers

Each supported target is a concrete adapter at the internal target-driver seam. The driver owns output layout, route compatibility, Astro adapter description, and artifact completion, while the Astro integration owns only hook lifecycle translation. This keeps a new target's policy local instead of distributing target conditionals across hooks and artifact helpers, without inventing ports for future targets whose variation is not yet known.

The integration owns lifecycle state. It configures output first, validates routes and selects the Astro adapter next, and completes artifacts after the build. Function Artifact preparation is one operation that includes package generation and validation, so callers cannot omit validation.

Artifact preparation uses the local filesystem directly. Tests use temporary directories and real files; introduce a filesystem abstraction only when a second useful implementation requires it.

Add each new Target through a concrete target driver. Extract shared target behavior only after two drivers demonstrate the need.
