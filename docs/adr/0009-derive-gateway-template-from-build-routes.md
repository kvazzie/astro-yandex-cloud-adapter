# Derive the Gateway template from build routes

Implementation status: The integration candidate tracked in #81 implements #67. Selecting apiGateway emits yandex-api-gateway.json from the same completed-build route plan as the Manifest. The template binds exact static keys and actual Function Artifact references using invalid-default resource variables, and rejects route shapes or priorities it cannot preserve. Generation has local and packed-consumer tests; cloud routing remains unverified.

The API Gateway Modifier produces an OpenAPI specification template from the same route requirements as the Deployment Manifest. This lets a standalone Pulumi consumer or the future SST component route Astro pages and endpoints without reconstructing Astro's routing rules, while leaving resource identifiers and infrastructure changes under user control. The template routes pages and endpoints; the application supplies direct Object Storage or CDN URLs for assets.
