import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import {
  hasFunctionArtifact,
  prepareFunctionArtifact,
  writeDeploymentManifest,
} from "./artifacts.js";
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

const objectStorageFeatures: AstroAdapter["supportedAstroFeatures"] = {
  staticOutput: "stable",
  hybridOutput: "unsupported",
  serverOutput: "unsupported",
  sharpImageService: "stable",
  envGetSecret: "stable",
  i18nDomains: "unsupported",
};

const functionsFeatures: AstroAdapter["supportedAstroFeatures"] = {
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

function adapter(
  hasOnDemandRoutes: boolean,
  supportedAstroFeatures: AstroAdapter["supportedAstroFeatures"],
): AstroAdapter {
  return {
    name: ADAPTER_NAME,
    entrypointResolution: "auto",
    serverEntrypoint: new URL("./server.js", import.meta.url),
    previewEntrypoint: new URL("./preview.js", import.meta.url),
    adapterFeatures: {
      buildOutput: hasOnDemandRoutes ? "server" : "static",
      middlewareMode: "classic",
      preserveBuildClientDir: true,
      preserveBuildServerDir: true,
    },
    supportedAstroFeatures,
  };
}

function assertObjectStorageRoutesSupported(onDemand: string[]): void {
  if (!onDemand.length) return;
  throw new Error(
    `The object-storage target cannot serve on-demand routes: ${onDemand.join(", ")}. ` +
      'Use target "object-storage-functions" or prerender these routes.',
  );
}

function configureBuild(outDir: URL): Record<string, unknown> {
  return {
    client: new URL("client/", outDir),
    server: new URL("function/", outDir),
    serverEntry: "index.js",
  };
}

export function createDriver(options: AdapterOptions | undefined): TargetDriver {
  const target = options?.target ?? "object-storage";
  if (target !== "object-storage" && target !== "object-storage-functions") {
    throw new TypeError(`Unknown Yandex Cloud adapter target: ${String(target)}.`);
  }

  if (target === "object-storage") {
    return {
      configureBuild,
      assertRoutesSupported: assertObjectStorageRoutesSupported,
      adapter: (hasOnDemandRoutes) =>
        adapter(hasOnDemandRoutes, objectStorageFeatures),
      completeBuild: async ({ config, onDemand, prerendered }) => {
        const hasFunction = await hasFunctionArtifact(
          new URL("function/", config.outDir),
        );
        if (hasFunction) assertObjectStorageRoutesSupported(onDemand);
        await writeDeploymentManifest(config.outDir, config, {
          target,
          hasFunction: false,
          onDemand: [],
          prerendered,
        });
      },
    };
  }
  return {
    configureBuild,
    assertRoutesSupported: () => {},
    adapter: (hasOnDemandRoutes) => adapter(hasOnDemandRoutes, functionsFeatures),
    completeBuild: async ({ config, onDemand, prerendered }) => {
      const functionDirectory = new URL("function/", config.outDir);
      const hasFunction = await hasFunctionArtifact(functionDirectory);
      if (hasFunction) {
        await prepareFunctionArtifact(functionDirectory, config.root);
      }
      await writeDeploymentManifest(config.outDir, config, {
        target,
        hasFunction,
        onDemand: hasFunction ? onDemand : [],
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

/** Applies Function Artifact bundling requirements to Astro's server Vite configuration. */
export function serverViteConfig(vite: InlineConfig): InlineConfig {
  const currentBuild = vite.build ?? {};
  const output = { chunkFileNames: "chunks/[name]-[hash].js" };
  const currentOutput = currentBuild.rolldownOptions?.output;
  return {
    ssr: {
      ...vite.ssr,
      external: ["sharp"],
      noExternal: true,
    },
    build: {
      ...currentBuild,
      rolldownOptions: {
        ...currentBuild.rolldownOptions,
        output: Array.isArray(currentOutput)
          ? currentOutput.map(
              /** Adds the required chunk name without collapsing multiple outputs. */
              (item) => ({ ...item, ...output }),
            )
          : { ...currentOutput, ...output },
      },
    },
  };
}
