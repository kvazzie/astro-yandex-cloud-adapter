import yandexCloud from "@astro-yandex-cloud/adapter";
import { defineConfig } from "astro/config";

export default defineConfig({
	integrations: [
		{
			name: "runtime-image-server-minification",
			hooks: {
				"astro:build:setup": ({ vite }) => {
					const server = vite.environments?.ssr;
					if (server) {
						server.build ??= {};
						const mode =
							process.env.ASTRO_TEST_SERVER_MINIFY ?? "false";
						const minify = mode !== "false";
						server.build.minify = minify;
						// Astro 7.1.6 replaces only quoted manifest markers. Keep syntax
						// while mangling identifiers so its manifest injection still runs.
						server.build.rolldownOptions ??= {};
						const output = server.build.rolldownOptions.output;
						if (!Array.isArray(output))
							server.build.rolldownOptions.output = {
								...output,
								minify:
									mode === "full"
										? true
										: minify
											? {
													compress: false,
													mangle: true,
													codegen: false,
												}
											: false,
							};
					}
				},
			},
		},
	],
	adapter: yandexCloud({
		target: "object-storage-functions",
		apiGateway: true,
		dependencyStrategy: "install",
	}),
	output: "server",
	base: "/docs",
	image: { domains: ["127.0.0.1"] },
});
