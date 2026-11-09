export type {
	YandexCloudHttpEvent,
	YandexCloudHttpResult,
	YandexCloudInvocationContext,
	YandexCloudRuntime,
} from "@astro-yandex-cloud/function-runtime-bridge";

/** Adapter-selected invocation configuration retained by the runtime export. */
export interface FunctionInvocationOptions {
	apiGateway: boolean;
	directOrigin?: string;
}

export type { FunctionArtifactPolicy } from "./conditional/FunctionArtifact/.types.ts";
