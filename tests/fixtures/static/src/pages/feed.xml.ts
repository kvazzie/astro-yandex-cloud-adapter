export const prerender = true;

export function GET() {
  return new Response("<feed />", {
    headers: { "content-type": "application/xml" },
  });
}
