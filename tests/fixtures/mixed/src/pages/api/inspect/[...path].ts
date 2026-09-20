import type { APIRoute } from "astro";

export const prerender = false;

export const ALL: APIRoute = async ({ request, url }) =>
  Response.json({
    method: request.method,
    origin: url.origin,
    pathname: url.pathname,
    body: await request.text(),
    values: url.searchParams.getAll("value"),
    repeatedHeader: request.headers.get("x-repeated"),
  });
