import { defineAction } from "astro:actions";
import { getImage } from "astro:assets";

export const server =
	import.meta.env.PUBLIC_TEST_IMAGE_SOURCE === "actions"
		? {
				image: defineAction({
					handler: async (_input, context) =>
						(
							await getImage({
								src:
									context.url.searchParams.get("src") ??
									"http://127.0.0.1/image.png",
								width: 8,
								height: 8,
								format: "png",
							})
						).src,
				}),
			}
		: {};
