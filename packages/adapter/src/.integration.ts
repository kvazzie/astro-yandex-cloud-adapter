import type {
	AstroIntegration,
	BaseIntegrationHooks,
	HookParameters,
} from "astro";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { EffectifyIntegrationHookError } from "effectify/astro/integration";

/** Runs hooks with their original typed errors at the Promise boundary. */
export function defineIntegration<A, I>({
	name,
	schema,
	setup,
}: {
	name: string;
	schema: Schema.Schema<A, I>;
	setup: (params: { options: A }) => AstroIntegration["hooks"];
}): (options?: I) => AstroIntegration {
	return (options) => {
		const decoded = Schema.decodeUnknownEither(schema)(
			options ?? {},
		);
		if (decoded._tag === "Left") {
			throw new EffectifyIntegrationHookError({
				hook: "integration:options",
				message: `Invalid options provided for integration "${name}".`,
				cause: decoded.left,
			});
		}
		try {
			return { name, hooks: setup({ options: decoded.right }) };
		} catch (cause) {
			throw new EffectifyIntegrationHookError({
				hook: "integration:options",
				message: `Error setting up integration "${name}": ${cause instanceof Error ? cause.message : String(cause)}`,
				cause,
			});
		}
	};
}

export function runHook<K extends keyof BaseIntegrationHooks>(
	name: string,
	hook: K,
	effectHook: (
		params: HookParameters<K>,
	) => Effect.Effect<void, EffectifyIntegrationHookError>,
) {
	return async (params: HookParameters<K>): Promise<void> => {
		try {
			const exit = await Effect.runPromiseExit(
				effectHook(params),
			);
			if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
		} catch (cause) {
			if (cause instanceof EffectifyIntegrationHookError)
				throw cause;
			throw new EffectifyIntegrationHookError({
				hook,
				message: `Error in hook "${hook}" of integration "${name}".`,
				cause,
			});
		}
	};
}
