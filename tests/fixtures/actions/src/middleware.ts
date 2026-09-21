import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.actionMiddleware = "active";
  const response = await next();
  response.headers.set("x-actions-middleware", "active");
  return response;
});
