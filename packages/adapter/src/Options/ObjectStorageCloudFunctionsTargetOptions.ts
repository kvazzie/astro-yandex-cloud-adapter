import {
	Targets,
	TargetSchema,
} from "@astro-yandex-cloud/deployment-manifest/v1/target-encoding";
import * as S from "effect/Schema";

import {
	optionalLiteralWithDefault,
	optionalWithDefault,
} from "./.schemaHelpers.ts";

const directOriginSchema = S.URL.pipe(
	S.filter(
		(origin) =>
			((origin.protocol === "https:" ||
				origin.protocol === "http:") &&
				!origin.username &&
				!origin.password &&
				origin.pathname === "/" &&
				!origin.search &&
				!origin.hash) ||
			"directOrigin must be an explicit HTTP or HTTPS origin without a path, credentials, query, or fragment.",
	),
	S.brand("HttpOrigin"),
);

const objectStorageCloudFunctionsTargetOptionsDefaultValues = {
	target: "object-storage-functions",
	dependencyStrategy: "bundle",
	functions: "shared",
	apiGateway: false,
	recursive404: false,
};

export const ObjectStorageCloudFunctionsTargetOptions = S.extend(
	S.Struct({
		target: S.compose(
			S.Literal("object-storage-functions"),
			TargetSchema,
		).pipe(
			S.filter(
				(
					target,
				): target is Targets.ObjectStorageCloudFunctionsTarget =>
					target === Targets.ObjectStorageCloudFunctionsTarget,
			),
		),
		dependencyStrategy: optionalWithDefault(
			S.Literal("bundle", "install"),
			objectStorageCloudFunctionsTargetOptionsDefaultValues.dependencyStrategy,
		),
		functions: optionalWithDefault(
			S.Literal("shared"),
			objectStorageCloudFunctionsTargetOptionsDefaultValues.functions,
		),
	}),
	S.Union(
		S.Struct({
			apiGateway: S.Literal(true),
			recursive404: optionalWithDefault(
				S.Boolean,
				objectStorageCloudFunctionsTargetOptionsDefaultValues.recursive404,
			),
		}),
		S.Struct({
			apiGateway: optionalLiteralWithDefault(false),
			recursive404: optionalLiteralWithDefault(false),
			directOrigin: S.optional(directOriginSchema),
		}),
	),
).pipe(
	S.annotations({ parseOptions: { onExcessProperty: "error" } }),
);

S.decodeUnknownSync(ObjectStorageCloudFunctionsTargetOptions)(
	objectStorageCloudFunctionsTargetOptionsDefaultValues,
);
