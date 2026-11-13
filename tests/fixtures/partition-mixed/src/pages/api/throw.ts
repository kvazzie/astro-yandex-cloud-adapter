import type { APIRoute } from "astro";
export const prerender = false;
export const GET: APIRoute = () => {
	throw new Error("endpoint-error-marker");
};
