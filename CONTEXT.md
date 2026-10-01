# Yandex Cloud Adapter

This context describes how an Astro project becomes deployable artifacts for supported Yandex Cloud service arrangements. It ends when those artifacts and their deployment description have been produced.

## Deployment model

**Target**:
A supported arrangement of Yandex Cloud services selected in adapter configuration to shape Artifact Generation. The Deployment Manifest describes the artifacts actually produced by the build.
_Avoid_: Mode, platform, deployment

**Target Modifier**:
An adapter configuration choice that refines how a Target shapes Artifact Generation without performing Deployment or Provisioning.

**API Gateway Modifier**:
A Target Modifier available to every supported Target that prepares a build for Request Routing through API Gateway. The API Gateway resource and its final configuration remain user-owned.

**Object Storage Target**:
The Target that produces only a Client Artifact and accepts only Static-only Builds.
_Avoid_: Static target

**Object Storage + Cloud Functions Target**:
The Target that prepares a Client Artifact for Object Storage and produces Function Artifacts when the build has On-demand Routes. Without the API Gateway Modifier, Function Artifacts serve stateless user-defined endpoints through direct Function URLs. With the modifier, Request Routing can also serve on-demand pages and Astro's internal endpoints.
_Avoid_: Hybrid target, server target

**Serverless Container Target**:
The Target that produces a Container Artifact capable of serving the application over HTTP. It may be invoked directly or through API Gateway.

**Client Artifact**:
The deployable files that require no application code to execute, including prerendered pages, public files, and browser assets. For Object Storage Targets, these files are intended for Object Storage.
_Avoid_: Static files, Object Storage bundle

**Function Artifact**:
The deployable Cloud Functions source that serves on-demand routes when invoked directly over HTTPS or through a compatible user-owned router.
_Avoid_: Server bundle, Lambda artifact

**Direct Function Invocation**:
A request to a Function Artifact through its Cloud Functions URL without API Gateway. This arrangement serves stateless user-defined endpoints.

**Container Artifact**:
The application code and assets prepared for Serverless Containers to serve requests directly over HTTPS or through a compatible user-owned router.

**Serving Artifact**:
The Client Artifact, Function Artifact, or Container Artifact selected to produce the response to a request.
_Avoid_: Route infrastructure

**Serving Artifact's Target**:
The concrete Yandex Cloud service within the selected Target that serves a Serving Artifact: Object Storage for a Client Artifact, Cloud Functions for a Function Artifact, or Serverless Containers for a Container Artifact. This names a service, not the Target of the whole build.

**Deployment Manifest**:
A schema-versioned, machine-readable declaration of the Serving Artifacts actually produced, each Serving Artifact's Target, runtime requirements, and request-routing requirements. It records the selected Target and Target Modifiers as build provenance, not as an instruction to provision unused services, and contains no guessed deployer policy, commands, resource handles, or permission to allocate cloud resources.
_Avoid_: Build metadata, deployment configuration

**API Gateway Specification Template**:
An OpenAPI description of the build's page and endpoint Request Routing through API Gateway, derived from the same route requirements as the Deployment Manifest when the API Gateway Modifier is selected. Deployment supplies resource identifiers and may customize the specification.

**Function Runtime Bridge**:
A reusable translation between Yandex Cloud Functions invocations and Web Standards requests and responses. Its compatibility is established against real Yandex Cloud deployments and then shared by products that emit Function Artifacts.
_Avoid_: Runtime transformer, function adapter

## Rendering model

**Prerendered Route**:
A route whose response is produced during the build and included in the client artifact.
_Avoid_: Static route

**On-demand Route**:
A route whose response requires application code to execute for a request.
_Avoid_: Dynamic route, SSR route

**404 Scope**:
A URL prefix whose explicit custom 404 page is the nearest fallback for an unknown page request. Scopes may be nested when recursive 404 handling is selected.

**Static-only Build**:
A build containing no on-demand routes, regardless of whether an adapter is configured.
_Avoid_: Static output

**Runtime Build**:
A build containing at least one on-demand route, including an Astro `output: "static"` project with a route that opts out of prerendering.
_Avoid_: Hybrid build, server build

## Responsibility boundary

**Bare Adapter**:
An Astro adapter that performs Artifact Generation without executing Deployment or Provisioning.
_Avoid_: Deployer, deployment adapter

**Deployment Product**:
A tool that interprets a deployment manifest and executes Deployment. A deployment product may also perform Provisioning when that responsibility is explicit.
_Avoid_: Adapter

**Artifact Generation**:
The adapter-owned process that produces target-shaped, deployable artifacts and the deployment manifest needed to transfer them to Yandex Cloud.
_Avoid_: Deployment

**Import Specifier**:
The string in an import expression that identifies what to load, per Node.js terminology. A bare Import Specifier names a package (`nanoid`, `@scope/pkg/sub`); relative paths, absolute paths, and `node:` builtins are not bare Import Specifiers.
_Avoid_: Import path

**Dependency**:
A package required at runtime by the Function Artifact. Install builds pin every Dependency to an exact version.
_Avoid_: Package

**Package JSON**:
The Function Artifact file that declares exact Dependency versions for installation.
_Avoid_: Package

**Deployment**:
The user-owned process that transfers generated artifacts to existing Yandex Cloud resources and connects them to request routing.
_Avoid_: Build, publish

**Request Routing**:
The user-owned connection that directs requests to a Serving Artifact. A Target Modifier may constrain its supported mechanisms, but Artifact Generation does not create the router.
_Avoid_: Deployment, target

**Provisioning**:
The user-owned process that creates or changes Yandex Cloud resources, identities, and permissions.
_Avoid_: Deployment
