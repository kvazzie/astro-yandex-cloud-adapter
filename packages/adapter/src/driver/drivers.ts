import type { AstroAdapter, AstroConfig } from "astro";
import type { InlineConfig } from "vite";

import {
  finalizeFunctionArtifact,
  validateFunctionEntrypoint,
  writeDeploymentManifest,
} from "../artifacts.js";
import { ADAPTER_NAME } from "../constants.js";
import type { DependencyStrategyPolicy } from "./dependencies.js";

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

export class ObjectStorageDriver implements TargetDriver {
  constructor(private readonly dependencies: DependencyStrategyPolicy) {}

  assertUserExternals(config: AstroConfig): void {
    this.dependencies.assertUserExternals(config);
  }

  configureServerBuild(vite: InlineConfig): InlineConfig {
    return this.dependencies.configureServerBuild(vite);
  }

  configureBuild(outDir: URL): Record<string, unknown> {
    return configureBuild(outDir);
  }

  assertRoutesSupported(onDemand: string[]): void {
    assertObjectStorageRoutesSupported(onDemand);
  }

  adapter(hasOnDemandRoutes: boolean): AstroAdapter {
    return adapter(hasOnDemandRoutes, objectStorageFeatures);
  }

  async completeBuild({
    config,
    onDemand,
    prerendered,
  }: CompletedBuild): Promise<void> {
    // The route list alone cannot drive this check: Astro always
    // registers internal routes (/_server-islands, /_image, /404) as
    // non-prerendered, even for pure static output. Only emitted server
    // output proves an on-demand route slipped through, so the
    // entrypoint probe gates the rejection. The probed directory comes
    // from Astro's resolved config (set by configureBuild above), never
    // from a hardcoded folder name, so per-service layouts stay correct.
    const { ok: hasFunction } = await validateFunctionEntrypoint(
      config.build.server,
    );
    if (hasFunction) assertObjectStorageRoutesSupported(onDemand);
    await writeDeploymentManifest(config.outDir, config, {
      deploymentTarget: "object-storage",
      hasFunction: false,
      onDemand: [],
      prerendered,
    });
  }
}

export class ObjectStorageFunctionsDriver implements TargetDriver {
  constructor(private readonly dependencies: DependencyStrategyPolicy) {}

  assertUserExternals(config: AstroConfig): void {
    this.dependencies.assertUserExternals(config);
  }

  configureServerBuild(vite: InlineConfig): InlineConfig {
    return this.dependencies.configureServerBuild(vite);
  }

  configureBuild(outDir: URL): Record<string, unknown> {
    return configureBuild(outDir);
  }

  assertRoutesSupported(): void {}

  adapter(hasOnDemandRoutes: boolean): AstroAdapter {
    return adapter(
      hasOnDemandRoutes,
      functionsFeatures(this.dependencies.sharpImageService),
    );
  }

  async completeBuild({
    config,
    onDemand,
    prerendered,
  }: CompletedBuild): Promise<void> {
    const functionDirectory = config.build.server;
    const { ok: hasFunction } =
      await validateFunctionEntrypoint(functionDirectory);
    if (hasFunction) {
      await finalizeFunctionArtifact(
        functionDirectory,
        this.dependencies.strategy === "install" ? config.root : undefined,
      );
    }
    await writeDeploymentManifest(config.outDir, config, {
      deploymentTarget: "object-storage-functions",
      hasFunction,
      onDemand: hasFunction ? onDemand : [],
      prerendered,
      sharpSupport: this.dependencies.sharpSupport,
    });
  }
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
