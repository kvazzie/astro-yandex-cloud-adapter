# [_Function Runtime Bridge_](../../GLOSSARY.md#function-runtime-bridge)

`@astro-yandex-cloud/function-runtime-bridge` implements the
_Function Runtime Bridge_. It translates Yandex Cloud Functions
HTTP invocations and API Gateway payload `0.1` into Web Standards
`Request` and `Response` objects. It runs on Node.js `>=22.12.0`
and depends on Effect.

The package has no dependency on Astro or other workspace
packages. Consumers import its root export. The package exports
`toWebRequest`, `fromWebResponse`, `getClientAddress`, `invoke`,
`Errors`, and the provider types, including
`FunctionInvocationOptions`.

`toWebRequest` accepts an optional fallback origin used when the
event has no Host header. For
[_Direct Function Invocation_](../../GLOSSARY.md#direct-function-invocation),
pass `apiGateway: false` and `requestTargetParameter`, the name
of the outer query parameter carrying the application's path and
query. `directOrigin` authorises browser Origin headers for
direct requests. The fallback origin does not grant that
permission. With `apiGateway: true`, the incoming path and query
remain the application request target.

`fromWebResponse` preserves response body bytes. A nonempty
textual body without a `Content-Encoding` header remains a plain
string only when its bytes are valid UTF-8. The conversion keeps
a leading UTF-8 byte order mark. Other nonempty bodies use base64
with `isBase64Encoded: true`, including compressed text and
non-UTF-8 text. The bridge does not decompress or transcode the
body. Empty bodies remain `""` with `isBase64Encoded: false`.
Status and headers are retained, with separate `Set-Cookie`
values in `multiValueHeaders`.

This follows the documented
[Cloud Functions response contract](https://yandex.cloud/en/docs/functions/concepts/function-invoke#response)
used with direct HTTPS invocation and the
[API Gateway Cloud Functions integration](https://yandex.cloud/en/docs/api-gateway/concepts/extensions/cloud-functions).
Base64 contributes to the provider's
[3.5 MB JSON response limit](https://yandex.cloud/en/docs/functions/concepts/limits).
Local byte round-trip tests do not establish real-cloud
conformance.

`invoke` returns an Effect and calls a supplied renderer with the
`Request`, trusted client address, and original
`{ event, context }`. It translates the renderer's `Response` to
the provider result. Malformed direct requests become HTTP 400 or
403 responses; other failures remain failed Effects. The consumer
supplies framework locals, route matching, and error-page
handling.

The package is private while it evolves in this monorepo. The
[_Bare Adapter_](../../GLOSSARY.md#bare-adapter) bundles it into
its published output. Its manifest declares its runtime
dependency, and its build produces a root export with types.
Publication and repository extraction can be introduced later.
Real-cloud conformance remains pending.

From this directory, `pnpm build` builds the root export and
`pnpm typecheck` checks the sources. The repository's Vitest unit
suite exercises that export in
[`tests/unit/runtime.test.ts`](../../tests/unit/runtime.test.ts).
From the repository root, run `pnpm test:unit` to build the
package and execute the unit suite. Generated-handler and
installed-package checks verify its use through the adapter.
