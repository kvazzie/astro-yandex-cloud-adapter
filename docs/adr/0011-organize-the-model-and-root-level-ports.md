# Organize scenario responsibilities and root-level integration

Use lowercase `src/mandatory/` and `src/conditional/` groups
instead of a `src/model/` wrapper. Keep `Options`, `Hooks`, and
`TargetBuild` directly under `src/`. This revises the earlier
placement decision in this ADR: participation in every or only
some build scenarios does not determine a module's architectural
layer.

`mandatory` contains common build completion and the adapter's
[_Deployment Manifest_](../../GLOSSARY.md#deployment-manifest)
facade. `conditional` contains function-artifact preparation,
Gateway-template generation, and 404 handling. Conditional
responsibilities may be shared by several scenarios or by build,
runtime, and preview. These are organizational groups, not new
domain declarations or Aggregates.

`Hooks` orchestrates Astro lifecycle callbacks and integration
state. `Options` remains the single configuration port, owning
input decoding, schemas, and defaults. `TargetBuild` provides the
selected build strategy, including application coordination and
Astro/Vite integration. Its private `.Tag.ts` holds the Effect
Tag contract; concrete files implement it. The module index
exposes the contract and constructs the selected implementation.

Individual modules may currently combine domain rules,
application workflow, and technical operations. Evaluate those
responsibilities through their contracts; moving a module into a
group does not classify all of its contents as domain code.
Effect remains permitted in domain rules. Any future separation
should pass those rules the facts they need rather than make them
depend on the whole integration configuration.

[ADR 0003](0003-concentrate-target-policy-in-target-drivers.md)
records the concrete module ownership and current implementation.
