import { isBuiltin } from "node:module";

import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import { defaults } from "../defaults.js";
import type { DependencyStrategy } from "../types.js";

export interface DependencyStrategyPolicy {
  strategy: DependencyStrategy;
  assertUserExternals: (config: AstroConfig) => void;
  configureServerBuild: (vite: InlineConfig) => InlineConfig;
  sharpImageService: AstroAdapter["supportedAstroFeatures"]["sharpImageService"];
  sharpSupport: "unsupported" | "limited";
}

export function createDependencyStrategyPolicy(
  selected: DependencyStrategy | undefined,
): DependencyStrategyPolicy {
  const strategy = selected ?? defaults.STRATEGY;
  if (strategy === "bundle") return bundle;
  if (strategy === "install") return install;
  throw new TypeError(
    `Unknown Yandex Cloud adapter dependency strategy: ${String(strategy)}.`,
  );
}

export const bundle: DependencyStrategyPolicy = {
  strategy: "bundle",
  assertUserExternals: assertBundleUserExternals,
  configureServerBuild: serverViteConfig,
  sharpImageService: {
    support: "unsupported",
    message:
      'Sharp is a native runtime dependency and cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install".',
  },
  sharpSupport: "unsupported",
};

export const install: DependencyStrategyPolicy = {
  strategy: "install",
  assertUserExternals: () => {},
  configureServerBuild: installServerViteConfig,
  sharpImageService: {
    support: "limited",
    message: "Sharp support is experimental in Yandex Cloud Functions.",
  },
  sharpSupport: "limited",
};

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
