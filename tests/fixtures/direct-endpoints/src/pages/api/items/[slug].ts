import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ params, url }) =>
  Response.json({
    slug: params.slug,
    pathname: url.pathname,
    values: url.searchParams.getAll("value"),
    applicationParameter: url.searchParams.get("__astro_path"),
  });
