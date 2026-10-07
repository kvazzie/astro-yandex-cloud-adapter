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
      { headers: { accept: "application/json" } },
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
      { headers: { accept: "application/json" } },
    );
  });
});
