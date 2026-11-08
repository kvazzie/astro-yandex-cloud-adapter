import {
	Targets,
	TargetSchema,
} from "@astro-yandex-cloud/deployment-manifest/v1/target-encoding";
import * as S from "effect/Schema";

import {
	optionalLiteralWithDefault,
	optionalWithDefault,
} from "./.schemaHelpers.ts";

const objectStorageTargetOptionsDefaultValues = {
	apiGateway: false,
	recursive404: false,
};

export const ObjectStorageTargetOptions = S.extend(
	S.Struct({
		target: optionalWithDefault(
			S.compose(S.Literal("object-storage"), TargetSchema).pipe(
				S.filter(
					(target): target is Targets.ObjectStorageTarget =>
						target === Targets.ObjectStorageTarget,
				),
			),
			"object-storage",
		),
	}),
	S.Union(
		S.Struct({
			apiGateway: S.Literal(true),
			recursive404: optionalWithDefault(
				S.Boolean,
				objectStorageTargetOptionsDefaultValues.recursive404,
			),
		}),
		S.Struct({
			apiGateway: optionalLiteralWithDefault(false),
			recursive404: optionalLiteralWithDefault(false),
		}),
	),
).pipe(
	S.annotations({ parseOptions: { onExcessProperty: "error" } }),
);

S.decodeUnknownSync(ObjectStorageTargetOptions)(
	objectStorageTargetOptionsDefaultValues,
);
