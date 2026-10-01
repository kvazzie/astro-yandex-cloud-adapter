# Concentrate target policy in target modules

Each supported Target is a concrete module at the internal `TargetModule` seam. The module owns output layout, route compatibility, Astro adapter description, and Artifact Generation, while the Astro integration owns hook lifecycle translation. This keeps a new Target's policy local instead of distributing Target conditionals across hooks and artifact helpers, without inventing ports for future Targets whose variation is not yet known.

The integration owns lifecycle state. It configures output first, validates routes and selects the Astro adapter next, and completes artifacts after the build. Function Artifact preparation is one operation that includes package generation and validation, so callers cannot omit validation.

Artifact preparation uses the local filesystem directly. Tests use temporary directories and real files; introduce a filesystem abstraction only when a second useful implementation requires it.

Add each new Target through a concrete target module. Extract shared behavior only after two modules demonstrate the need.
