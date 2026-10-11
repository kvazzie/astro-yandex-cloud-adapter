export const prerender = false;
export const ALL = ({ params }) => new Response(params.path ?? "archive root");
