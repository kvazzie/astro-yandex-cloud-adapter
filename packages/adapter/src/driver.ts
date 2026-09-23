import { isBuiltin } from "node:module";

import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import {
  finalizeFunctionArtifact,
  validateFunctionEntrypoint,
  writeDeploymentManifest,
} from "./artifacts.js";
import { ADAPTER_NAME } from "./constants.js";
import { defaults } from "./defaults.js";
import type { AdapterOptions, DependencyStrategy } from "./types.js";

interface CompletedBuild {
  config: AstroConfig;
  onDemand: string[];
  prerendered: string[];
}

export interface TargetDriver {
  assertUserExternals: (config: AstroConfig) => void;
  configureServerBuild: (vite: InlineConfig) => InlineConfig;
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

function functionsFeatures(
  sharpImageService: AstroAdapter["supportedAstroFeatures"]["sharpImageService"],
): AstroAdapter["supportedAstroFeatures"] {
  return {
    staticOutput: "stable",
    hybridOutput: "stable",
    serverOutput: "stable",
    sharpImageService,
    envGetSecret: "stable",
    i18nDomains: "unsupported",
  };
}

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
  const dependencies = createDependencyStrategyPolicy(options?.dependencyStrategy);
  const dependencyConfiguration = {
    assertUserExternals: dependencies.assertUserExternals,
    configureServerBuild: dependencies.configureServerBuild,
  };

  if (target === "object-storage") {
    return {
      ...dependencyConfiguration,
      configureBuild,
      assertRoutesSupported: assertObjectStorageRoutesSupported,
      adapter: (hasOnDemandRoutes) =>
        adapter(hasOnDemandRoutes, objectStorageFeatures),
      completeBuild: async ({ config, onDemand, prerendered }) => {
        const { ok: hasFunction } = await validateFunctionEntrypoint(
          new URL("function/", config.outDir),
        );
        if (hasFunction) assertObjectStorageRoutesSupported(onDemand);
        await writeDeploymentManifest(config.outDir, config, {
          deploymentTarget: target,
          hasFunction: false,
          onDemand: [],
          prerendered,
        });
      },
    };
  }
  return {
    ...dependencyConfiguration,
    configureBuild,
    assertRoutesSupported: () => {},
    adapter: (hasOnDemandRoutes) =>
      adapter(
        hasOnDemandRoutes,
        functionsFeatures(dependencies.sharpImageService),
      ),
    completeBuild: async ({ config, onDemand, prerendered }) => {
      const functionDirectory = new URL("function/", config.outDir);
      const { ok: hasFunction } =
        await validateFunctionEntrypoint(functionDirectory);
      if (hasFunction) {
        await finalizeFunctionArtifact(
          functionDirectory,
          dependencies.strategy === "install" ? config.root : undefined,
        );
      }
      await writeDeploymentManifest(config.outDir, config, {
        deploymentTarget: target,
        hasFunction,
        onDemand: hasFunction ? onDemand : [],
        prerendered,
        sharpSupport: dependencies.sharpSupport,
      });
    },
  };
}

function assertBundleUserExternals(config: AstroConfig): void {
  const external = config.vite.ssr?.external;
  if (external === undefined) return;
  if (external === true || !Array.isArray(external)) {
    throw new Error(
      'The "bundle" dependency strategy does not support custom Vite SSR package externals. Remove vite.ssr.external or select dependencyStrategy: "install".',
    );
  }
  const unsupported = external.filter(
    (entry): entry is string => typeof entry !== "string" || !isBuiltin(entry),
  );
  if (unsupported.length) {
    throw new Error(
      `The "bundle" dependency strategy cannot externalize runtime packages: ${unsupported.map(String).join(", ")}. ` +
        'Remove them from vite.ssr.external or select dependencyStrategy: "install".',
    );
  }
}

/** Applies Function Artifact bundling requirements to Astro's server Vite configuration. */
function serverViteConfig(vite: InlineConfig): InlineConfig {
  const currentBuild = vite.build ?? {};
  const output = { chunkFileNames: "chunks/[name]-[hash].js" };
  const currentOutput = currentBuild.rolldownOptions?.output;
  return {
    ssr: {
      ...vite.ssr,
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

/** Applies Function Artifact install requirements to Astro's server Vite configuration. */
function installServerViteConfig(vite: InlineConfig): InlineConfig {
  const currentBuild = vite.build ?? {};
  const output = { chunkFileNames: "chunks/[name]-[hash].js" };
  const currentOutput = currentBuild.rolldownOptions?.output;
  return {
    ssr: {
      ...vite.ssr,
      // Keep runtime package imports external while leaving application
      // bundling in Astro's Vite and Rolldown pipeline. A blanket
      // noExternal would bundle runtime dependencies; drop it but preserve
      // an explicit user noExternal bundle list.
      ...(vite.ssr?.noExternal === true ? { noExternal: undefined } : {}),
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

interface DependencyStrategyPolicy {
  strategy: DependencyStrategy;
  assertUserExternals: (config: AstroConfig) => void;
  configureServerBuild: (vite: InlineConfig) => InlineConfig;
  sharpImageService: AstroAdapter["supportedAstroFeatures"]["sharpImageService"];
  sharpSupport: "unsupported" | "limited";
}

function createDependencyStrategyPolicy(
  selected: DependencyStrategy | undefined,
): DependencyStrategyPolicy {
  const strategy = selected ?? defaults.STRATEGY;
  if (strategy === "bundle") {
    return {
      strategy,
      assertUserExternals: assertBundleUserExternals,
      configureServerBuild: serverViteConfig,
      sharpImageService: {
        support: "unsupported",
        message:
          'Sharp is a native runtime dependency and cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install".',
      },
      sharpSupport: "unsupported",
    };
  }
  if (strategy === "install") {
    return {
      strategy,
      assertUserExternals: () => {},
      configureServerBuild: installServerViteConfig,
      sharpImageService: {
        support: "limited",
        message: "Sharp support is experimental in Yandex Cloud Functions.",
      },
      sharpSupport: "limited",
    };
  }
  throw new TypeError(
    `Unknown Yandex Cloud adapter dependency strategy: ${String(strategy)}.`,
  );
}
