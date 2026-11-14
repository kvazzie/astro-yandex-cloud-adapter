import * as Data from "effect/Data";

export class InvalidConfiguration extends Data.TaggedError(
	"InvalidConfiguration",
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
