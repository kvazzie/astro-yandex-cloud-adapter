# Adapter architecture

The package has one external seam: the default export accepts adapter options and returns an Astro integration. Its interface stays limited to target selection; Astro hook ordering, output paths, route classification, runtime packaging, and manifest generation remain implementation details.

## Modules

**Astro integration** (`src/index.ts`)
: Translates Astro's hook lifecycle into calls on one target driver. It owns lifecycle state, but no Yandex Cloud target policy.

**Target driver** (`src/driver.ts`)
: The internal seam for behavior that varies by target. A concrete target driver configures Astro's output layout, rejects unsupported route allocations, describes the Astro adapter, and completes target-specific artifacts. Adding a genuinely different target adds another adapter at this seam.

**Artifact generation** (`src/artifacts.ts`)
: Implements local filesystem work behind the target-driver interface. Cloud Functions package preparation is one operation: callers do not coordinate package generation and validation separately.

**Runtime translation** (`src/runtime.ts`)
: Converts between Yandex Cloud HTTP events and Web Request/Response objects. It is in-process computation and remains a single module rather than introducing ports for functions that do not vary.

## Design constraints

- Target policy belongs in a concrete target driver, not in Astro hook callbacks.
- The target-driver interface follows the phases Astro exposes. Its ordering constraint is `configureBuild`, then route validation and adapter selection, then `completeBuild`.
- Tests exercise the external seam with fixture builds and generated handlers. Focused runtime tests exercise the runtime-translation module directly.
- Local filesystem operations do not receive a port until a second useful adapter exists. Tests use temporary directories and real files.
- The package makes artifacts deployment-ready, while deployment and provisioning execution remain outside it, so there is no cloud-client seam.
- A future Container, Compute VM, or Functions-only target should first be implemented as a concrete target driver. Shared runtime behavior should be extracted only after two target drivers demonstrate the variation.
