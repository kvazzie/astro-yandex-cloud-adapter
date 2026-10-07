export const prerender = true;

export function getStaticPaths() {
  return [{ params: { slug: "a" } }, { params: { slug: "b" } }];
}

export function GET({ params }: { params: { slug?: string } }) {
  return Response.json({ slug: params.slug });
}
