export const prerender = false;

export async function POST({ request, url, locals }: import("astro").APIContext) {
  return Response.json({
    body: await request.text(),
    query: url.searchParams.getAll("value"),
    requestId: locals.runtime.context.requestId,
  });
}
