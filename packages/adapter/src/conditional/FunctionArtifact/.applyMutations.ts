import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	mkdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { PreparationPlan } from "./.types.ts";
import { Errors } from ".";

/** Applies only the reviewed mutations, in order, stopping on the first failure. */
export function applyPreparation(plan: PreparationPlan) {
	return Effect.tryPromise({
		try: async (signal) => {
			for (const mutation of plan.mutations) {
				// Interruption stops before the next filesystem change.
				signal.throwIfAborted();
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
						await replaceFile(mutation.to, (temporary) =>
							copyFile(
								mutation.from,
								temporary,
								constants.COPYFILE_EXCL,
							),
						);
						break;
					case "writeBinaryFile":
					case "writeFile":
						await replaceFile(mutation.path, (temporary) =>
							writeFile(temporary, mutation.contents, {
								flag: "wx",
							}),
						);
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

/** Writes beside the destination and renames, so a linked destination is replaced, not followed. */
async function replaceFile(
	destination: URL,
	write: (temporary: URL) => Promise<void>,
): Promise<void> {
	const temporary = new URL(
		`.${randomUUID()}.yandex-tmp`,
		new URL("./", destination),
	);
	try {
		await write(temporary);
		await rename(temporary, destination);
	} catch (cause) {
		await rm(temporary, { force: true });
		throw cause;
	}
}
