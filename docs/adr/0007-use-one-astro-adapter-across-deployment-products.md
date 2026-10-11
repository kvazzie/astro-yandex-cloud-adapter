# Use one Astro adapter across deployment products

Implementation status: The public adapter selects a Target, dependency strategy, API Gateway and recursive 404 modifiers, shared or separate Functions, and an optional direct form origin. The integration candidate tracked in #81 implements #67–#70 through this one adapter. SST and GitHub Action Deployment Products remain future work and add no package dependency to the adapter.

`@astro-yandex-cloud/adapter` is the sole Astro adapter: it generates Target-shaped artifacts, the Deployment Manifest, and optional API Gateway specification templates. Future SST and GitHub Action packages are Deployment Products that consume this shared output rather than introducing SST-specific or workflow-specific Astro adapters, keeping runtime behavior consistent across deployment paths.

The public adapter export accepts Target selection, Target Modifiers, Function Artifact partitioning, and a dependency strategy, then returns an Astro integration. Hook ordering, output layout, route classification, runtime packaging, and Manifest generation remain internal, so Deployment Products use the same adapter interface.
