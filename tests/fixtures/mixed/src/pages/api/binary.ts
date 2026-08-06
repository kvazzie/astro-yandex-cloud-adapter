export const prerender = false;

export function GET() {
  return new Response(Uint8Array.from([0, 1, 2, 255]), {
    headers: { 'content-type': 'application/octet-stream' },
  });
}
