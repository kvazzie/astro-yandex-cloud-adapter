import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ params }) => {
  if (params.kind === "redirect") {
    return new Response(null, {
      status: 307,
      headers: { location: "/runtime" },
    });
  }
  if (params.kind === "empty") return new Response(null, { status: 204 });
  return new Response("missing", { status: 404 });
};
