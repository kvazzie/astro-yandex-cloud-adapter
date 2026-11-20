import * as Data from "effect/Data";

export class InvalidManifest extends Data.TaggedError(
	"InvalidManifest",
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
