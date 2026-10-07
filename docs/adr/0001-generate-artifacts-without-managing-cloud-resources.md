# Generate deployment-ready artifacts without performing deployment

Implementation status: The API Gateway Modifier and routing template generation are planned under #67. The current adapter produces Client and Function Artifacts and a Deployment Manifest; routing templates are part of the intended responsibility boundary, not available build output.

The adapter ends at artifact generation: it produces files shaped for the selected Target, a Deployment Manifest, and optional routing templates, but neither deploys nor provisions Yandex Cloud resources. The API Gateway Modifier can generate an OpenAPI specification template from the build's routes; Deployment supplies resource identifiers and remains responsible for the Gateway, domains, IAM, and other infrastructure choices. Keeping execution outside the adapter avoids adding cloud credentials and resource lifecycle concerns to Artifact Generation.
