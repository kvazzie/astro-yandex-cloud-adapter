# Yandex Cloud Adapter

This context describes how an Astro project becomes deployable
artifacts for supported Yandex Cloud service arrangements. It
ends when those artifacts and their deployment description have
been produced.

## [_Deployment_](#deployment) model

### _Target_

A supported arrangement of Yandex Cloud services selected through
[_Options_](#options) to shape
[_Artifact Generation_](#artifact-generation). Each concrete
variant describes an infrastructure arrangement with its own
compatible builds and artifact requirements; the common concept
enumerates those arrangements without adding rules of its own.
The arrangements are defined independently of the
[_Bare Adapter_](#bare-adapter), which builds for them. The
[_Deployment Manifest_](#deployment-manifest) describes the
artifacts actually produced by the build. _Avoid_: Mode,
platform, deployment

### _Options_

An immutable configuration Value Object for the
[_Bare Adapter_](#bare-adapter) that selects exactly one
_Target_, its applicable [_Target Modifiers_](#target-modifier),
and any _Target_-specific settings. The _Bare Adapter_ admits
valid combinations of _Options_ for each selected _Target_;
equality uses the effective settings after defaults have been
applied.

#### _Object Storage Target Options_

The _Options_ variant that selects the
[_Object Storage Target_](#object-storage-target) and admits its
supported _Target Modifiers_ and settings.

#### _Object Storage + Cloud Functions Target Options_

The _Options_ variant that selects the
[_Object Storage + Cloud Functions Target_](#object-storage--cloud-functions-target)
and admits its supported _Target Modifiers_ and settings.

### _Target Modifier_

One of the supported refinements selected through _Options_ to
shape _Artifact Generation_ without performing _Deployment_ or
[_Provisioning_](#provisioning). The modifier family is the union
of its concrete variants; their availability and valid
combinations depend on the selected _Target_.

#### _API Gateway Modifier_

A _Target Modifier_ for every supported _Target_ that prepares a
build for [_Request Routing_](#request-routing) through API
Gateway. The API Gateway resource and its final configuration
remain user-owned.

### _Object Storage Target_

The Object Storage service arrangement for serving a
[_Client Artifact_](#client-artifact). The adapter supports only
[_Static-only Builds_](#static-only-build) for this _Target_.
_Avoid_: Static target

### _Object Storage + Cloud Functions Target_

The Object Storage and Cloud Functions service arrangement for
serving a _Client Artifact_ and any
[_Function Artifacts_](#function-artifact) required by
[_On-demand Routes_](#on-demand-route). The adapter's supported
invocation contract restricts direct Function URLs to stateless
user-defined endpoints and uses the _API Gateway Modifier_ for
on-demand pages and Astro's internal endpoints. _Avoid_: Hybrid
target, server target

### _Serverless Container Target_

A planned supported Serverless Containers service arrangement for
serving the application over HTTP from a
[_Container Artifact_](#container-artifact), directly or through
API Gateway.

### _Client Artifact_

A Value Object containing deployable files that require no
application code to execute, including prerendered pages, public
files, and browser assets. For _Object Storage Targets_, these
files are intended for Object Storage. _Avoid_: Static files,
Object Storage bundle

### _Function Artifact_

A Value Object containing deployable Cloud Functions source that
serves _on-demand routes_ when invoked directly over HTTPS or
through a compatible user-owned router. _Avoid_: Server bundle,
Lambda artifact

### _Container Artifact_

A Value Object containing application code and assets prepared
for Serverless Containers to serve requests directly over HTTPS
or through a compatible user-owned router.

### _Serving Artifact_

A _Client Artifact_, _Function Artifact_, or _Container Artifact_
Value Object selected to produce the response to a request.
_Avoid_: Route infrastructure

### _Serving Artifact's Target_

The concrete Yandex Cloud service within the selected _Target_
that serves a _Serving Artifact_: Object Storage for a _Client
Artifact_, Cloud Functions for a _Function Artifact_, or
Serverless Containers for a _Container Artifact_. This names a
service, not the _Target_ of the whole build.

### Errors

#### _Options Input Rejection_

A [_Rejection_](#rejection) of external adapter configuration
that cannot be decoded into valid _Options_ describing a
supported selection of _Target_, _Target Modifiers_, and
_Target_-specific settings.

[Details](docs/domain-errors.md#options-input-rejection).

#### _Build Configuration Rejection_

A _Rejection_ of externally supplied build settings that cannot
be accepted for the selected _Target_ or
[_dependency_](#dependency) strategy. Invalid settings generated
by the adapter itself violate a producer guarantee.

[Details](docs/domain-errors.md#build-configuration-rejection).

## Rendering model

### _Prerendered Route_

A route whose response is produced during the build and included
in the _client artifact_. _Avoid_: Static route

### _On-demand Route_

A route whose response requires application code to execute for a
request. _Avoid_: Dynamic route, SSR route

### _404 Scope_

A URL prefix whose explicit custom 404 page is the nearest
fallback for an unknown page request. Scopes may be nested when
recursive 404 handling is selected.

### _Static-only Build_

A build containing no _on-demand routes_, regardless of whether
an adapter is configured. _Avoid_: Static output

### _Runtime Build_

A build containing at least one _on-demand route_, including an
Astro `output: "static"` project with a route that opts out of
prerendering. _Avoid_: Hybrid build, server build

### Errors

#### _Unsupported Target Route Error_

A [_Domain Error_](#domain-error) in which valid route execution
requirements cannot be served by the selected valid _Target_. No
invalid route assignment is accepted.

[Details](docs/domain-errors.md#unsupported-target-route-error).

#### _Unsupported Direct Invocation Route Error_

A _Domain Error_ in which a valid _On-demand Route_ requires
features beyond the selected
[_Direct Function Invocation_](#direct-function-invocation)
contract for stateless user-defined endpoints.

[Details](docs/domain-errors.md#unsupported-direct-invocation-route-error).

#### _On-demand 404 Page Error_

A _Domain Error_ in which a valid custom 404 route requires
request-time execution while the selected fallback contract
requires a _Prerendered Route_.

[Details](docs/domain-errors.md#on-demand-404-page-error).

## Artifact preparation

### _Target Build_

A build scenario of the [_Bare Adapter_](#bare-adapter) for one
selected [_Target_](#target), defining supported build
requirements and preparation of its
[_Build Result_](#build-result).

#### _Object Storage Target Build_

The _Target Build_ for the
[_Object Storage Target_](#object-storage-target).

#### _Object Storage + Cloud Functions Target Build_

The _Target Build_ for the
[_Object Storage + Cloud Functions Target_](#object-storage--cloud-functions-target).

### _Artifact Generation_

The adapter-owned process that produces a
[_Build Result_](#build-result) shaped by the selected _Target_,
ready for transfer to Yandex Cloud. _Avoid_: Deployment

### _Build Result_

An immutable Value Object containing the complete generated
_Serving Artifacts_, their _Deployment Manifest_, and the
optional
[_API Gateway Specification Template_](#api-gateway-specification-template)
from one successful _Artifact Generation_. Equality depends on
the artifacts' relative paths and file contents and on the
contents of the manifest and template; build-run timestamps and
other debug metadata are outside this value.

### Errors

#### _Artifact Read Failure_

Inability to inspect or read emitted _Serving Artifacts_ or
required completed-build evidence in the build environment.

[Details](docs/domain-errors.md#artifact-read-failure).

#### _Artifact Write Failure_

Inability to create, copy, replace, or remove files required to
complete _Artifact Generation_ in the build environment.

[Details](docs/domain-errors.md#artifact-write-failure).

## Function _dependencies_

### _Import Specifier_

The string in an import expression that identifies what to load,
per Node.js terminology. A bare _Import Specifier_ names a
package (`nanoid`, `@scope/pkg/sub`); relative paths, absolute
paths, and `node:` builtins are not bare _Import Specifiers_.
_Avoid_: Import path

### _Dependency_

A package required at runtime by the _Function Artifact_. Install
builds pin every _Dependency_ to an exact version. _Avoid_:
Package

### _Package JSON_

The _Function Artifact_ file that declares exact _Dependency_
versions for installation. _Avoid_: Package

### Errors

#### _Unsupported Function Module_

A module required by a _Function Artifact_ whose emitted format
is outside the supported runtime module contract.

[Details](docs/domain-errors.md#unsupported-function-module).

#### _Unresolved Runtime Import_

A retained runtime package _Import Specifier_ for which the
selected _Function Artifact_ strategy provides no delivery
mechanism.

[Details](docs/domain-errors.md#unresolved-runtime-import).

#### _Unsupported Native Dependency Error_

A _Domain Error_ in which a valid native runtime _Dependency_
cannot be delivered under the selected _Function Artifact_
_dependency_ strategy.

[Details](docs/domain-errors.md#unsupported-native-dependency-error).

#### _Unsupported Runtime Dependency Resolution_

Runtime _Dependency_ selection that cannot be enumerated into the
fixed imports and exact versions required to prepare a _Function
Artifact_.

[Details](docs/domain-errors.md#unsupported-runtime-dependency-resolution).

#### _Dependency Resolution Failure_

Inability to select a runtime _Dependency_ at an exact version
that satisfies the requirements of the _Function Artifact_.

[Details](docs/domain-errors.md#dependency-resolution-failure).

#### _Dependency Metadata Failure_

Inability to obtain or interpret the package metadata needed to
prepare the runtime _Dependency_ graph of a _Function Artifact_.

[Details](docs/domain-errors.md#dependency-metadata-failure).

## _Manifest_ contract

### _Deployment Manifest_

A schema-versioned, machine-readable Value Object declaring
emitted _Serving Artifacts_ and their runtime and request-routing
requirements. It records the selected _Target_ and _Target
Modifier_ provenance, without guessed deployer policy, commands,
resource handles, or permission to allocate cloud resources.
_Avoid_: Build metadata, deployment configuration

### Errors

#### _Deployment Manifest Input Rejection_

A _Rejection_ of externally supplied data that cannot be decoded
into a valid _Deployment Manifest_ satisfying its structure and
consistency rules.

[Details](docs/domain-errors.md#deployment-manifest-input-rejection).

## Routing model

### _Request Routing_

The user-owned connection that directs requests to a _Serving
Artifact_. A _Target Modifier_ may constrain its supported
mechanisms, but _Artifact Generation_ does not create the router.
_Avoid_: Deployment, target

### _API Gateway Specification Template_

A Value Object containing an OpenAPI description of the build's
page and endpoint _Request Routing_ through API Gateway, derived
from the same route requirements as the _Deployment Manifest_
when the _API Gateway Modifier_ is selected. _Deployment_
supplies resource identifiers and may customize the
specification.

### Errors

#### _Gateway Route Incompatibility Error_

A _Domain Error_ in which valid _Request Routing_ requirements
cannot be faithfully represented by the supported _API Gateway
Specification Template_. Missing or contradictory evidence from
our own route planner is a producer defect.

[Details](docs/domain-errors.md#gateway-route-incompatibility-error).

#### _Oversized Gateway Template_

An _API Gateway Specification Template_ whose generated size
exceeds the supported specification size bound.

[Details](docs/domain-errors.md#oversized-gateway-template).

## Function invocation

### _Direct Function Invocation_

A request to a _Function Artifact_ through its Cloud Functions
URL without API Gateway. This arrangement serves stateless
user-defined endpoints.

### _Function Runtime Bridge_

A reusable translation between Yandex Cloud Functions invocations
and Web Standards requests and responses. Its compatibility is
established against real Yandex Cloud deployments and then shared
by products that emit _Function Artifacts_. _Avoid_: Runtime
transformer, function adapter

### Errors

#### _Function Invocation Rejection_

A _Rejection_ of externally supplied invocation data that cannot
be converted into a valid request under the supported HTTPS event
contract of the _Function Runtime Bridge_.

[Details](docs/domain-errors.md#function-invocation-rejection).

#### _Missing Request Origin Rejection_

A _Rejection_ of an external invocation whose event and
configured application origin do not provide the origin required
to construct a request.

[Details](docs/domain-errors.md#missing-request-origin-rejection).

#### _Direct Request Target Rejection_

A _Rejection_ of an external _Direct Function Invocation_ whose
provider wrapper does not identify exactly one valid local
application request target.

[Details](docs/domain-errors.md#direct-request-target-rejection).

#### _Direct Request Origin Rejection_

A _Rejection_ of an external _Direct Function Invocation_ whose
incoming Origin is not authorised by the configured direct
application origin policy.

[Details](docs/domain-errors.md#direct-request-origin-rejection).

## Responsibility boundary

### _Bare Adapter_

An Astro adapter that performs _Artifact Generation_ without
executing _Deployment_ or _Provisioning_. _Avoid_: Deployer,
deployment adapter

### _Hook_

A lifecycle callback of an Astro integration, invoked by Astro at
a named stage of configuration, development, or building.

### _Deployment Product_

A tool that interprets a _deployment manifest_ and executes
_Deployment_. A _deployment product_ may also perform
_Provisioning_ when that responsibility is explicit. _Avoid_:
Adapter

### _Deployment_

The user-owned process that transfers generated artifacts to
existing Yandex Cloud resources and connects them to _request
routing_. _Avoid_: Build, publish

### _Provisioning_

The user-owned process that creates or changes Yandex Cloud
resources, identities, and permissions. _Avoid_: Deployment

## Error model

### _Domain Error_

A named negative outcome of an operation on valid domain inputs,
justified by declared domain requirements or external
circumstances. It preserves valid state; a private implementation
restriction or a broken producer guarantee does not by itself
establish a domain requirement.

### _Rejection_

A decision that declines external input when validation cannot
produce admissible values for the requested operation. This
prevents invalid domain state from being accepted; it does not
classify an internally broken domain guarantee as invalid user
input.

### _Failure_

An operation's inability to achieve its intended result in build
or invocation work. The word alone does not establish domain
ownership or distinguish an external obstacle from a defect in
our implementation.
