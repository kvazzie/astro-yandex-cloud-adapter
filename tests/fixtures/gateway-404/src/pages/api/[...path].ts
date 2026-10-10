export const prerender = false;
export const ALL = () =>
  new Response("Endpoint's own missing response", { status: 404 });
