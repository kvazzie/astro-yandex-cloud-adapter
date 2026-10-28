import { ADAPTER_NAME } from "./constants.ts";

export function injectedRuntimeTypes(): string {
  return `declare namespace App {
  interface Locals {
    runtime: import('${ADAPTER_NAME}').YandexCloudRuntime;
  }
}
`;
}
