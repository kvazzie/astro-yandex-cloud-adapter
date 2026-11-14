import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { readPackageInfo } from "@astro-yandex-cloud/package-info";
import type {
	AstroConfig,
	IntegrationResolvedRoute,
} from "astro";
import * as Effect from "effect/Effect";
import { glob } from "tinyglobby";

import * as FunctionArtifact from "../../conditional/FunctionArtifact";
import { DIRECT_REQUEST_TARGET_PARAMETER } from "../../.constants.ts";
import {
	defineDeploymentManifest,
	encodeDeploymentManifest,
} from "../DeploymentManifest";
import type { Target } from "../../Options";
import type { YandexCloudManifestV1 } from "../DeploymentManifest/Schema.ts";
import { validateFunctionEntrypoint } from "../../conditional/FunctionArtifact/Prepare.ts";
import {
	isSyntaxNode,
	parseModule,
	visitSyntax,
} from "../../.emittedModules.ts";
import { generateApiGatewaySpecificationTemplate } from "../../conditional/ApiGatewaySpecificationTemplate";
import {
	manifestRoutes,
	reconcileRoutes,
	registeredOnDemandRoutes,
	requiredOnDemandRoutes,
	type RoutePlan,
} from "./RouteRequirements";
import { hasRuntimeImageCalls } from "./RuntimeImageRoutes.ts";
import * as Errors from "./Errors.ts";

export * as Errors from "./Errors.ts";

const { version } = readPackageInfo(import.meta.url);

export interface CompletedBuild {
	config: AstroConfig;
	resolvedRoutes: readonly IntegrationResolvedRoute[];
	routeComponents: ReadonlyMap<string, string>;
	pages: readonly { pathname: string }[];
	emittedAssets: ReadonlyMap<string, readonly URL[]>;
}

/** Completes the selected Target from emitted Astro output. */
export interface BuildCompletionPolicy<E> {
	target: Target;
	dependencyStrategy?: "bundle" | "install";
	apiGateway: boolean;
	recursive404: boolean;
	functionPartition?: "shared";
	prepareArtifacts(
		build: CompletedBuild,
		routePlan: RoutePlan,
		hasFunction: boolean,
	): Effect.Effect<FunctionArtifact.PreparationOutput, E>;
}

export function completeBuild<E>(
	build: CompletedBuild,
	policy: BuildCompletionPolicy<E>,
) {
	return Effect.gen(function* () {
		const { config } = build;
		const entrypoint = yield* Effect.tryPromise({
			try: () => validateFunctionEntrypoint(config.build.server),
			catch: (cause) =>
				new FunctionArtifact.Errors.InvalidArtifact({
					message:
						cause instanceof Error
							? cause.message
							: String(cause),
					cause,
				}),
		});
		const hasFunction = entrypoint.ok;
		const routePlan = yield* Effect.tryPromise({
			try: () => inspectRoutes(build, entrypoint),
			catch: (cause) =>
				new FunctionArtifact.Errors.InvalidArtifact({
					message:
						cause instanceof Error
							? cause.message
							: String(cause),
					cause,
				}),
		});
		const prepared = yield* policy.prepareArtifacts(
			build,
			routePlan,
			hasFunction,
		);
		return yield* Effect.tryPromise({
			try: () =>
				writeDeploymentManifest(config.outDir, config, {
					deploymentTarget: policy.target,
					...(policy.dependencyStrategy
						? { dependencyStrategy: policy.dependencyStrategy }
						: {}),
					routePlan: prepared.routePlan,
					functions: prepared.functions,
					apiGateway: policy.apiGateway,
					recursive404: policy.recursive404,
					...(policy.functionPartition
						? { functionPartition: policy.functionPartition }
						: {}),
				}),
			catch: (cause) =>
				new Errors.InvalidManifest({
					message:
						cause instanceof Error
							? cause.message
							: String(cause),
					cause,
				}),
		});
	});
}

export function relativeArtifactPath(
	outDir: URL,
	artifact: URL,
): string {
	return relative(fileURLToPath(outDir), fileURLToPath(artifact))
		.split(sep)
		.join("/");
}

interface WriteDeploymentManifestInput {
	deploymentTarget: Target;
	dependencyStrategy?: "bundle" | "install";
	routePlan: RoutePlan;
	functions: FunctionArtifact.PreparationOutput["functions"];
	apiGateway: boolean;
	recursive404: boolean;
	functionPartition?: "shared";
}

