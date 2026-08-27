import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  response.headers.set(
    "x-fixture-middleware",
    context.locals.runtime ? "runtime" : "missing",
  );
  return response;
});
