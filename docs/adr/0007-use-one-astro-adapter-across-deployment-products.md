# Use one Astro adapter across deployment products

`@astro-yandex-cloud/adapter` is the sole Astro adapter: it generates target-shaped artifacts and the deployment manifest. Future SST and GitHub Action packages are deployment products that consume this shared output rather than introducing SST-specific or workflow-specific Astro adapters, keeping runtime behavior consistent across deployment paths.

The public adapter export accepts Target selection and a dependency strategy and returns an Astro integration. Hook ordering, output layout, route classification, runtime packaging, and Manifest generation remain internal, so Deployment Products use the same adapter interface.
