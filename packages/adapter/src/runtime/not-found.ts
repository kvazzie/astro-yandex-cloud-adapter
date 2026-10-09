import { readFile } from "node:fs/promises";
import type { FunctionArtifactPolicy } from "./types.js";
import { nearestNotFoundScope } from "./not-found-scope.js";

/** Supplies the nearest concrete custom page without replacing endpoint responses. */
export async function staticNotFoundResponse(
  request: Request,
  policy: FunctionArtifactPolicy,
): Promise<Response | undefined> {
  if (!policy.artifactDirectory || !policy.notFound?.length) return undefined;
  const pathname = new URL(request.url).pathname;
  const selected = nearestNotFoundScope(pathname, policy.notFound);
  if (!selected) return undefined;
  const content =
    request.method === "HEAD"
      ? null
      : await readFile(new URL(selected.file, policy.artifactDirectory));
  return new Response(content, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
