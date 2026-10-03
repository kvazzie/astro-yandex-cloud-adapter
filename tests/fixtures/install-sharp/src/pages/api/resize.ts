import sharp from "sharp";

export const prerender = false;

export async function GET() {
  const image = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: "#ff0000",
    },
  })
    .png()
    .toBuffer();
  return Response.json({ bytes: image.length });
}
