import { defineMiddleware } from "astro:middleware";
export const onRequest = defineMiddleware((context, next) => {
	if (context.url.pathname === "/docs/middleware-rewrite")
		return context.rewrite("/docs/posts/from-middleware");
	return next();
});
