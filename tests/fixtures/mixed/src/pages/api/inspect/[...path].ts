import type { APIRoute } from "astro";

export const prerender = false;

export const ALL: APIRoute = async ({ request, url }) => {
  const response = Response.json({
    method: request.method,
    origin: url.origin,
    pathname: url.pathname,
    bodyBase64: Buffer.from(await request.arrayBuffer()).toString("base64"),
    values: url.searchParams.getAll("value"),
    repeatedHeader: request.headers.get("x-repeated"),
  });
  response.headers.set("x-inspected-method", request.method);
  return response;
};
