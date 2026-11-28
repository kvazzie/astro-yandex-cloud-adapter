import * as S from "effect/Schema";
import { TargetSchema } from "@astro-yandex-cloud/deployment-manifest/v1/target-encoding";
import * as Data from "effect/Data";

import type { Target } from "../Options";

interface UnsupportedTargetRouteErrorDetails {
	readonly target: Target;
	readonly routePatterns: readonly [string, ...string[]];
}

export class UnsupportedTargetRouteError extends Data.TaggedError(
	"UnsupportedTargetRouteError",
)<
	UnsupportedTargetRouteErrorDetails & {
		readonly message: string;
	}
> {
	constructor(details: UnsupportedTargetRouteErrorDetails) {
		const routePatterns = Object.freeze([
			...details.routePatterns,
		] as const);
		super({
			target: details.target,
			routePatterns,
			message: `The ${S.encodeSync(TargetSchema)(details.target)} target cannot serve on-demand routes: ${routePatterns.join(", ")}. Use target "object-storage-functions" or prerender these routes.`,
		});
	}
}
