# Derive the Gateway template from build routes

Implementation status: API Gateway Modifier selection and template generation are planned under #67. The current adapter does not emit a Gateway specification template. This decision records the intended ownership and source of the future template.

The API Gateway Modifier produces an OpenAPI specification template from the same route requirements as the Deployment Manifest. This lets a standalone Pulumi consumer or the future SST component route Astro pages and endpoints without reconstructing Astro's routing rules, while leaving resource identifiers and infrastructure changes under user control. The template routes pages and endpoints; the application supplies direct Object Storage or CDN URLs for assets.
