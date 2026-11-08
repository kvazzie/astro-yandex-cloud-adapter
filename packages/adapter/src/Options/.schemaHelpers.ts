import * as S from "effect/Schema";
import type { LiteralValue } from "effect/SchemaAST";

export const optionalWithDefault = <A, I>(
	schema: S.Schema<A, I>,
	value: unknown,
) => {
	const defaultValue = S.decodeUnknownSync(schema)(value);
	return S.optionalWith(schema, { default: () => defaultValue });
};

export const optionalLiteralWithDefault = <
	const A extends LiteralValue,
>(
	value: A,
) => optionalWithDefault(S.Literal(value), value);
