import { readFile } from "node:fs/promises";
import type { FunctionArtifactPolicy } from "../FunctionArtifact/.types.ts";

/** Selects the nearest concrete ancestor shared by preview and Function fallback. */
export function nearestNotFoundScope<
	T extends { scope: string },
>(pathname: string, scopes: readonly T[]): T | undefined {
	return scopes
		.filter(
			({ scope }) =>
				scope === "/" ||
				pathname === scope ||
				pathname.startsWith(`${scope}/`),
		)
		.sort((a, b) => b.scope.length - a.scope.length)[0];
}

/** Supplies the nearest concrete custom page without replacing endpoint responses. */
export async function staticNotFoundResponse(
	request: Request,
	policy: FunctionArtifactPolicy,
): Promise<Response | undefined> {
	if (!policy.artifactDirectory || !policy.notFound?.length)
		return undefined;
	const pathname = new URL(request.url).pathname;
	const selected = nearestNotFoundScope(
		pathname,
		policy.notFound,
	);
	if (!selected) return undefined;
	const content =
		request.method === "HEAD"
			? null
			: await readFile(
					new URL(selected.file, policy.artifactDirectory),
				);
	return new Response(content, {
		status: 404,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}
