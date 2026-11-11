import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import * as Schema from "effect/Schema";

import {
	Targets,
	ManifestV1Schema,
	encodeDeploymentManifest,
	parseDeploymentManifest,
} from "@astro-yandex-cloud/deployment-manifest";
import { TargetSchema } from "@astro-yandex-cloud/deployment-manifest/v1/target-encoding";
import { Targets as OptionsTargets } from "../../packages/adapter/src/Options";

const schema: Record<string, unknown> = JSON.parse(
	readFileSync(
		new URL(
			"../../packages/deployment-manifest/.generated/deployment-manifest.schema.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, unknown>;

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
	return {
		...value,
		directInvocation: { requestTargetParameter: "__astro_path" },
	};
}

/** All five path-bearing fields, with valid references and root placement. */
function pathManifest() {
	const value = staticManifest();
	value.base = "/";
	value.target = "object-storage-functions";
	value.modifiers.apiGateway = true;
	value.artifacts.functions.push({
		id: "function:shared",
		path: "function",
		runtime: "nodejs22",
		entrypoint: "index.handler",
	});
	value.routes.onDemand.push({
		kind: "page",
		pattern: "/live",
		artifactId: "function:shared",
	});
	value.routes.prerendered[0]!.url = "/404/";
	value.routes.prerendered[0]!.objectKey = "404.html";
	value.routes.notFound.push({
		scope: "/",
		url: "/404/",
		objectKey: "404.html",
		artifactId: "client:primary",
	});
	return { ...value, gatewayTemplate: { path: "gateway.yaml" } };
}

describe.each([
	[
		"artifacts.client.path",
		(value: ReturnType<typeof pathManifest>, path: string) => {
			value.artifacts.client.path = path;
		},
	],
	[
		"artifacts.functions[].path",
		(value: ReturnType<typeof pathManifest>, path: string) => {
			value.artifacts.functions[0]!.path = path;
		},
	],
	[
		"gatewayTemplate.path",
		(value: ReturnType<typeof pathManifest>, path: string) => {
			value.gatewayTemplate.path = path;
		},
	],
	[
		"routes.prerendered[].objectKey",
		(value: ReturnType<typeof pathManifest>, path: string) => {
			value.routes.prerendered[0]!.objectKey = path;
		},
	],
	[
		"routes.notFound[].objectKey",
		(value: ReturnType<typeof pathManifest>, path: string) => {
			value.routes.notFound[0]!.objectKey = path;
		},
	],
] as const)("portable manifest path %s", (_field, change) => {
	it.each([
		"",
		".",
		"..",
		"../secret",
		"client/../secret",
		"./client",
		"client/./file",
		"/secret",
		"//server/share",
		"\\secret",
		"\\\\server\\share",
		"..\\secret",
		"client\\..\\secret",
		"client/..\\secret",
		"client\\../secret",
		"client\\file",
		"C:\\secret",
		"C:/secret",
		"C:secret",
		"c:../secret",
		"\\\\?\\C:\\secret",
		"\\\\.\\C:\\secret",
		"docs/C:/secret",
		"file:stream",
		"client//file",
		"client/",
		"client\0file",
		"client\nfile",
		"client\n",
		"client\rfile",
	])("rejects %j in parser, encoder and JSON Schema", (path) => {
		const encoded = pathManifest();
		const decoded = parseDeploymentManifest(encoded);
		change(encoded, path);
		change(
			decoded as unknown as ReturnType<typeof pathManifest>,
			path,
		);
		expect(() => parseDeploymentManifest(encoded)).toThrow(
			TypeError,
		);
		expect(() =>
			Schema.decodeUnknownSync(ManifestV1Schema)(encoded),
		).toThrow();
		expect(() => encodeDeploymentManifest(decoded)).toThrow();
		expect(validateSchema(encoded)).toBe(false);
	});

	it.each([
		"client",
		"functions/shared",
		".well-known/site.json",
		"資料/site 1/index.html",
		"release..name/file.html",
		"folder%20name/file.html",
	])(
		"preserves %j and resolves beneath POSIX and Windows roots",
		(path) => {
			const value = pathManifest();
			change(value, path);
			// Keep the 404 reference valid when its key is the field under test.
			if (_field.endsWith("objectKey")) {
				value.routes.prerendered[0]!.objectKey = path;
				value.routes.notFound[0]!.objectKey = path;
			}
			expect(
				encodeDeploymentManifest(parseDeploymentManifest(value)),
			).toEqual(value);
			expect(validateSchema(value)).toBe(true);
			for (const [paths, root] of [
				[posix, "/artifacts"],
				[win32, "D:\\artifacts"],
			] as const) {
				const relative = paths.relative(
					root,
					paths.resolve(root, path),
				);
				expect(paths.isAbsolute(relative)).toBe(false);
				expect(relative.split(paths.sep)).not.toContain("..");
			}
		},
	);
});

describe("Deployment Manifest consumers", () => {
	it.each(["/%ZZ", "/%E0%A4%A"])(
		"rejects malformed URI escapes in base %s",
		(base) => {
			const value = staticManifest();
			value.base = base;
			value.routes.prerendered = [];
			expect(() => parseDeploymentManifest(value)).toThrow(
				/canonical URL path/,
			);
			const decoded = Schema.decodeUnknownSync(
				Schema.typeSchema(ManifestV1Schema),
			)({
				...value,
				target: Targets.ObjectStorageTarget,
			});
			expect(() => encodeDeploymentManifest(decoded)).toThrow(
				/canonical URL path/,
			);
		},
	);
	it("shares the catalogue with adapter Options while keeping numeric values internal", () => {
		expect(OptionsTargets).toBe(Targets);
		const encoded = staticManifest();
		const manifest = parseDeploymentManifest(encoded);
		expect(manifest.target).toBe(Targets.ObjectStorageTarget);
		expect(encodeDeploymentManifest(manifest)).toEqual(encoded);
		expect(validateSchema(manifest)).toBe(false);
	});

	it.each([
		["object-storage", Targets.ObjectStorageTarget],
		[
			"object-storage-functions",
			Targets.ObjectStorageCloudFunctionsTarget,
		],
	] as const)(
		"converts %s through the public target codec",
		(encoded, target) => {
			expect(
				Schema.decodeUnknownSync(TargetSchema)(encoded),
			).toBe(target);
			expect(Schema.encodeSync(TargetSchema)(target)).toBe(
				encoded,
			);
		},
	);

	it("rejects numeric and unknown encoded target selections", () => {
		expect(() =>
			Schema.decodeUnknownSync(TargetSchema)(
				Targets.ObjectStorageTarget,
			),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(TargetSchema)("vm"),
		).toThrow();
	});

	it("checks decoded manifest references before encoding", () => {
		const manifest = parseDeploymentManifest(functionManifest());
		const invalid = {
			...manifest,
			routes: {
				...manifest.routes,
				onDemand: manifest.routes.onDemand.map((route) => ({
					...route,
					artifactId: "function:missing",
				})),
			},
		};
		expect(() => encodeDeploymentManifest(invalid)).toThrow(
			/no matching Function Artifact/,
		);
	});

	it("rejects multiple Function Artifacts even without a partition modifier", () => {
		const value = functionManifest();
		value.artifacts.functions.push({
			id: "function:other",
			path: "functions/other",
			runtime: "nodejs22",
			entrypoint: "index.handler",
		});
		expect(() => parseDeploymentManifest(value)).toThrow();
		expect(validateSchema(value)).toBe(false);
	});

	it("rejects retired separate Function partitioning", () => {
		const value = functionManifest();
		Object.assign(value.modifiers, { functions: "separate" });
		expect(() => parseDeploymentManifest(value)).toThrow(
			/shared/,
		);
	});

	it.each([
		"/docs/_image",
		"/docs/_actions/[...path]",
		"/docs/_server-islands/[name]",
	])("rejects a direct internal route %s", (pattern) => {
		const value = functionManifest();
		value.routes.onDemand[0]!.pattern = pattern;
		expect(() => parseDeploymentManifest(value)).toThrow(
			/user-defined endpoints/i,
		);
	});

	it("rejects recursive 404 without Gateway", () => {
		const value = staticManifest();
		Object.assign(value.modifiers, { recursive404: true });
		expect(() => parseDeploymentManifest(value)).toThrow(
			/recursive.*Gateway/i,
		);
	});
	it("accepts v1 with additive fields at every depth", () => {
		const value = {
			...staticManifest(),
			futureRequirement: true,
		};
		Object.assign(value.artifacts.client, {
			futurePlacement: 1,
		});
		Object.assign(value.routes.prerendered[0]!, {
			futureRouteFact: ["x"],
		});

		expect(
			encodeDeploymentManifest(parseDeploymentManifest(value)),
		).toEqual(value);
		expect(validateSchema(value)).toBe(true);
	});

	it("accepts a Function Artifact without support claims referenced by an endpoint", () => {
		const value = functionManifest();

		expect(
			encodeDeploymentManifest(parseDeploymentManifest(value)),
		).toEqual(value);
		expect(validateSchema(value)).toBe(true);
	});

	it("accepts additive Function Artifact fields without interpreting support claims", () => {
		const value = functionManifest();
		Object.assign(value.artifacts.functions[0]!, {
			futureRuntimeFact: true,
			support: { sharp: "legacy" },
		});

		expect(
			encodeDeploymentManifest(parseDeploymentManifest(value)),
		).toEqual(value);
		expect(validateSchema(value)).toBe(true);
	});

	it.each(["runtime", "entrypoint"])(
		"requires a Function Artifact %s in parser and JSON Schema",
		(field) => {
			const value = functionManifest();
			delete value.artifacts.functions[0]![field];

			expect(() => parseDeploymentManifest(value)).toThrow(
				TypeError,
			);
			expect(validateSchema(value)).toBe(false);
		},
	);

	it.each([
		["runtime", "nodejs20"],
		["entrypoint", "missing.handler"],
	])(
		"rejects an invalid Function Artifact %s",
		(field, invalid) => {
			const value = functionManifest();
			value.artifacts.functions[0]![field] = invalid;

			expect(() => parseDeploymentManifest(value)).toThrow(
				TypeError,
			);
			expect(validateSchema(value)).toBe(false);
		},
	);

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
	])(
		"rejects invalid known %s in parser and JSON Schema",
		(_name, change) => {
			const value = staticManifest();
			change(value);
			expect(() => parseDeploymentManifest(value)).toThrow(
				TypeError,
			);
			expect(validateSchema(value)).toBe(false);
		},
	);

	it("rejects a route pointing to the wrong artifact kind", () => {
		const value = staticManifest();
		value.routes.prerendered[0]!.artifactId = "function:shared";

		expect(() => parseDeploymentManifest(value)).toThrow(
			/Prerendered Route/,
		);
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

		expect(() => parseDeploymentManifest(value)).toThrow(
			/duplicate artifact ID/,
		);
	});

	it("rejects a Function Artifact on the Object Storage Target", () => {
		const value = staticManifest();
		value.artifacts.functions.push({
			id: "function:shared",
			path: "function",
			runtime: "nodejs22",
			entrypoint: "index.handler",
		});

		expect(() => parseDeploymentManifest(value)).toThrow(
			/Object Storage Target/,
		);
	});

	it("rejects invalid base placement", () => {
		const value = staticManifest();
		value.routes.prerendered[0]!.url = "/other/";

		expect(() => parseDeploymentManifest(value)).toThrow(
			/Prerendered Route/,
		);
	});

	it("rejects noncanonical URLs", () => {
		const value = staticManifest();
		value.routes.prerendered[0]!.url = "/docs/%2e%2e/";

		expect(() => parseDeploymentManifest(value)).toThrow(
			/Prerendered Route/,
		);
	});

	it("rejects a 404 scope without a matching prerendered page", () => {
		const value = staticManifest();
		value.routes.notFound.push({
			scope: "/docs",
			url: "/docs/404/",
			objectKey: "docs/404.html",
			artifactId: "client:primary",
		});

		expect(() => parseDeploymentManifest(value)).toThrow(
			/404 scope/,
		);
	});
});
