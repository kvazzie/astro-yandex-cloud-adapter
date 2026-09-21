import { defineAction } from "astro:actions";
import { z } from "astro/zod";

export const server = {
  greet: defineAction({
    input: z.object({ name: z.string().min(1) }),
    handler: async ({ name }, context) => {
      context.cookies.set("action-first", "one", {
        httpOnly: true,
        path: "/",
      });
      context.cookies.set("action-second", "two", {
        path: "/",
        sameSite: "lax",
      });
      return {
        message: `Hello, ${name}`,
        session: context.cookies.get("session")?.value,
        middleware: context.locals.actionMiddleware,
      };
    },
  }),
};
