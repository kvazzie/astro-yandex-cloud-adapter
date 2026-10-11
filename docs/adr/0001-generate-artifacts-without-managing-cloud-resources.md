# Generate deployment-ready artifacts without performing deployment

Implementation status: The adapter emits Client and Function Artifacts, a Deployment Manifest, and an optional API Gateway template. The integration candidate tracked in #81 implements the Gateway Modifier in #67. Resource identifiers, deployment operations and provisioning remain user-owned; real-cloud verification remains a stable-release gate.

The adapter ends at artifact generation: it produces files shaped for the selected Target, a Deployment Manifest, and optional routing templates, but neither deploys nor provisions Yandex Cloud resources. The API Gateway Modifier can generate an OpenAPI specification template from the build's routes; Deployment supplies resource identifiers and remains responsible for the Gateway, domains, IAM, and other infrastructure choices. Keeping execution outside the adapter avoids adding cloud credentials and resource lifecycle concerns to Artifact Generation.
