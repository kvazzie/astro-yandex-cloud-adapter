# Derive the Gateway template from build routes

The API Gateway Modifier produces an OpenAPI specification template from the same route requirements as the Deployment Manifest. This lets a standalone Pulumi consumer or the future SST component route Astro pages and endpoints without reconstructing Astro's routing rules, while leaving resource identifiers and infrastructure changes under user control. The template routes pages and endpoints; the application supplies direct Object Storage or CDN URLs for assets.
