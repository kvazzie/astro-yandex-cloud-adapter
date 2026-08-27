# Offer bundle and install dependency strategies

Function Artifacts support one dependency strategy per build: `bundle` uses Astro's Vite/Rolldown pipeline and is the default, while opt-in `install` preserves runtime dependencies and emits exact package metadata plus a deterministic lockfile. Native dependencies such as Sharp require `install`; neither strategy introduces a second application bundler, and per-package strategy is deferred until a real mixed case requires it.
