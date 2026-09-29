# Support direct and API Gateway function invocation

The Function Artifact supports direct Cloud Functions HTTPS invocation and API Gateway payload format 0.1. Direct invocation serves stateless user-defined endpoints; Astro Actions, server islands, and on-demand pages require the API Gateway Modifier. The modifier generates an OpenAPI specification template but does not create or configure the Gateway resource. Routing resources remain user-owned, while the Deployment Manifest records the build's route requirements and the selected modifier as provenance.
