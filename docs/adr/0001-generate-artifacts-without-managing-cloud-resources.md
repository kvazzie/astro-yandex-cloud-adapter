# Generate deployment-ready artifacts without performing deployment

The adapter ends at artifact generation: it makes deployment easier by producing files shaped for the selected target, a deployment manifest, and guidance, but it neither deploys nor provisions Yandex Cloud resources. Routing, IAM, domains, and infrastructure ownership vary independently from an Astro build, so keeping deployment execution outside the adapter prevents cloud credentials and infrastructure lifecycle concerns from becoming part of its contract.
