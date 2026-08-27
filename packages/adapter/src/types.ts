export type Target = "object-storage" | "object-storage-functions";

export interface AdapterOptions {
  target?: Target;
}

export interface YandexCloudHttpEvent {
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
    identity?: { sourceIp?: string };
    http?: { method?: string; path?: string; sourceIp?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface YandexCloudInvocationContext {
  functionName?: string;
  functionVersion?: string;
  memoryLimitInMB?: string;
  requestId?: string;
  token?: string;
  getRemainingTimeInMillis?: () => number;
  [key: string]: unknown;
}

export interface YandexCloudRuntime {
  event: YandexCloudHttpEvent;
  context: YandexCloudInvocationContext;
}

export interface YandexCloudManifestV1 {
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
  artifacts: {
    client: string;
    function?: string;
  };
  function?: {
    runtime: "nodejs22";
    format: "esm";
    entrypoint: "index.handler";
    support: {
      sharp: "limited";
    };
  };
  routes: {
    prerendered: string[];
    onDemand: string[];
  };
}
