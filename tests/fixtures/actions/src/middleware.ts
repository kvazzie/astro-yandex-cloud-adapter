import { getActionContext } from "astro:actions";
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.actionMiddleware = "active";
  const { action, serializeActionResult, setActionResult } =
    getActionContext(context);
  let response: Response;
  if (action?.calledFrom === "form") {
    const result = await action.handler();
    if (result.error) {
      setActionResult(action.name, serializeActionResult(result));
      response = await next();
    } else {
      const query = new URLSearchParams(result.data);
      response = context.redirect(`/complete?${query}`, 303);
    }
  } else {
    response = await next();
  }
  response.headers.set("x-actions-middleware", "active");
  return response;
});
