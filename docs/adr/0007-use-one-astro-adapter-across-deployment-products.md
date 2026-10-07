# Use one Astro adapter across deployment products

Implementation status: The current public adapter options select a Target and dependency strategy. Target Modifiers and API Gateway templates are planned under #67, and configurable Function Artifact partitioning is planned under #70. The wider interface below is the agreed design, not an implemented public API.

`@astro-yandex-cloud/adapter` is the sole Astro adapter: it generates Target-shaped artifacts, the Deployment Manifest, and optional API Gateway specification templates. Future SST and GitHub Action packages are Deployment Products that consume this shared output rather than introducing SST-specific or workflow-specific Astro adapters, keeping runtime behavior consistent across deployment paths.

The public adapter export accepts Target selection, Target Modifiers, Function Artifact partitioning, and a dependency strategy, then returns an Astro integration. Hook ordering, output layout, route classification, runtime packaging, and Manifest generation remain internal, so Deployment Products use the same adapter interface.
