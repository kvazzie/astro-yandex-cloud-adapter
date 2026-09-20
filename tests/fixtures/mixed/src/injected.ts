export function GET({ params }: import("astro").APIContext) {
  return Response.json({ source: "integration", name: params.name });
}
