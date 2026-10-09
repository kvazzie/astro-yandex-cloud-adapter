import { createHash } from "node:crypto";

import type { DeploymentManifestV1 } from "../manifest/schema.js";
import type { RoutePlan } from "./routes.js";

interface GatewayVariable {
  default: string;
  description: string;
}

interface GatewayOperation {
  responses: Record<
    string,
    { description: string; "x-yc-status-mapping"?: number }
  >;
  parameters?: Array<{
    name: string;
    in: "path";
    required: true;
    schema: { type: "string" };
  }>;
  "x-yc-apigateway-integration": Record<string, unknown>;
}

interface GatewayRoute {
  path: string;
  source: string;
  artifactId: string;
  priority: number;
  operation: GatewayOperation;
  methods: readonly string[];
}

type Segment = { kind: "literal" | "parameter" | "rest"; value: string };

/** Converts supported Astro segments without broadening a compound parameter. */
function gatewayPattern(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => {
      const dynamic = /^\[(\.\.\.)?([A-Za-z_][A-Za-z_0-9]*)\]$/.exec(segment);
      if (dynamic) return `{${dynamic[2]}${dynamic[1] ? "+" : ""}}`;
      if (/[[\]{}]/.test(segment)) {
        throw new Error(
          `API Gateway cannot faithfully represent Astro route ${pattern}: compound or invalid parameter segments are unsupported. Use a whole-segment parameter, a static route, or your own compatible router.`,
        );
      }
      return segment;
    })
    .join("/");
}

/** Reads the finite segment grammar used by Yandex path matching. */
function segments(path: string): Segment[] {
  return path
    .split("/")
    .slice(1)
    .map((segment) => {
      const parameter = /^\{([^{}+]+)(\+)?\}$/.exec(segment);
      return parameter
        ? { kind: parameter[2] ? "rest" : "parameter", value: parameter[1]! }
        : { kind: "literal", value: segment };
    });
}

