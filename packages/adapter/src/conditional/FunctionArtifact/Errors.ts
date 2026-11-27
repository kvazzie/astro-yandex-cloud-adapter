import * as Data from "effect/Data";

export class InvalidArtifact extends Data.TaggedError(
	"InvalidArtifact",
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class UnresolvedDependency extends Data.TaggedError(
	"UnresolvedDependency",
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
