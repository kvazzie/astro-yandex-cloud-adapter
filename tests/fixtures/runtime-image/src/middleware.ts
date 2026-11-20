import { defineMiddleware } from "astro:middleware";
import { getImage } from "astro:assets";

export const onRequest = defineMiddleware(
	async (context, next) => {
		if (
			import.meta.env.PUBLIC_TEST_IMAGE_SOURCE ===
				"middleware" &&
			import.meta.env.PUBLIC_TEST_NO_RUNTIME_IMAGES !== "true"
		) {
			(context.locals as Record<string, unknown>).image =
				await getImage({
					src:
						context.url.searchParams.get("src") ??
						"http://127.0.0.1/image.png",
					width: 8,
					height: 8,
					format: "png",
				});
		}
		return next();
	},
);
