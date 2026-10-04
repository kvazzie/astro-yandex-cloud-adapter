# Artifact size reports and build paths

At the end of Artifact Generation, the adapter logs each generated Client and
Function Artifact's portable path, total local bytes, file count, and largest file.
It counts regular files recursively, including hidden files and generated Function
`package.json` and `package-lock.json` files. A Static-only Build reports only its
Client Artifact, even with the Object Storage + Cloud Functions Target selected.
Astro's log level controls whether the report appears.

These are file-content bytes on disk. They exclude filesystem overhead, ZIP
headers, compression, and dependencies that Cloud Functions installs later for an
`install` build. They are not the size of a deployment archive or HTTP payload.
The report performs no Deployment or Provisioning and needs no cloud credentials.

## Yandex limits

The following limits were checked against Yandex documentation on 2026-10-04.

| Service                                                                   | What the limit measures                             | Documented limit |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ---------------- |
| [Cloud Functions](https://yandex.cloud/en/docs/functions/concepts/limits) | ZIP uploaded through the management console         | 3.5 MB           |
| Cloud Functions                                                           | Compressed ZIP sourced from Object Storage          | 128 MB           |
| Cloud Functions                                                           | Unzipped archive sourced from Object Storage        | 680 MB           |
| Cloud Functions                                                           | JSON structure of an invocation request or response | 3.5 MB           |
| [API Gateway](https://yandex.cloud/en/docs/api-gateway/concepts/limits)   | Request or response                                 | 2.5 MB           |
| [Object Storage](https://yandex.cloud/en/docs/storage/concepts/limits)    | Single object                                       | 5 TB             |
| Object Storage                                                            | Data uploaded in a single request                   | 5 GB             |

The Client Artifact's total spans many objects. It is not subject to the
single-object limit. Larger uploads can require multipart upload.

The adapter warns if local Function bytes exceed a conservative comparison of
680,000,000 bytes, or if a Client file exceeds 5,000,000,000,000 bytes. These
comparisons use decimal MB and TB for the documented labels. Warnings do not fail
the build. Smaller local totals do not prove that a final archive, installed
dependencies, or request payload fits its service limits.

Deployment Products must check the actual compressed archive and its expanded
contents for the chosen upload method. They also own ingress checks. Invocation
JSON includes metadata and, for binary bodies, base64 encoding, so its limit is
not the maximum size of an application's raw request or response body.

## Portable adapter output

`yandex-cloud.json` identifies artifacts relative to the Manifest directory, for
example `client` and `function`. The adapter's size report uses those same paths.
Generated Function package metadata and lockfiles do not include the application's
build directory. Copying the application to another directory leaves the Deployment
Manifest unchanged.

The output tests search for the workspace root, both build directories, the home
directory, file URLs, and common Unix and Windows user-specific absolute paths.
They build Static-only, bundled runtime, and installed-dependency applications in
two separate directories, including directory names with spaces.

## Astro-owned path limitation

Astro 7 emits absolute build paths in Function JavaScript. These upstream records
remain in the artifact and can appear in runtime diagnostics:

- The serialized runtime manifest passed to `deserializeManifest` has `rootDir`,
  `srcDir`, `publicDir`, `outDir`, `cacheDir`, `buildClientDir`, and `buildServerDir`
  file URLs.
- Its `entryModules` map can have absolute module IDs as keys, including the
  adapter's server entrypoint and Astro's internal entrypoints. Values identify
  emitted modules using portable paths.
- Compiled Astro components pass absolute filenames to `createComponent` and
  store them in `$$file`. This includes application components and bundled Astro
  components such as `Image` and `Picture`.

These are distinct from the adapter's Deployment Manifest. Astro generates them
in its compiler and internal runtime-manifest plugin. Its manifest deserializer
requires absolute URLs, and there is no supported adapter hook to replace these
records with relative paths. Rewriting compiled application code or assigning
invented root directories could change Astro runtime behavior. The adapter leaves
those upstream records intact.

The output scan permits only the listed upstream records and scans the remaining
contents of every emitted file. New path locations fail the check. The Function
Artifact is therefore not entirely free of build paths; this limitation must stay
visible in the release documentation. Application-authored output and user-enabled
source maps can also contain paths and remain the application's responsibility.
