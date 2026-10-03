import { isBuiltin } from "node:module";

import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import type { DependencyStrategy } from "../types.js";

export function assertUserExternals(
  config: AstroConfig,
  strategy: DependencyStrategy,
): void {
  if (strategy === "bundle") assertBundleUserExternals(config);
}

export function configureServerBuild(
  vite: InlineConfig,
  strategy: DependencyStrategy,
): InlineConfig {
  return strategy === "bundle"
    ? serverViteConfig(vite)
    : installServerViteConfig(vite);
}

export function sharpImageService(
  strategy: DependencyStrategy,
): AstroAdapter["supportedAstroFeatures"]["sharpImageService"] {
  return strategy === "bundle"
    ? {
        support: "unsupported",
        message:
          'Sharp is a native runtime dependency and cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install".',
      }
    : {
        support: "limited",
        message:
          "Sharp and runtime image transformation are experimental in Yandex Cloud Functions.",
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
  return {
    ssr: {
      ...vite.ssr,
      noExternal: true,
    },
    build: chunkedBuild(vite),
  };
}

/** Applies Function Artifact install requirements to Astro's server Vite configuration. */
function installServerViteConfig(vite: InlineConfig): InlineConfig {
  return {
    ssr: {
      ...vite.ssr,
      // Keep runtime package imports external while leaving application
      // bundling in Astro's Vite and Rolldown pipeline. A blanket
      // noExternal would bundle runtime dependencies; drop it but preserve
      // an explicit user noExternal bundle list.
      ...(vite.ssr?.noExternal === true ? { noExternal: undefined } : {}),
    },
    build: chunkedBuild(vite),
  };
}

function chunkedBuild(vite: InlineConfig): InlineConfig["build"] {
  const currentBuild = vite.build ?? {};
  const output = { chunkFileNames: "chunks/[name]-[hash].js" };
  const currentOutput = currentBuild.rolldownOptions?.output;
  return {
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
  };
}
