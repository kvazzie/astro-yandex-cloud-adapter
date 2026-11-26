import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	mkdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
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
						await createDirectory(mutation.root, mutation.path);
						break;
					case "removeDirectory":
						await rm(mutation.path, {
							recursive: true,
							force: true,
						});
						break;
					case "copyFile":
						await replaceFile(
							mutation.root,
							mutation.to,
							(temporary) =>
								copyFile(
									mutation.from,
									temporary,
									constants.COPYFILE_EXCL,
								),
						);
						break;
					case "writeBinaryFile":
					case "writeFile":
						await replaceFile(
							mutation.root,
							mutation.path,
							(temporary) =>
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

/** Whether `child` is `parent` or lies below it. */
function within(child: string, parent: string): boolean {
	const path = relative(parent, child);
	return (
		path !== ".." &&
		!path.startsWith(`..${sep}`) &&
		!isAbsolute(path)
	);
}

/** Resolves `path` and rejects it unless its real location stays inside the real root. */
async function realWithin(
	root: URL,
	path: string,
): Promise<string> {
	const real = await realpath(path);
	if (!within(real, await realpath(root)))
		throw new Error(
			`The Function Artifact path ${path} resolves through a symbolic link to ${real}, outside the Function Artifact ${fileURLToPath(root)}. Remove the link from the server output.`,
		);
	return real;
}

/** Rejects a destination that is not lexically below the artifact root. */
function lexicalPath(root: URL, path: URL): string {
	const file = fileURLToPath(path);
	if (!within(file, fileURLToPath(root)))
		throw new Error(
			`The Function Artifact path ${file} is outside the Function Artifact ${fileURLToPath(root)}.`,
		);
	return file;
}

/** Creates one component at a time, so a linked parent cannot place directories elsewhere. */
async function createDirectory(root: URL, directory: URL) {
	let current = fileURLToPath(root);
	for (const component of relative(
		current,
		lexicalPath(root, directory),
	).split(sep)) {
		if (component === "") continue;
		current = join(current, component);
		try {
			await mkdir(current);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST")
				throw cause;
		}
		current = await realWithin(root, current);
	}
}

/**
 * Writes beside the destination in its real parent directory and renames, so a
 * linked destination is replaced, not followed, and a linked parent cannot
 * redirect the file outside the artifact.
 */
async function replaceFile(
	root: URL,
	destination: URL,
	write: (temporary: string) => Promise<void>,
): Promise<void> {
	const file = lexicalPath(root, destination);
	const parent = await realWithin(root, dirname(file));
	const temporary = join(parent, `.${randomUUID()}.yandex-tmp`);
	try {
		await write(temporary);
		await rename(temporary, join(parent, basename(file)));
	} catch (cause) {
		await rm(temporary, { force: true });
		throw cause;
	}
}
