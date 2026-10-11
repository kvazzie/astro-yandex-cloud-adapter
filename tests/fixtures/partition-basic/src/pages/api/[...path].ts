import type { APIContext } from "astro";

export const GET = ({ params, url }: APIContext) =>
  new Response(`rest-route-only-marker:${params.path}:${url.search}`);