async function inspectRoutes(
	build: CompletedBuild,
	entrypoint: Awaited<
		ReturnType<typeof validateFunctionEntrypoint>
	>,
): Promise<RoutePlan> {
	const { config } = build;
	const requireEntrypoint = () => {
		if (!entrypoint.ok)
			throw new Error(entrypoint.reason, {
				cause: entrypoint.cause,
			});
	};
	if (registeredOnDemandRoutes(build.resolvedRoutes).length)
		requireEntrypoint();
	const client = config.build.client;
	const clientFiles = await glob(["**/*"], {
		cwd: fileURLToPath(client),
		dot: true,
		onlyFiles: true,
	});
	const clientHtml = (
		await Promise.all(
			clientFiles
				.filter((file) => file.endsWith(".html"))
				.map((file) => readFile(new URL(file, client), "utf8")),
		)
	).join("\n");
	const evidence = {
		base: normalizedBase(config.base),
		clientDirectory: client,
		clientFiles,
		clientHtml,
		pages: build.pages,
		resolvedRoutes: build.resolvedRoutes,
		emittedAssets: build.emittedAssets,
		hasFunction: entrypoint.ok,
		trailingSlash: config.trailingSlash,
		hasServerIslands: await hasServerIslandEntries(
			config.build.server,
		),
		hasRuntimeImages: await hasRuntimeImageCalls(
			config.build.server,
			build.resolvedRoutes,
			build.routeComponents,
		),
		imageEndpoint: config.image.endpoint.route,
	};
	if (requiredOnDemandRoutes(evidence).length)
		requireEntrypoint();
	return reconcileRoutes(evidence);
}

/** Reads emitted island loader entries without executing application code at build time. */
async function hasServerIslandEntries(
	directory: URL,
): Promise<boolean> {
	const files = await glob(
		["index.js", "**/*server-island-manifest*.js"],
		{
			cwd: fileURLToPath(directory),
			onlyFiles: true,
		},
	);
	for (const file of files) {
		let found = false;
		visitSyntax(
			parseModule(
				await readFile(new URL(file, directory), "utf8"),
			),
			(node) => {
				if (
					node.type !== "VariableDeclarator" ||
					!isSyntaxNode(node.id) ||
					typeof node.id.name !== "string" ||
					!/^serverIslandMap(?:\$\d+)?$/.test(node.id.name)
				)
					return;
				const init = node.init;
				if (
					!isSyntaxNode(init) ||
					init.type !== "NewExpression" ||
					!Array.isArray(init.arguments)
				)
					return;
				const entries: unknown = init.arguments[0];
				if (
					isSyntaxNode(entries) &&
					entries.type === "ArrayExpression" &&
					Array.isArray(entries.elements) &&
					entries.elements.length
				)
					found = true;
			},
		);
		if (found) return true;
	}
	return false;
}

export async function writeDeploymentManifest(
	outDir: URL,
	config: AstroConfig,
	input: WriteDeploymentManifestInput,
): Promise<YandexCloudManifestV1> {
	const client = config.build.client;
	const base = normalizedBase(config.base);
	const routes = manifestRoutes(
		input.routePlan,
		input.recursive404,
	);
	const pageFunctionIds = [
		...new Set(
			input.routePlan.routes
				.filter(
					(route) =>
						route.kind === "on-demand" &&
						route.routeKind === "page",
				)
				.map((route) =>
					route.kind === "on-demand" ? route.artifactId : "",
				),
		),
	];
	const manifest = defineDeploymentManifest({
		schemaVersion: 1,
		adapter: { version },
		target: input.deploymentTarget,
		modifiers: {
			apiGateway: input.apiGateway,
			recursive404: input.recursive404,
			...(input.functionPartition
				? { functions: input.functionPartition }
				: {}),
			...(input.dependencyStrategy
				? { dependencyStrategy: input.dependencyStrategy }
				: {}),
		},
		base,
		...(config.build.assetsPrefix !== undefined
			? { assetsPrefix: config.build.assetsPrefix }
			: {}),
		artifacts: {
			client: {
				id: "client:primary",
				path: relativeArtifactPath(outDir, client),
			},
			functions: input.functions.map(
				({ id, path, runtime, entrypoint }) => ({
					id,
					path,
					runtime,
					entrypoint,
				}),
			),
		},
		routes: {
			...routes,
			notFound: routes.notFound.map((scope) => ({
				...scope,
				...(pageFunctionIds.length
					? { functionArtifactIds: pageFunctionIds }
					: {}),
			})),
		},
		...(input.functions.length && !input.apiGateway
			? {
					directInvocation: {
						requestTargetParameter:
							DIRECT_REQUEST_TARGET_PARAMETER,
					},
				}
			: {}),
		...(input.apiGateway
			? { gatewayTemplate: { path: "yandex-api-gateway.json" } }
			: {}),
	});
	const encodedManifest = encodeDeploymentManifest(manifest);
	await mkdir(fileURLToPath(outDir), { recursive: true });
	if (input.apiGateway) {
		await writeFile(
			new URL("yandex-api-gateway.json", outDir),
			`${JSON.stringify(generateApiGatewaySpecificationTemplate(manifest, input.routePlan), null, 2)}\n`,
		);
	}
	await writeFile(
		new URL("yandex-cloud.json", outDir),
		`${JSON.stringify(encodedManifest, null, 2)}\n`,
	);
	return manifest;
}

function normalizedBase(base: string): string {
	const path = `/${base.replace(/^\/+|\/+$/g, "")}`;
	return path === "/" ? path : path.replace(/\/+$/, "");
}
