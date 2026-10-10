---
"@astro-yandex-cloud/adapter": patch
---

Decode and validate adapter options through the integration's Effect Schema before resolving the build plan. Composed Target and Gateway variants reject incompatible choices, and direct HTTP origins are parsed and validated during decoding. Invalid options report the integration options error with schema details in its cause; the build-plan conversion only applies defaults and extracts the normalized origin. Derive the public AdapterOptions type from the schema so incompatible combinations are also rejected by TypeScript.
