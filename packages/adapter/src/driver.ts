import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import { prepareFunctionArtifact, writeDeploymentManifest } from "./artifacts.js";
import { ADAPTER_NAME } from "./constants.js";
import type { AdapterOptions } from "./types.js";

interface CompletedBuild {
  config: AstroConfig;
  onDemand: string[];
  prerendered: string[];
}

export interface TargetDriver {
  configureBuild(outDir: URL): Record<string, unknown>;
  assertRoutesSupported(onDemand: string[]): void;
  adapter(hasOnDemandRoutes: boolean): AstroAdapter;
  completeBuild(build: CompletedBuild): Promise<void>;
}

const supportedAstroFeatures: AstroAdapter["supportedAstroFeatures"] = {
  staticOutput: "stable",
  hybridOutput: "stable",
  serverOutput: "stable",
  sharpImageService: {
    support: "limited",
    message:
      "Sharp is externalized and has limited support in Yandex Cloud Functions.",
  },
  envGetSecret: "stable",
  i18nDomains: "unsupported",
};

function adapter(hasOnDemandRoutes: boolean): AstroAdapter {
  return {
    name: ADAPTER_NAME,
    entrypointResolution: "auto",
    serverEntrypoint: new URL("./server.js", import.meta.url),
    previewEntrypoint: new URL("./preview.js", import.meta.url),
    adapterFeatures: {
      buildOutput: hasOnDemandRoutes ? "server" : "static",
      middlewareMode: "classic",
      preserveBuildClientDir: true,
    },
    supportedAstroFeatures,
  };
}

export function createDriver(options: AdapterOptions | undefined): TargetDriver {
  const target = options?.target ?? "object-storage";
  if (target !== "object-storage" && target !== "object-storage-functions") {
    throw new TypeError(`Unknown Yandex Cloud adapter target: ${String(target)}.`);
  }

  if (target === "object-storage") {
    return {
      configureBuild: (outDir) => ({ client: new URL("client/", outDir) }),
      assertRoutesSupported: (onDemand) => {
        if (!onDemand.length) return;
        throw new Error(
          `The object-storage target cannot serve on-demand routes: ${onDemand.join(", ")}. ` +
            'Use target "object-storage-functions" or prerender these routes.',
        );
      },
      adapter,
      completeBuild: async ({ config, onDemand, prerendered }) => {
        await writeDeploymentManifest(config.outDir, config, {
          target,
          hasFunction: false,
          onDemand,
          prerendered,
        });
      },
    };
  }
  return {
    configureBuild: (outDir) => ({
      client: new URL("client/", outDir),
      server: new URL("function/", outDir),
      serverEntry: "index.js",
    }),
    assertRoutesSupported: () => {},
    adapter,
    completeBuild: async ({ config, onDemand, prerendered }) => {
      const hasFunction = onDemand.length > 0;
      if (hasFunction) {
        await prepareFunctionArtifact(
          new URL("function/", config.outDir),
          config.root,
        );
      }
      await writeDeploymentManifest(config.outDir, config, {
        target,
        hasFunction,
        onDemand,
        prerendered,
      });
    },
  };
}

function supportedExternal(specifier: string): boolean {
  return (
    specifier === "sharp" ||
    specifier.startsWith("node:") ||
    [
      "assert",
      "buffer",
      "child_process",
      "cluster",
      "console",
      "constants",
      "crypto",
      "dgram",
      "diagnostics_channel",
      "dns",
      "events",
      "fs",
      "http",
      "http2",
      "https",
      "module",
      "net",
      "os",
      "path",
      "perf_hooks",
      "process",
      "punycode",
      "querystring",
      "readline",
      "repl",
      "stream",
      "string_decoder",
      "sys",
      "timers",
      "tls",
      "trace_events",
      "tty",
      "url",
      "util",
      "v8",
      "vm",
      "wasi",
      "worker_threads",
      "zlib",
    ].includes(specifier)
  );
}

export function assertSupportedUserExternals(config: AstroConfig): void {
  const external = config.vite.ssr?.external;
  if (external === undefined) return;
  if (external === true || !Array.isArray(external)) {
    throw new Error("V1 does not support custom Vite SSR package externals.");
  }
  const unsupported = external.filter(
    (entry): entry is string =>
      typeof entry !== "string" || !supportedExternal(entry),
  );
  if (unsupported.length) {
    throw new Error(
      `V1 does not support these Vite SSR package externals: ${unsupported.map(String).join(", ")}.`,
    );
  }
}

export function serverViteConfig(
  astroMajor: number,
  vite: InlineConfig,
): InlineConfig {
  const currentBuild = vite.build ?? {};
  const output = { chunkFileNames: "chunks/[name]-[hash].js" };
  const bundlerOptions =
    astroMajor >= 7
      ? {
          rolldownOptions: {
            ...currentBuild.rolldownOptions,
            output: { ...currentBuild.rolldownOptions?.output, ...output },
          },
        }
      : {
          rollupOptions: {
            ...currentBuild.rollupOptions,
            output: Array.isArray(currentBuild.rollupOptions?.output)
              ? currentBuild.rollupOptions.output.map((item) => ({
                  ...item,
                  ...output,
                }))
              : { ...currentBuild.rollupOptions?.output, ...output },
          },
        };
  return {
    ssr: {
      ...vite.ssr,
      external: ["sharp"],
      noExternal: true,
    },
    build: {
      ...currentBuild,
      ...bundlerOptions,
    },
  };
}
