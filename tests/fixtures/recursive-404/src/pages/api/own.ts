export const prerender = false;
export function GET() { return new Response("Endpoint owns this 404", { status: 404, headers: { "Content-Type": "text/plain" } }); }
