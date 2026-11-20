import { readPackageInfo } from "@astro-yandex-cloud/package-info";

const { name } = readPackageInfo(import.meta.url);

export function injectedRuntimeTypes(): string {
	return `declare namespace App {
  interface Locals {
    runtime: import('${name}').YandexCloudRuntime;
  }
}
`;
}
