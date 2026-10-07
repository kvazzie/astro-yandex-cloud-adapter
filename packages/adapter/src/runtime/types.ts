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
