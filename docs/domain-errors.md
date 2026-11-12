# Build and invocation errors

This guide explains the named problems in the
[glossary](../GLOSSARY.md), including boundary input validation
and domain operation outcomes. A glossary entry does not by
itself establish that the problem is a
[_Domain Error_](../GLOSSARY.md#domain-error), or that a matching
error type already exists.

A [_Rejection_](../GLOSSARY.md#rejection) reports that external
input cannot be accepted. For option decoding, raw configuration
is rejected before valid [_Options_](../GLOSSARY.md#options)
exist. The _Rejection_ describes the caller's input, rather than
claiming the model accepted an invalid state. This validation
role can live in the same module as the valid values it
constructs.

A _Domain Error_ is a negative outcome grounded in declared
domain requirements or external circumstances while valid state
is preserved. For example, a valid route requiring application
execution cannot be assigned solely to files that execute no
application code. A correct planning operation reports the
incompatibility; producing a route assignment that contradicts
those requirements violates our own guarantees.

If supported input and available resources should produce a valid
result under the declared contract, our inability to produce it
is a defect. Adding a named error does not make that supported
behaviour optional. Establish the input, producer, and violated
guarantee before labelling such a case as unsupported input or a
_Domain Error_.

[_Failure_](../GLOSSARY.md#failure) describes an operation that
did not achieve its result. It does not automatically establish
that the problem belongs to the domain. Identify the operation,
input provenance, cause, and guarantees before choosing its error
category; an external I/O obstacle and an invalid object produced
by our code need different diagnostics.

Use "exception" only for the technical mechanism of throwing an
error with `throw` and catching it with `catch`. Returning an
error as a value or carrying it in an error channel does not by
itself make it an exception. The mechanism does not establish the
error's category.

A failed build can leave partial output. Rebuild after correcting
its cause and use artifacts from one successful build for
[_Deployment_](../GLOSSARY.md#deployment). Cloud resource
creation, permissions, uploads, and service acceptance remain
outside
[_Artifact Generation_](../GLOSSARY.md#artifact-generation).

For maintainers, the
[implementation audit](domain-error-audit.md) records current
classification gaps and unresolved evidence separately.

## _Deployment_ model

### [_Options Input Rejection_](../GLOSSARY.md#options-input-rejection)

Unknown properties, unsupported values, and combinations that the
selected [_Target_](../GLOSSARY.md#target) does not admit belong
here. For example, `recursive404: true` needs `apiGateway: true`;
`functions` and `dependencyStrategy` belong to the
[_Object Storage + Cloud Functions Target_](../GLOSSARY.md#object-storage--cloud-functions-target).
`directOrigin` belongs only to its direct invocation arrangement
and must describe an HTTP or HTTPS origin without credentials, a
non-root path, query, or fragment.

Correct the selection in the application's configuration.
Configuration cannot proceed until it describes a supported
arrangement. See the
[configuration guide](../packages/adapter/README.md#choose-a-target).

### [_Build Configuration Rejection_](../GLOSSARY.md#build-configuration-rejection)

A `bundle` build cannot retain user-configured Vite SSR package
externals other than Node builtins. An `install` build cannot use
blanket `vite.ssr.noExternal: true`, because it needs runtime
package imports to remain available for installation. The
[_Object Storage Target_](../GLOSSARY.md#object-storage-target)
also applies the bundle externals check.

Remove the conflicting setting or choose a compatible
[_dependency_](../GLOSSARY.md#dependency) strategy for a Function
build. Explicit package lists can describe packages that should
be bundled under `install`. The build stops when these
requirements conflict.

## Rendering model

### [_Unsupported Target Route Error_](../GLOSSARY.md#unsupported-target-route-error)

The _Object Storage Target_ accepts
[_Static-only Builds_](../GLOSSARY.md#static-only-build). A
user-defined or active internal
[_On-demand Route_](../GLOSSARY.md#on-demand-route) requires a
[_Function Artifact_](../GLOSSARY.md#function-artifact) and
cannot be served by that _Target_.

Prerender the route, remove the runtime requirement, or select
the _Object Storage + Cloud Functions Target_. Compatibility
checks inspect both registered routes and completed output,
because internal runtime requirements may become apparent during
the build.

### [_Unsupported Direct Invocation Route Error_](../GLOSSARY.md#unsupported-direct-invocation-route-error)

On-demand pages and active internal endpoints, including Actions
and server islands, require the
[_API Gateway Modifier_](../GLOSSARY.md#api-gateway-modifier). A
stateless Astro Action still belongs to this restriction.

Select `apiGateway: true` or change the application to fit the
direct-endpoint contract. Adding a router after a build does not
change the invocation arrangement selected during _Artifact
Generation_.

### [_On-demand 404 Page Error_](../GLOSSARY.md#on-demand-404-page-error)

The supported custom 404 arrangement needs completed HTML that
can be retained in the
[_Client Artifact_](../GLOSSARY.md#client-artifact) and copied
into page-serving _Function Artifacts_ where required.

Add `export const prerender = true` to the custom page and
provide any static paths it needs. An _On-demand Route_ that ends
in `/404` cannot satisfy this arrangement.

## Artifact preparation

### [_Artifact Read Failure_](../GLOSSARY.md#artifact-read-failure)

Examples include an unreadable emitted module, a _Client
Artifact_ page removed by another process, or denied access to a
required output directory. Restore access, stop competing output
cleanup, and rebuild from complete output.

This condition concerns the environment's availability of
required output. If the adapter never produced a file that its
own generation guarantees, investigate that producer as a defect.
Preserve the operation, path, and underlying cause in
diagnostics. An optional size-report read has a different outcome
described under [warnings](#non-blocking-warnings).

### [_Artifact Write Failure_](../GLOSSARY.md#artifact-write-failure)

_Artifact Generation_ writes package metadata, retained 404
pages, partitioned Function files, the
[_Deployment Manifest_](../GLOSSARY.md#deployment-manifest), and
the optional
[_API Gateway Specification Template_](../GLOSSARY.md#api-gateway-specification-template).
It also needs to remove intermediate output. Permission denial, a
read-only location, exhausted storage, or concurrent modification
can prevent these operations.

Restore writable output and enough storage, then rebuild. Partial
files may remain after a failed operation; their presence does
not establish a complete artifact set. The failed operation and
underlying cause distinguish this condition from a defect in the
generated content.

## Function _dependencies_

### [_Unsupported Function Module_](../GLOSSARY.md#unsupported-function-module)

The current emitted artifact contract requires ESM and rejects
`.cjs` files. Use a compatible module or build transformation.

Establish who produced the unsupported file. An
application-selected format outside the contract requires a build
change; an adapter that unexpectedly produces that format under
supported settings needs a compatibility investigation.

### [_Unresolved Runtime Import_](../GLOSSARY.md#unresolved-runtime-import)

A `bundle` artifact must execute without installing application
packages. A bare package import left in that artifact has no
declared installation step.

Arrange for the build to bundle a fixed import, or select
`install` so the _Dependency_ can be pinned and installed. If the
supported bundle configuration unexpectedly leaves an import
behind, preserve that build as a reproduction of the producer's
behaviour.

### [_Unsupported Native Dependency Error_](../GLOSSARY.md#unsupported-native-dependency-error)

The `bundle` strategy rejects emitted or referenced `.node`
modules and retained `sharp` package imports. Native code
requires `install` under the current contract.

Select `install` and verify the package against the intended
runtime. Local installation does not establish Yandex Cloud
compatibility; Sharp remains experimental with this strategy.

### [_Unsupported Runtime Dependency Resolution_](../GLOSSARY.md#unsupported-runtime-dependency-resolution)

Computed runtime imports and computed `require` calls can leave
the package identity unknown during _Artifact Generation_. A
supported strategy needs that identity to bundle the package or
describe its installation. The implementation recognises a
specific Astro logger import separately.

Use fixed imports or arrange for the build to resolve the
computation. Switching to `install` alone does not make computed
_Dependency_ selection supported.

### [_Dependency Resolution Failure_](../GLOSSARY.md#dependency-resolution-failure)

An `install` build needs an installed application _Dependency_
with a discoverable version. Required child packages must satisfy
their declared version ranges. Optional packages absent on the
build host can require exact registry resolution too.

Install the missing or matching _Dependency_ and rebuild. A
package that exists but cannot be read is not proven absent;
inspect metadata access before changing versions. A registry
requirement with no matching version also belongs to this
condition.

### Multiple installed dependency versions

`install` preserves distinct installed versions and peer contexts
in nested npm lockfile locations. It does not select a common
version or require a flat tree. The former
`conflicting versions of the runtime package` guard was a private
representation defect, not an established _Domain Error_. See the
[dependency representation finding](domain-error-audit.md#dependency-graph-representation)
for its history and regression evidence.

### [_Dependency Metadata Failure_](../GLOSSARY.md#dependency-metadata-failure)

Metadata can come from installed packages, a matching local
lockfile, or the configured registry. Filesystem access,
malformed metadata, network errors, timeouts, and registry HTTP
errors can prevent its use. Metadata for an optional package may
still be necessary to retain its supported runtime variant.

Restore readable local metadata or access to the configured
registry and verify the named package/version. A package that
genuinely has no matching version is a _Dependency Resolution
Failure_. Local metadata reads preserve non-absence errors and
their causes; only missing path candidates continue to another
location.

## _Manifest_ contract

### [_Deployment Manifest Input Rejection_](../GLOSSARY.md#deployment-manifest-input-rejection)

The parser validates schema version, required fields, supported
runtime and entrypoint values, relative paths, canonical URLs,
base placement, and artifact references. It also checks agreement
between the _Target_,
[_Target Modifiers_](../GLOSSARY.md#target-modifier), actual
artifacts, invocation metadata, and
[_404 Scopes_](../GLOSSARY.md#404-scope). Version 1 accepts
additive fields, including nested fields.

Use a complete _Manifest_ from the matching build and a consumer
that supports its version. Correct an external transformation
that duplicates IDs or routes, breaks references, or combines
incompatible fragments. `parseDeploymentManifest` throws a
`TypeError` beginning with `Invalid Deployment Manifest:`;
invalid JSON fails in the caller's JSON reader first. Parsing
does not establish that declared files or cloud resources exist.

A freshly generated _Manifest_ with broken IDs or references
guaranteed by our pipeline indicates a generation defect. Its
rejection by the same parser does not change ownership.

## Routing model

### [_Gateway Route Incompatibility Error_](../GLOSSARY.md#gateway-route-incompatibility-error)

Whole-segment parameters are supported; compound segments such as
`[name]-[id]` and multiple rest parameters are outside the
supported grammar. Overlapping routes can also fail when Gateway
would choose a different
[_Serving Artifact_](../GLOSSARY.md#serving-artifact) than Astro,
or when generation cannot establish a consistent winner.

Simplify or prerender the routes, remove the overlap, or use a
compatible invocation arrangement. Shared Functions can resolve
overlaps between _On-demand Routes_ internally. They cannot
repair a precedence conflict between a _Client Artifact_ route
and a Function route. Disabling the _API Gateway Modifier_ still
leaves the direct-endpoint restrictions in force.

### [_Oversized Gateway Template_](../GLOSSARY.md#oversized-gateway-template)

Generation currently rejects a formatted template larger than
3,500,000 bytes. A large number of concrete
[_prerendered routes_](../GLOSSARY.md#prerendered-route) can
reach this bound.

Reduce the generated route count or choose a compatible routing
arrangement. _Deployment_ must separately check the final
customised specification. The implementation's comparison does
not verify current cloud limits or acceptance.

## Function invocation

### [_Function Invocation Rejection_](../GLOSSARY.md#function-invocation-rejection)

The bridge explicitly rejects a non-object event and an empty
HTTP method. Other invalid event fields can fail Web Request
construction. Correct the caller or router so it supplies the
supported HTTPS invocation format.

These errors propagate from the handler; the bridge does not
promise a general HTTP status for them. A supported provider
event that the bridge mishandles instead requires a compatibility
investigation. Real-cloud conformance remains pending.

### [_Missing Request Origin Rejection_](../GLOSSARY.md#missing-request-origin-rejection)

Gateway requests need an incoming `Host` or configured Astro
`site`. Direct requests can use configured `directOrigin`;
otherwise they also need `Host` or `site`. Forwarded origin
headers do not replace these prerequisites.

Supply the supported event information or application
configuration. The explicit missing-origin check throws
`TypeError` and propagates without a promised HTTP 400 or 403
response.

### [_Direct Request Target Rejection_](../GLOSSARY.md#direct-request-target-rejection)

The reserved query parameter must occur exactly once and contain
a local absolute `path?query`. Malformed encoding, an external or
protocol-relative URL, a fragment, literal whitespace,
backslashes, decoded path control characters, and `.` or `..`
path segments are rejected.

Read the parameter name from
`directInvocation.requestTargetParameter`. Pass the complete
original target, including the application's base, once to
`URLSearchParams.set`. Do not pre-encode it. The generated
handler returns HTTP 400 with
`Invalid or missing direct request target.`

### [_Direct Request Origin Rejection_](../GLOSSARY.md#direct-request-origin-rejection)

Any supplied `Origin` must match configured `directOrigin`. Form
submissions also require both values to be present. The form
check covers methods other than GET, HEAD, and OPTIONS with
URL-encoded, multipart, or plain-text content.

Configure the trusted form origin and submit from that origin.
Check conflicting repeated Origin headers. Astro `site` alone
does not grant permission. The generated handler returns HTTP 403
when the trust requirement fails. See the
[direct invocation guide](../packages/adapter/README.md#constrained-direct-function-invocation).

## Application and response errors

Errors raised by the external renderer or while reading its
response body retain their original ownership. Passing through
the
[_Function Runtime Bridge_](../GLOSSARY.md#function-runtime-bridge)
does not make them _Domain Errors_. A response returned by the
application or Astro, including a validation error, 404, or 500,
keeps its status through successful translation.

A retained 404 file that becomes unreadable after _Deployment_
can prevent fallback serving. Restore the complete readable
_Function Artifact_. If generation omitted a file that its own
policy guarantees, investigate the producer as a defect.

## Local preview errors

Local preview consumes generated output and has its own
observable outcomes.

| Trigger and prerequisite                                                                                                      | Observable result and action                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The _Manifest_ cannot be read, parsed as JSON, or validated, or an existing server entrypoint cannot be accessed or imported. | Preview startup fails. Restore readable output from a successful build. Import errors may originate in application code or incomplete _Dependencies_.                                                                                        |
| The requested preview host/port cannot be used.                                                                               | Preview startup fails. Choose an available address and check local OS permissions.                                                                                                                                                           |
| A required _Client Artifact_ or retained 404 file cannot be read, or request handling throws.                                 | Preview logs the error and responds with HTTP 500. Restore readable artifacts; inspect the underlying cause for application or adapter defects. A missing candidate file can instead lead to another candidate, a fallback, or a normal 404. |

An absent server entrypoint alone is accepted by preview for
static serving. A normal unmatched route or rejection by a
Function's route policy produces a 404; it is not automatically a
failed build or adapter defect.

Implementation: [preview](../packages/adapter/src/.preview.ts).

## Non-blocking warnings

| Trigger                                                                                                            | Observable result and action                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local _Function Artifact_ bytes exceed 680,000,000, or one _Client Artifact_ file exceeds 5,000,000,000,000 bytes. | The size reporter warns and the build continues. Check the final upload/archive with the [_Deployment Product_](../GLOSSARY.md#deployment-product); reduce or split output if needed. These are advisory comparisons implemented by the reporter.                                       |
| Reading generated artifacts for the size report fails.                                                             | The [_Hook_](../GLOSSARY.md#hook) warns `Could not read generated artifacts for the size report. The build continues.` Restore access and inspect artifact sizes separately. This recovery applies to reporting after _Artifact Generation_, not to required artifact reads and writes. |

The report does not validate ZIP size, installed _Dependency_
size, cloud quotas, or invocation payload acceptance. See
[artifact reports](artifact-reports.md). Implementation:
[reporter](../packages/adapter/src/mandatory/ArtifactGeneration/.sizeReport.ts)
and [_Hook_ recovery](../packages/adapter/src/Hooks/index.ts).
Existing checks:
[size report tests](../tests/unit/build-report.test.ts).
