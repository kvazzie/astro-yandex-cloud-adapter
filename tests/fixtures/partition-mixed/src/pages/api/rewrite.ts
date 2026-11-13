import type { APIRoute } from "astro";
export const prerender = false;
export const GET: APIRoute = ({ rewrite }) =>
	rewrite("/docs/archive/from-endpoint");
