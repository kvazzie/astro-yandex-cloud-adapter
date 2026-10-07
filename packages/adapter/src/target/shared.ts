import type { AstroAdapter } from "astro";

import { ADAPTER_NAME } from "../constants.js";

export function buildDirectories(outDir: URL) {
  return {
    client: new URL("client/", outDir),
    server: new URL("function/", outDir),
    serverEntry: "index.js",
  };
}

export function adapter(
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
