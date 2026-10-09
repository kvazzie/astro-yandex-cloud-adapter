import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseDeploymentManifest } from "../../packages/adapter/src/deployment-manifest.js";
import schema from "../../packages/adapter/.generated/deployment-manifest.schema.json" with { type: "json" };

const validateSchema = new Ajv2020().compile(schema);

/** Create fresh static deployment facts that individual rejection cases can mutate. */
function staticManifest() {
  return {
    schemaVersion: 1,
    adapter: { version: "0.1.0" },
    target: "object-storage" as string,
    modifiers: { apiGateway: false },
    base: "/docs",
    artifacts: {
      client: { id: "client:primary", path: "client" },
      functions: [] as Array<Record<string, unknown>>,
    },
    routes: {
      prerendered: [
        {
          kind: "page",
          url: "/docs/",
          objectKey: "docs/index.html",
          artifactId: "client:primary",
        },
      ],
      onDemand: [] as Array<Record<string, unknown>>,
      notFound: [] as Array<Record<string, unknown>>,
    },
  };
}

/** Add one endpoint and its Function Artifact without optional support claims. */
function functionManifest() {
  const value = staticManifest();
  value.target = "object-storage-functions";
  value.artifacts.functions.push({
    id: "function:shared",
    path: "function",
    runtime: "nodejs22",
    entrypoint: "index.handler",
  });
  value.routes.onDemand.push({
    kind: "endpoint",
    pattern: "/docs/api/ping",
    artifactId: "function:shared",
  });
  return { ...value, directInvocation: { requestTargetParameter: "__astro_path" } };
}

describe("Deployment Manifest consumers", () => {
  it("rejects recursive 404 without Gateway", () => {
    const value = staticManifest();
    Object.assign(value.modifiers, { recursive404: true });
    expect(() => parseDeploymentManifest(value)).toThrow(/recursive.*Gateway/i);
  });
  it("accepts v1 with additive fields at every depth", () => {
    const value = {
      ...staticManifest(),
      futureRequirement: true,
    };
    Object.assign(value.artifacts.client, { futurePlacement: 1 });
    Object.assign(value.routes.prerendered[0]!, { futureRouteFact: ["x"] });

    expect(parseDeploymentManifest(value)).toEqual(value);
    expect(validateSchema(value)).toBe(true);
  });

  it("accepts a Function Artifact without support claims referenced by an endpoint", () => {
    const value = functionManifest();

    expect(parseDeploymentManifest(value)).toEqual(value);
    expect(validateSchema(value)).toBe(true);
  });

  it("accepts additive Function Artifact fields without interpreting support claims", () => {
    const value = functionManifest();
    Object.assign(value.artifacts.functions[0]!, {
      futureRuntimeFact: true,
      support: { sharp: "legacy" },
    });

    expect(parseDeploymentManifest(value)).toEqual(value);
    expect(validateSchema(value)).toBe(true);
  });

  it.each(["runtime", "entrypoint"])(
    "requires a Function Artifact %s in parser and JSON Schema",
    (field) => {
      const value = functionManifest();
      delete value.artifacts.functions[0]![field];

      expect(() => parseDeploymentManifest(value)).toThrow(TypeError);
      expect(validateSchema(value)).toBe(false);
    },
  );

  it.each([
    ["runtime", "nodejs20"],
    ["entrypoint", "missing.handler"],
  ])("rejects an invalid Function Artifact %s", (field, invalid) => {
    const value = functionManifest();
    value.artifacts.functions[0]![field] = invalid;

    expect(() => parseDeploymentManifest(value)).toThrow(TypeError);
    expect(validateSchema(value)).toBe(false);
  });

  it("rejects an endpoint without a matching Function Artifact", () => {
    const value = functionManifest();
    value.routes.onDemand[0]!.artifactId = "function:missing";

    expect(() => parseDeploymentManifest(value)).toThrow(
      /no matching Function Artifact/,
    );
  });

  it.each([
    [
      "schema version",
      (value: ReturnType<typeof staticManifest>) =>
        Object.assign(value, { schemaVersion: 2 }),
    ],
    [
      "target",
      (value: ReturnType<typeof staticManifest>) => {
        value.target = "vm";
      },
    ],
    [
      "absolute path",
      (value: ReturnType<typeof staticManifest>) => {
        value.artifacts.client.path = "/client";
      },
    ],
    [
      "noncanonical route URL",
      (value: ReturnType<typeof staticManifest>) => {
        value.routes.prerendered[0]!.url = "/docs//index";
      },
    ],
    [
      "missing route kind",
      (value: ReturnType<typeof staticManifest>) => {
        delete (
          value.routes.prerendered[0] as Partial<
            (typeof value.routes.prerendered)[number]
          >
        ).kind;
      },
    ],
  ])("rejects invalid known %s in parser and JSON Schema", (_name, change) => {
    const value = staticManifest();
    change(value);
    expect(() => parseDeploymentManifest(value)).toThrow(TypeError);
    expect(validateSchema(value)).toBe(false);
  });

  it("rejects a route pointing to the wrong artifact kind", () => {
    const value = staticManifest();
    value.routes.prerendered[0]!.artifactId = "function:shared";

    expect(() => parseDeploymentManifest(value)).toThrow(/Prerendered Route/);
  });

  it("rejects duplicate artifact IDs", () => {
    const value = staticManifest();
    value.target = "object-storage-functions";
    value.artifacts.functions.push({
      id: "client:primary",
      path: "function",
      runtime: "nodejs22",
      entrypoint: "index.handler",
    });

    expect(() => parseDeploymentManifest(value)).toThrow(/duplicate artifact ID/);
  });

  it("rejects a Function Artifact on the Object Storage Target", () => {
    const value = staticManifest();
    value.artifacts.functions.push({
      id: "function:shared",
      path: "function",
      runtime: "nodejs22",
      entrypoint: "index.handler",
    });

    expect(() => parseDeploymentManifest(value)).toThrow(/Object Storage Target/);
  });

  it("rejects invalid base placement", () => {
    const value = staticManifest();
    value.routes.prerendered[0]!.url = "/other/";

    expect(() => parseDeploymentManifest(value)).toThrow(/Prerendered Route/);
  });

  it("rejects noncanonical URLs", () => {
    const value = staticManifest();
    value.routes.prerendered[0]!.url = "/docs/%2e%2e/";

    expect(() => parseDeploymentManifest(value)).toThrow(/Prerendered Route/);
  });

  it("rejects a 404 scope without a matching prerendered page", () => {
    const value = staticManifest();
    value.routes.notFound.push({
      scope: "/docs",
      url: "/docs/404/",
      objectKey: "docs/404.html",
      artifactId: "client:primary",
    });

    expect(() => parseDeploymentManifest(value)).toThrow(/404 scope/);
  });
});
