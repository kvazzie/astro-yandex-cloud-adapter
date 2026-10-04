# Local S3 service for issue #11

Researched on 2026-10-03 and updated on 2026-10-04 for [issue #11](https://github.com/kvazzie/astro-yandex-cloud-adapter/issues/11), stacked on [PR #72](https://github.com/kvazzie/astro-yandex-cloud-adapter/pull/72).

## Recommendation

Use SeaweedFS in its single-process `weed mini` mode. It runs an S3 endpoint on port 8333 and can create the test bucket and credentials from environment variables. This fits the issue's upload, readback, listing, and update checks. [Official quick start](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini).

Use the repository's existing devenv configuration to manage SeaweedFS. Define a native `processes.s3.exec` using `pkgs.seaweedfs`, then run the Vitest S3 suite through `enterTest`. `devenv test` starts configured processes, runs the test script, and stops the processes afterward. Vitest connects to the configured endpoint and owns the object assertions. [Official devenv test documentation](https://devenv.sh/tests/), [process documentation](https://devenv.sh/processes/).

Testcontainers remains an alternative for infrastructure managed inside Vitest hooks, but devenv fits this repository's existing tooling. Its process lifecycle surrounds the complete test run. Use a temporary data directory and isolated test buckets, with explicit cleanup; stopping a process does not erase its data. A dedicated CI job would need Nix and devenv installed and would run the same `devenv test` command. [Official GitHub Actions integration](https://devenv.sh/integrations/github-actions/).

## Alternatives

| Service                 | Evidence                                                                                                                                                                                                                          | Decision for this issue                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| SeaweedFS               | The project documents PutObject, GetObject, HeadObject, ListObjectsV2, DeleteObject, and DeleteObjects. [Supported API list](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API).                                          | Recommended. A real object store with a short local startup procedure.                                                                          |
| MinIO community edition | The official repository was archived on 2026-04-25 and says it is no longer maintained. Its README describes source-only distribution and legacy binaries without updates. [Official repository](https://github.com/minio/minio). | Avoid introducing it as a new test dependency. Old images may run, but would commit us to an unmaintained service or maintaining our own build. |
| S3rver                  | It is a Node.js development server with put/get/list/delete and metadata support, but its repository was archived on 2025-09-14. [Official repository](https://github.com/jamhall/s3rver).                                        | The simpler in-process setup does not justify choosing an archived dependency.                                                                  |

This choice does not require a distributed storage cluster. The issue exercises ordinary objects and MIME metadata, so there is no need to provision replication, a storage console, or website hosting.

## Startup and pinning

The repository's `devenv.lock` pins nixpkgs source revision `c7def046b9a883d46974757852106483d741586f`, which provides SeaweedFS `4.46` and the `weed` binary. That version supports `weed mini`, including environment-driven bucket creation and credentials. Use that locked package for the native service. [Pinned package definition](https://github.com/NixOS/nixpkgs/blob/c7def046b9a883d46974757852106483d741586f/pkgs/by-name/se/seaweedfs/package.nix), [versioned mini command](https://github.com/seaweedfs/seaweedfs/blob/4.46/weed/command/mini.go).

The native startup command has this shape, with a temporary directory allocated for the test run:

```sh
AWS_ACCESS_KEY_ID=admin \
AWS_SECRET_ACCESS_KEY=secret \
S3_BUCKET=issue11-test \
weed mini -dir="$S3_TEST_DATA_DIR"
```

The environment variables configure test credentials and create the bucket. `S3_TEST_DATA_DIR` must point to a test-owned temporary directory, which the test runner removes after service shutdown. [Versioned startup implementation](https://github.com/seaweedfs/seaweedfs/blob/4.46/weed/command/mini.go).

The default S3 endpoint is `http://127.0.0.1:8333`. Pass the native service's configured endpoint to Vitest through environment configuration. Account for port conflicts across concurrent test runs. Configure the S3 client for path-style bucket addressing to avoid local bucket DNS setup.

Wait with a bounded retry loop for an authenticated `HeadBucket` on the configured bucket, rather than a fixed sleep or a TCP connection alone. This checks bucket creation and credentials as well as the listener. On timeout, report the last S3 error and container logs. This is a proposed readiness contract for our tooling.

## Object checks and limits

Send explicit `ContentType` with each PutObject. SeaweedFS 4.46 stores the request's Content-Type as the object's MIME attribute, defaulting to `application/octet-stream` when absent. Check `ContentType` with HeadObject and compare GetObject bytes against the generated file. [Versioned PutObject implementation](https://github.com/seaweedfs/seaweedfs/blob/4.46/weed/s3api/s3api_object_handlers_put.go).

For issue #11, derive the artifact directory, base, and page object keys from the Deployment Manifest. Enumerate the client artifact directory to include public files and browser assets; the manifest does not promise a full inventory or MIME map. Keep upload and MIME selection in test tooling, outside the Bare Adapter. Seed an unrelated object before the update and verify its bytes and metadata afterward. Repeat uploads and scope cleanup to test-owned objects.

SeaweedFS has directory semantics that differ from S3: a path cannot be both an object and a directory, and deleting a directory can delete its contents. Avoid ambiguous fixture keys and clean up exact file keys. Its API list marks GetBucketWebsite and PutBucketWebsite unsupported. These tests establish local object upload behavior only; they cannot establish Yandex website index, error, redirect, or other cloud-specific behavior. [Documented differences and API support](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API).

## Validation status

This recommendation uses current primary documentation and the versioned SeaweedFS source. The pinned Nix package and its `mini` command were checked in source. A disposable Docker smoke run with SeaweedFS 4.48 was attempted, but the image pull stopped making progress and was cancelled before startup. Neither a native service startup nor an object roundtrip has been verified. Verify startup, bytes, explicit Content-Type, overwrite behavior, listing, and exact-key deletion before finalizing the test service. Issue #11's integration tests remain to be implemented.
