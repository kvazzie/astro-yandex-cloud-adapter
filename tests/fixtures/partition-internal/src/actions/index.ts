import { defineAction } from "astro:actions";

export const server = {
  greet: defineAction({ handler: async () => "Hello" }),
};
