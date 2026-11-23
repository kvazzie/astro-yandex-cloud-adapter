import { describe, expect, it } from "vitest";
import { Targets } from "@astro-yandex-cloud/targets";

import { generateApiGatewaySpecificationTemplate } from "../../packages/adapter/src/conditional/ApiGatewaySpecificationTemplate";
import { defineDeploymentManifest } from "../../packages/adapter/src/mandatory/DeploymentManifest";
import type { RoutePlan } from "../../packages/adapter/src/mandatory/ArtifactGeneration/RouteRequirements";

function templateFor(
	staticUrl: string,
	runtimePattern: string,
	staticPriority: number,
	runtimePriority: number,
) {
	const manifest = defineDeploymentManifest({
		schemaVersion: 1,
		adapter: { version: "0.1.0-beta.0" },
		target: Targets.ObjectStorageCloudFunctionsTarget,
		modifiers: { apiGateway: true },
		base: "/",
		artifacts: {
			client: { id: "client:primary", path: "client" },
			functions: [
				{
					id: "function:shared",
					path: "function",
					runtime: "nodejs22",
					entrypoint: "index.handler",
				},
			],
		},
		routes: {
			prerendered: [
				{
					kind: "page",
					url: staticUrl,
					objectKey: "page.html",
					artifactId: "client:primary",
				},
			],
			onDemand: [
				{
					kind: "page",
					pattern: runtimePattern,
					artifactId: "function:shared",
					priority: runtimePriority,
					patternRegex: "^.*$",
				},
			],
			notFound: [],
		},
	});
	const routePlan: RoutePlan = {
		base: "/",
		trailingSlash: "ignore",
		routes: [
			{
				kind: "prerendered",
				routeKind: "page",
				pattern: staticUrl,
				priority: staticPriority,
				patternRegex: "^.*$",
				paths: manifest.routes.prerendered.map(
					({ url, objectKey, artifactId }) => ({
						url,
						objectKey,
						artifactId: artifactId as Extract<
							RoutePlan["routes"][number],
							{ kind: "prerendered" }
						>["paths"][number]["artifactId"],
					}),
				),
			},
			{
				kind: "on-demand",
				routeKind: "page",
				pattern: runtimePattern,
				priority: runtimePriority,
				patternRegex: "^.*$",
				origin: "project",
				artifactId: manifest.artifacts.functions[0]!
					.id as Extract<
					RoutePlan["routes"][number],
					{ kind: "on-demand" }
				>["artifactId"],
			},
		],
	};
	return generateApiGatewaySpecificationTemplate(
		manifest,
		routePlan,
	);
}

describe("API Gateway template route precedence", () => {
	it("keeps a static parent separate from a required child parameter", () => {
		const template = templateFor("/posts/", "/posts/[id]", 1, 0);
		expect(
			template.paths["/posts/"]?.get?.[
				"x-yc-apigateway-integration"
			],
		).toMatchObject({ type: "object_storage" });
		expect(
			template.paths["/posts/{id}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});

	it("keeps the static homepage ahead of an empty catch-all alias", () => {
		const template = templateFor("/", "/[...slug]", 0, 1);
		expect(
			template.paths["/"]?.get?.["x-yc-apigateway-integration"],
		).toMatchObject({
			type: "object_storage",
			object: "page.html",
		});
		expect(
			template.paths["/{slug+}"]?.[
				"x-yc-apigateway-any-method"
			]?.["x-yc-apigateway-integration"],
		).toMatchObject({ type: "cloud_functions" });
	});
});
