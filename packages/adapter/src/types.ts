export type Target = "object-storage" | "object-storage-functions";
export type DependencyStrategy = "bundle" | "install";

export interface AdapterOptions {
  target?: Target;
  dependencyStrategy?: DependencyStrategy;
}

export interface YandexCloudHttpEvent {
  url?: string;
  httpMethod?: string;
  method?: string;
  path?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  multiValueHeaders?: Record<string, string[] | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  multiValueQueryStringParameters?: Record<string, string[] | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    identity?: { sourceIp?: string; userAgent?: string };
    http?: { method?: string; path?: string; sourceIp?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface YandexCloudInvocationContext {
  functionFolderId: string;
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: string;
  requestId: string;
  token?: {
    access_token: string;
    expires_in: number;
    token_type: string;
  };
  getPayload(): unknown;
  getRemainingTimeInMillis(): number;
}

export interface YandexCloudRuntime {
  event: YandexCloudHttpEvent;
  context: YandexCloudInvocationContext;
}

export interface ClientArtifactFile {
  path: string;
  url: string;
  objectKey: string;
}

export interface PrerenderedRouteRequirement {
  url: string;
  objectKey: string;
}

export interface OnDemandRouteRequirement {
  pattern: string;
}

export interface DeploymentManifestV1 {
  schemaVersion: 1;
  adapter: {
    name: "@astro-yandex-cloud/adapter";
    version: string;
  };
  astro: {
    version: string;
  };
  target: Target;
  buildOutput: "static" | "server";
  base: string;
  artifacts: {
    client: {
      path: string;
      files: ClientArtifactFile[];
    };
    function?: {
      path: string;
      runtime: "nodejs22";
      format: "esm";
      entrypoint: "index.handler";
      support: {
        sharp: "unsupported" | "limited";
      };
    };
  };
  routes: {
    prerendered: PrerenderedRouteRequirement[];
    onDemand: OnDemandRouteRequirement[];
  };
}

export type YandexCloudManifestV1 = DeploymentManifestV1;
