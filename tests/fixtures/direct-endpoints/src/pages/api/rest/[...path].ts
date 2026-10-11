import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ params, url }) =>
  Response.json({ path: params.path, pathname: url.pathname });
