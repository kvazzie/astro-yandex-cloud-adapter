# Use Astro's build pipeline for runtime artifacts

Astro's adapter hooks and its Vite/Rolldown pipeline emit service-shaped runtime artifacts such as `dist/function` directly. `tsdown` builds the published adapter package only; the adapter does not run a second application bundler, avoiding a competing module-resolution and chunking pipeline while keeping future outputs such as `dist/container` consistent with their target service.
