# Support direct and API Gateway function invocation

The Function Artifact accepts both direct Yandex Cloud Functions HTTPS invocation events and API Gateway payload format 0.1. API Gateway and other request-routing resources remain user-owned deployment concerns: the adapter prepares artifacts for the selected target but neither generates router configuration nor makes a router part of that target.
