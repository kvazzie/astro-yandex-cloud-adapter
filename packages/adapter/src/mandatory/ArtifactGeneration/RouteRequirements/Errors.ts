import * as Data from "effect/Data";

export class UnsupportedRoute extends Data.TaggedError(
	"UnsupportedRoute",
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
