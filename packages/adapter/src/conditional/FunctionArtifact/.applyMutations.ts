import {
	copyFile,
	mkdir,
	rm,
	writeFile,
} from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { PreparationPlan } from "./.types.ts";
import { Errors } from ".";

/** Applies only the reviewed mutations, in order, stopping on the first failure. */
export function applyPreparation(plan: PreparationPlan) {
	return Effect.tryPromise({
		try: async () => {
			for (const mutation of plan.mutations) {
				switch (mutation.kind) {
					case "mkdir":
						await mkdir(mutation.path, { recursive: true });
						break;
					case "removeDirectory":
						await rm(mutation.path, {
							recursive: true,
							force: true,
						});
						break;
					case "copyFile":
						await copyFile(mutation.from, mutation.to);
						break;
					case "writeFile":
						await writeFile(mutation.path, mutation.contents);
						break;
				}
			}
			return plan.plannedOutput;
		},
		catch: (cause) =>
			new Errors.InvalidArtifact({
				message:
					cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
	});
}
