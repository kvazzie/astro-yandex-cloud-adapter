# Yandex Cloud Adapter

This context describes how an Astro project becomes deployable artifacts for supported Yandex Cloud service arrangements. It ends when those artifacts and their deployment description have been produced.

## Deployment model

**Target**:
A supported arrangement of Yandex Cloud services that determines which artifacts a build must contain.
_Avoid_: Mode, platform, deployment

**Object Storage Target**:
The target that contains only a client artifact and accepts only static-only builds.
_Avoid_: Static target

**Object Storage + Cloud Functions Target**:
The target that places the client artifact in Object Storage and uses a function artifact for on-demand routes.
_Avoid_: Hybrid target, server target

**Client Artifact**:
The deployable files that require no application code to execute, including prerendered pages, public files, and browser assets. For the initial targets, these files are intended for Object Storage.
_Avoid_: Static files, Object Storage bundle

**Function Artifact**:
The deployable Cloud Functions source that renders on-demand routes when invoked directly over HTTPS or through a compatible user-owned router.
_Avoid_: Server bundle, Lambda artifact

**Deployment Manifest**:
A provider-neutral, schema-versioned, machine-readable declaration of an application's target, emitted artifacts, runtime requirements, and request-routing requirements. It contains only requirements and statements derived from the application and completed Artifact Generation—never guessed deployer policy, commands, provider-specific resource handles, or permission to allocate cloud resources.
_Avoid_: Build metadata, deployment configuration

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
The user-owned connection that directs requests to a client artifact or function artifact. It may use API Gateway or another compatible router and is not part of a target.
_Avoid_: Deployment, target

**Provisioning**:
The user-owned process that creates or changes Yandex Cloud resources, identities, and permissions.
_Avoid_: Deployment