/** Finds an overlap witness using the product of two path-segment automata. */
function overlappingPath(first: string, second: string): string | undefined {
  const a = segments(first);
  const b = segments(second);
  const queue: Array<{ a: number; b: number; path: string[] }> = [
    { a: 0, b: 0, path: [] },
  ];
  const seen = new Set<string>();
  while (queue.length) {
    const state = queue.shift()!;
    const key = `${state.a}:${state.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (state.a === a.length && state.b === b.length)
      return `/${state.path.join("/")}`;
    const left = a[state.a];
    const right = b[state.b];
    if (left?.kind === "rest") queue.push({ ...state, a: state.a + 1 });
    if (right?.kind === "rest") queue.push({ ...state, b: state.b + 1 });
    if (!left || !right) continue;
    if (
      left.kind === "literal" &&
      right.kind === "literal" &&
      left.value !== right.value
    )
      continue;
    const value =
      left.kind === "literal"
        ? left.value
        : right.kind === "literal"
          ? right.value
          : "gateway-value";
    queue.push({
      a: state.a + (left.kind === "rest" ? 0 : 1),
      b: state.b + (right.kind === "rest" ? 0 : 1),
      path: [...state.path, value],
    });
  }
  return undefined;
}

/** Implements Yandex's fixed, parameter, then greedy routing precedence. */
function gatewayPriority(first: string, second: string): number {
  const a = segments(first);
  const b = segments(second);
  const category = (items: Segment[]) =>
    items.some(({ kind }) => kind === "rest")
      ? 2
      : items.some(({ kind }) => kind === "parameter")
        ? 1
        : 0;
  const aCategory = category(a);
  const bCategory = category(b);
  if (aCategory !== bCategory) return aCategory - bCategory;
  if (aCategory === 1) {
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const aFixed = a[index]!.kind === "literal";
      const bFixed = b[index]!.kind === "literal";
      if (aFixed !== bFixed) return aFixed ? -1 : 1;
    }
  }
  return second.length - first.length;
}

/** Requires every overlap between different Serving Artifacts to keep Astro's winner. */
function validatePriorities(routes: GatewayRoute[]): void {
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!;
      const b = routes[j]!;
      if (a.artifactId === b.artifactId) continue;
      if (!a.path.includes("{") && !b.path.includes("{") && a.path !== b.path)
        continue;
      const witness = overlappingPath(a.path, b.path);
      if (!witness) continue;
      const gateway = gatewayPriority(a.path, b.path);
      const astro = a.priority - b.priority;
      if (!gateway || !astro || Math.sign(gateway) !== Math.sign(astro)) {
        throw new Error(
          `API Gateway cannot preserve Astro route priority between ${a.source} and ${b.source} at ${witness}. Use one shared Function Artifact for overlapping on-demand routes, remove the overlap, or supply a compatible user-owned router.`,
        );
      }
    }
  }
}

/** Generates the empty-rest alias required by Astro's optional spread parameters. */
function emptyRestPattern(path: string): string | undefined {
  const parts = path.split("/");
  const rests = parts.filter((part) => /^\{[^{}]+\+\}$/.test(part));
  if (rests.length > 1) {
    throw new Error(
      `API Gateway cannot faithfully represent ${path}: more than one rest parameter is ambiguous. Use a single rest segment or your own compatible router.`,
    );
  }
  if (!rests.length) return undefined;
  return parts.filter((part) => part !== rests[0]).join("/") || "/";
}

/** Declares one stable pair of resource variables for each actual Function Artifact. */
function functionVariables(
  template: GatewayTemplate,
  artifactId: string,
): { function_id: string; service_account_id: string } {
  const key = `function_${createHash("sha256").update(artifactId).digest("hex").slice(0, 16)}`;
  template["x-yc-apigateway"].variables[key] = {
    default: "REPLACE_ME_INVALID_FUNCTION_ID",
    description: `Cloud Function ID for Manifest artifact ${artifactId}.`,
  };
  template["x-yc-apigateway"].variables[`${key}_service_account_id`] = {
    default: "REPLACE_ME_INVALID_FUNCTION_SERVICE_ACCOUNT_ID",
    description: `Service account authorized to invoke Manifest artifact ${artifactId}.`,
  };
  return {
    function_id: `\${var.${key}}`,
    service_account_id: `\${var.${key}_service_account_id}`,
  };
}

/** The customizable OpenAPI artifact, without allocated cloud resources. */
export interface GatewayTemplate {
  openapi: "3.0.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, GatewayOperation>>;
  "x-yc-apigateway": {
    ignoreTrailingSlashes: false;
    variables: Record<string, GatewayVariable>;
  };
}

/** Derives page and endpoint routing from the same completed build as the Manifest. */
export function generateGatewayTemplate(
  manifest: DeploymentManifestV1,
  routePlan: RoutePlan,
): GatewayTemplate {
  const template: GatewayTemplate = {
    openapi: "3.0.0",
    info: {
      title: "Astro application Gateway template",
      version: manifest.adapter.version,
      description:
        "Supply resource variables before deployment. Asset delivery remains application-owned. Strict trailing-slash settings expose only canonical static page URLs; customize Request Routing for redirects. Yandex API Gateway limits request and response bodies to 2.5 MB and specifications to 3.5 MB.",
    },
    paths: {},
    "x-yc-apigateway": { ignoreTrailingSlashes: false, variables: {} },
  };
  if (manifest.routes.prerendered.length) {
    template["x-yc-apigateway"].variables.bucket = {
      default: "REPLACE_ME_INVALID_BUCKET",
      description: "Object Storage bucket receiving the Client Artifact.",
    };
    template["x-yc-apigateway"].variables.storage_service_account_id = {
      default: "REPLACE_ME_INVALID_STORAGE_SERVICE_ACCOUNT_ID",
      description: "Service account authorized to read the Client Artifact.",
    };
  }
  const routes: GatewayRoute[] = [];
  const recursive404 = manifest.modifiers.recursive404 === true;
  const fallbackLength = Math.max(
    0,
    ...manifest.routes.notFound.map(
      ({ scope }) => `${scope === "/" ? "" : scope}/{_+}`.length,
    ),
  );
  const plannedPriority = (pattern: string, url?: string): number => {
    const planned = routePlan.routes.find(
      (candidate) =>
        candidate.pattern === pattern ||
        (candidate.kind === "prerendered" &&
          candidate.paths.some((path) => path.url === url)),
    );
    if (!planned)
      throw new Error(
        `API Gateway route ${url ?? pattern} has no completed-build route evidence.`,
      );
    return planned.priority;
  };
  for (const route of manifest.routes.prerendered) {
    const operation: GatewayOperation = {
      responses: {
        "200": {
          description: "Prerendered response.",
          ...(recursive404 &&
          manifest.routes.notFound.some(({ url }) => url === route.url)
            ? { "x-yc-status-mapping": 404 }
            : {}),
        },
      },
      "x-yc-apigateway-integration": {
        type: "object_storage",
        bucket: "${var.bucket}",
        object: route.objectKey,
        service_account_id: "${var.storage_service_account_id}",
      },
    };
    routes.push({
      path: route.url,
      source: route.url,
      artifactId: `${route.artifactId}:${route.objectKey}`,
      priority: plannedPriority("", route.url),
      operation,
      methods: ["get", "head"],
    });
    if (
      route.kind === "page" &&
      route.url !== "/" &&
      (routePlan.trailingSlash === "ignore" ||
        operation.responses["200"]?.["x-yc-status-mapping"] === 404)
    ) {
      const alias = route.url.endsWith("/")
        ? route.url.slice(0, -1)
        : `${route.url}/`;
      routes.push({
        path: alias,
        source: route.url,
        artifactId: `${route.artifactId}:${route.objectKey}`,
        priority: plannedPriority("", route.url),
        operation,
        methods: ["get", "head"],
      });
    }
  }
  for (const route of manifest.routes.onDemand) {
    let pattern = gatewayPattern(route.pattern);
    if (recursive404) {
      // Yandex compares greedy routes by textual length. Keep real endpoint/page
      // routes above every 404 fallback; the bridge dispatches by the original URL.
      pattern = pattern.replace(
        /\{([^{}]+)\+\}/g,
        (_match, name: string) => `{${name}${"_".repeat(fallbackLength + 1)}+}`,
      );
    }
    const empty = emptyRestPattern(pattern);
    const paths = new Set([pattern, ...(empty ? [empty] : [])]);
    for (const path of [...paths]) {
      if (path !== "/")
        paths.add(path.endsWith("/") ? path.slice(0, -1) : `${path}/`);
    }
    for (const path of paths) {
      const parameters = segments(path)
        .filter(({ kind }) => kind !== "literal")
        .map(({ value }) => ({
          name: value,
          in: "path" as const,
          required: true as const,
          schema: { type: "string" as const },
        }));
      routes.push({
        path,
        source: route.pattern,
        artifactId: route.artifactId,
        priority: plannedPriority(route.pattern),
        operation: {
          responses: {
            default: {
              description: "Astro handles method selection and the response.",
            },
          },
          ...(parameters.length ? { parameters } : {}),
          "x-yc-apigateway-integration": {
            type: "cloud_functions",
            ...functionVariables(template, route.artifactId),
            payload_format_version: "0.1",
          },
        },
        methods: ["x-yc-apigateway-any-method"],
      });
    }
  }
  validatePriorities(routes);
  for (const route of routes.sort((a, b) => b.priority - a.priority)) {
    template.paths[route.path] = Object.fromEntries(
      route.methods.map((method) => [method, route.operation]),
    );
  }
  if (recursive404) {
    for (const scope of manifest.routes.notFound) {
      const root = scope.scope === "/" ? "" : scope.scope;
      const path = `${root}/{_+}`;
      const operation: GatewayOperation = {
        parameters: [
          { name: "_", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Nearest custom 404 page.",
            "x-yc-status-mapping": 404,
          },
        },
        "x-yc-apigateway-integration": {
          type: "object_storage",
          bucket: "${var.bucket}",
          object: scope.objectKey,
          service_account_id: "${var.storage_service_account_id}",
        },
      };
      template.paths[path] = { "x-yc-apigateway-any-method": operation };
      for (const alias of new Set([scope.scope, `${root}/`])) {
        if (!routes.some((route) => overlappingPath(alias, route.path))) {
          const exactOperation = { ...operation };
          delete exactOperation.parameters;
          template.paths[alias] = { "x-yc-apigateway-any-method": exactOperation };
        }
      }
    }
  }
  const bytes = Buffer.byteLength(`${JSON.stringify(template, null, 2)}\n`);
  if (bytes > 3_500_000) {
    throw new Error(
      `The generated API Gateway specification is ${bytes} bytes, exceeding the 3.5 MB limit. Reduce the prerendered route count or use a compatible user-owned router.`,
    );
  }
  return template;
}
