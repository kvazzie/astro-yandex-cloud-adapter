import { afterEach, describe, expect, it, vi } from "vitest";

import { npmRegistry } from "../../packages/adapter/src/function/registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("install registry metadata", () => {
  it("uses the configured registry without duplicate trailing slashes", async () => {
    vi.stubEnv("npm_config_registry", "https://mirror.example/npm///");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ version: "1.0.0" })));
    await npmRegistry.resolve("@scope/pkg", "1.0.0");
    expect(fetch).toHaveBeenCalledWith(
      "https://mirror.example/npm/%40scope/pkg/1.0.0",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it("pins missing optional package ranges from registry metadata", async () => {
    vi.stubEnv("npm_config_registry", undefined);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: {
            "1.0.0": {},
            "1.2.0": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
            "2.0.0": {},
          },
        }),
      ),
    );
    expect(await npmRegistry.resolve("native-helper", "^1.0.0")).toMatchObject({
      version: "1.2.0",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/native-helper",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it("reports an actionable error when a stalled registry request times out", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Registry request timed out", "TimeoutError");
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(reason);
          });
        }),
    );
    const request = npmRegistry.resolve("stalled-package", "1.0.0");
    controller.abort(reason);
    await expect(request).rejects.toMatchObject({
      message:
        'The "install" dependency strategy cannot resolve the runtime package "stalled-package@1.0.0" from the npm registry. Check network access and try again.',
      cause: reason,
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
});
