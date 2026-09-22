import { createHash } from "node:crypto";

import { urlAlphabet } from "nanoid";

export const prerender = false;

export async function POST({ request, url, locals }: import("astro").APIContext) {
  return Response.json({
    body: await request.text(),
    query: url.searchParams.getAll("value"),
    requestId: locals.runtime.context.requestId,
    dependencyValue: urlAlphabet.length,
    builtinValue: createHash("sha256").update("bundle").digest("hex"),
  });
}
