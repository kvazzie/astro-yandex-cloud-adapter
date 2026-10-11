import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  const form = await request.formData();
  return Response.json({
    name: form.get("name"),
    method: request.method,
    pathname: url.pathname,
    origin: url.origin,
    source: url.searchParams.get("source"),
    applicationParameter: url.searchParams.get("__astro_path"),
    checkedOrigin: request.headers.get("origin"),
  });
};
