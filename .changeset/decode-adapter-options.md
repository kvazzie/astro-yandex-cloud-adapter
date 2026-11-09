---
"@astro-yandex-cloud/adapter": patch
---

Decode, validate, and apply defaults to adapter options through a
separate Effect Schema for each Target before setup.
Target-specific unions describe compatible Gateway, recursive404,
and directOrigin choices. Object Storage has no Function-only
dependencyStrategy, functions, or directOrigin fields; Target
schemas reject unexpected options. Each current Target owns its
recursive404 requirement for the API Gateway Modifier, so new
Targets can define their own routing constraints. Direct HTTP
origins are parsed and validated during decoding, then serialized
as normalized origin strings in the generated Function runtime
config. Target build strategies consume decoded options directly.
Invalid options report the integration options error with schema
details in its cause. Derive the public EncodedOptions type from
the schemas' encoded inputs so incompatible combinations are also
rejected by TypeScript.

Provide build state, Target build strategy, and decoded options
to hooks through an Effect Context created separately for each
integration instance. Hooks share build state across their
lifecycle and reset it when another build starts. Missing build
configuration is reported through the Effect error channel.
