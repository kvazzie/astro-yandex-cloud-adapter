export const injectedRoute = {
  name: "fixture-injected-route",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({
        pattern: "/injected/[name]",
        entrypoint: "./src/injected.ts",
        prerender: false,
      });
    },
  },
};
