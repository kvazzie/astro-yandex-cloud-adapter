---
"@astro-yandex-cloud/adapter": patch
---

Decode, validate, and apply defaults to adapter options through the integration's Effect Schema before setup. Composed Target and Gateway variants reject incompatible choices; Object Storage rejects Function-only dependencyStrategy and functions options, including bundle and shared. Direct HTTP origins are parsed and validated during decoding, then serialized as normalized origin strings in the generated Function runtime config. Target modules consume decoded options directly. Invalid options report the integration options error with schema details in its cause. Derive the public AdapterOptions type from the schema so incompatible combinations are also rejected by TypeScript.
