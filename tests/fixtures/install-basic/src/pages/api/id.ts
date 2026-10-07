import { nanoid } from "nanoid";

export const prerender = false;

export async function GET() {
  return Response.json({ id: nanoid(), alphabetLength: 64 });
}
