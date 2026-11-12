import * as S from "effect/Schema";
import { targetEncoding } from "./.targetEncoding.ts";

export const TargetSchema = S.transformLiterals(
	...targetEncoding,
);
export type EncodedTarget = typeof TargetSchema.Encoded;

export { Targets } from "@astro-yandex-cloud/targets";
