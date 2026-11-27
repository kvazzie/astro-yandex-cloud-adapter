import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { IntegrationResolvedRoute } from "astro";
import type * as Brand from "effect/Brand";

import type {
	DeploymentManifestV1,
	OnDemandRouteRequirement,
	PrerenderedRouteRequirement,
} from "../../DeploymentManifest/Schema.ts";

export * as Errors from "./Errors.ts";

type ArtifactId<K extends "client" | "function"> = string &
	Brand.Brand<K>;
const clientId = "client:primary" as ArtifactId<"client">;
const functionId = "function:shared" as ArtifactId<"function">;

export type PlannedRoute =
	| {
			kind: "prerendered";
			routeKind: "page" | "endpoint";
			pattern: string;
			priority: number;
			patternRegex: string;
			paths: Array<{
				url: string;
				objectKey: string;
				artifactId: ArtifactId<"client">;
			}>;
	  }
	| {
			kind: "on-demand";
			routeKind: "page" | "endpoint";
			pattern: string;
			artifactId: ArtifactId<"function">;
			priority: number;
			patternRegex: string;
			origin: string;
	  };

export interface RoutePlan {
	routes: PlannedRoute[];
	base: string;
	trailingSlash: "always" | "never" | "ignore";
}

/** An emitted HTML file with the public URLs a browser can request it by. */
export interface ClientDocument {
	/** Relative references in the HTML resolve against each of these URLs. */
	urls: readonly string[];
	html: string;
}

interface RouteEvidence {
	base: string;
	/** Astro's `site`; absolute URLs on its origin are requests to the application. */
	site?: string | undefined;
	clientDirectory: URL;
	clientFiles: readonly string[];
	/** The contents of each emitted HTML Client Artifact file, by file. */
	clientHtml: ReadonlyMap<string, string>;
	pages: readonly { pathname: string }[];
	resolvedRoutes: readonly IntegrationResolvedRoute[];
	emittedAssets: ReadonlyMap<string, readonly URL[]>;
	hasFunction: boolean;
	trailingSlash: "always" | "never" | "ignore";
	hasServerIslands: boolean;
	hasRuntimeImages: boolean;
	imageEndpoint: string;
}

/** Preliminary route compatibility before Astro emits build artifacts. */
export function registeredOnDemandRoutes(
	routes: readonly IntegrationResolvedRoute[],
): IntegrationResolvedRoute[] {
	return routes.filter(
		(route) =>
			(route.type === "page" || route.type === "endpoint") &&
			!route.isPrerendered &&
			route.origin !== "internal",
	);
}

function withBase(base: string, urlPath: string): string {
	const suffix = `/${urlPath.replace(/^\/+/, "")}`;
	if (base === "/") return suffix;
	return suffix === "/" ? `${base}/` : `${base}${suffix}`;
}

function objectKey(base: string, path: string): string {
	return base === "/" ? path : `${base.slice(1)}/${path}`;
}

/** Prefers page-owned output; other files remain candidates only for diagnostics. */
function pageFile(
	url: string,
	files: ReadonlySet<string>,
	pageEmitters: ReadonlyMap<
		string,
		ReadonlySet<IntegrationResolvedRoute>
	>,
): string | undefined {
	const pathname = url.replace(/^\/+|\/+$/g, "");
	const candidates =
		url === "/"
			? ["index.html"]
			: url.endsWith("/")
				? [`${pathname}/index.html`, `${pathname}.html`]
				: [`${pathname}.html`, `${pathname}/index.html`];
	const existing = candidates.filter((candidate) =>
		files.has(candidate),
	);
	return (
		existing.find((candidate) => pageEmitters.has(candidate)) ??
		existing[0]
	);
}

/** Indexes the prerendered page routes that emitted each Client Artifact file. */
function pageEmitterIndex(
	evidence: Pick<
		RouteEvidence,
		"clientDirectory" | "resolvedRoutes" | "emittedAssets"
	>,
): Map<string, Set<IntegrationResolvedRoute>> {
	const clientPath = fileURLToPath(evidence.clientDirectory);
	const pageEmitters = new Map<
		string,
		Set<IntegrationResolvedRoute>
	>();
	for (const route of evidence.resolvedRoutes) {
		if (route.type !== "page" || !route.isPrerendered) continue;
		for (const asset of evidence.emittedAssets.get(
			route.pattern,
		) ?? []) {
			const file = relative(clientPath, fileURLToPath(asset))
				.split(sep)
				.join("/");
			const emitters = pageEmitters.get(file) ?? new Set();
			emitters.add(route);
			pageEmitters.set(file, emitters);
		}
	}
	return pageEmitters;
}

/** Astro's `pages` pathname as the public URL path of the prerendered page. */
function pageUrl(pathname: string): string {
	return pathname ? `/${pathname.replace(/^\/+/, "")}` : "/";
}

function publicPageUrl(
	evidence: Pick<RouteEvidence, "base" | "trailingSlash">,
	url: string,
): string {
	return url === "/" &&
		evidence.base !== "/" &&
		evidence.trailingSlash === "never"
		? evidence.base
		: withBase(evidence.base, url);
}

/**
 * Pairs each emitted HTML file with the URLs it is served at: a page's public
 * URL, plus the other slash spelling where the Gateway also serves it, or the
 * object URL of any other HTML file.
 */
export function clientDocuments(
	evidence: RouteEvidence,
): ClientDocument[] {
	const files = new Set(evidence.clientFiles);
	const pageEmitters = pageEmitterIndex(evidence);
	const urls = new Map<string, string[]>();
	for (const { pathname } of evidence.pages) {
		const url = pageUrl(pathname);
		// An unmatched page fails route reconciliation with its own diagnostic.
		const file = pageFile(url, files, pageEmitters);
		if (!file) continue;
		const publicUrl = publicPageUrl(evidence, url);
		const fileUrls = urls.get(file) ?? [];
		fileUrls.push(publicUrl);
		if (
			publicUrl !== "/" &&
			(evidence.trailingSlash === "ignore" ||
				/\/404\/?$/.test(publicUrl))
		)
			fileUrls.push(
				publicUrl.endsWith("/")
					? publicUrl.slice(0, -1)
					: `${publicUrl}/`,
			);
		urls.set(file, fileUrls);
	}
	return [...evidence.clientHtml].map(([file, html]) => ({
		urls: urls.get(file) ?? [
			withBase(
				evidence.base,
				file.split("/").map(encodeURIComponent).join("/"),
			),
		],
		html,
	}));
}

// Without `site`, a reserved origin stands in for the application's origin.
const unknownOrigin = "https://application.invalid";

/**
 * Matches a request to the application's endpoint in a URL attribute or CSS
 * url(), not in escaped text or a URL on another origin such as a CDN.
 * References resolve against the document URL as a browser resolves them.
 */
function requestsEndpoint(
	documents: readonly ClientDocument[],
	endpoint: string,
	site: string | undefined,
): boolean {
	const origin = site ? new URL(site).origin : unknownOrigin;
	for (const { urls, html } of documents)
		for (const match of html.matchAll(
			/\b(?:src|srcset|href|poster|content|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|url\(\s*["']?([^"')\s]*)/gi,
		)) {
			const value =
				match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
			// A srcset lists candidates separated by commas and descriptors.
			for (const candidate of value.split(/[\s,]+/)) {
				const query = candidate.indexOf("?");
				if (query === -1) continue;
				const location = candidate.slice(0, query);
				// A `?` after `#` belongs to the fragment, so the request has no query.
				if (location.includes("#")) continue;
				for (const url of urls) {
					const document = `${origin}${url}`;
					const resolved = URL.canParse(location, document)
						? new URL(location, document)
						: undefined;
					if (
						resolved?.origin === origin &&
						resolved.pathname === endpoint
					)
						return true;
				}
			}
		}
	return false;
}

/** Matches Astro's generated island preload link or fetch call, not page text. */
function requestsServerIsland(html: string): boolean {
	return /(?:<link\b[^>]*?\bhref="|\bfetch\(\s*")[^"]*?\/_server-islands\//i.test(
		html,
	);
}

type RequirementEvidence = Pick<
	RouteEvidence,
	| "base"
	| "site"
	| "resolvedRoutes"
	| "hasServerIslands"
	| "hasRuntimeImages"
	| "imageEndpoint"
> & { clientDocuments: readonly ClientDocument[] };

function isActiveInternalRoute(
	route: IntegrationResolvedRoute,
	evidence: RequirementEvidence,
): boolean {
	const { clientDocuments, imageEndpoint } = evidence;
	if (route.origin !== "internal") return true;
	if (route.pattern.startsWith("/_actions/")) return true;
	if (route.pattern.startsWith("/_server-islands/"))
		return (
			evidence.hasServerIslands ||
			clientDocuments.some(({ html }) =>
				requestsServerIsland(html),
			)
		);
	if (route.pattern === imageEndpoint)
		return (
			evidence.hasRuntimeImages ||
			requestsEndpoint(
				clientDocuments,
				// Astro builds image URLs as `joinPaths(BASE_URL, endpoint.route)`.
				withBase(evidence.base, imageEndpoint),
				evidence.site,
			)
		);
	return false;
}

/** Runtime requirements are independent of whether Astro emitted a valid handler. */
export function requiredOnDemandRoutes(
	evidence: RequirementEvidence,
): IntegrationResolvedRoute[] {
	return evidence.resolvedRoutes.filter(
		(route) =>
			(route.type === "page" || route.type === "endpoint") &&
			!route.isPrerendered &&
			isActiveInternalRoute(route, evidence),
	);
}

/** Reconciles Astro patterns with actual emitted Client Artifact files. */
export function reconcileRoutes(
	evidence: RouteEvidence,
): RoutePlan {
	const {
		base,
		clientDirectory,
		pages,
		resolvedRoutes,
		emittedAssets,
		hasFunction,
	} = evidence;
	const files = new Set(evidence.clientFiles);
	const prerenderedRoutes = new Map<
		string,
		Extract<PlannedRoute, { kind: "prerendered" }>
	>();
	const seenUrls = new Set<string>();
	const addPrerendered = (
		route: IntegrationResolvedRoute,
		url: string,
		file: string,
	) => {
		if (!files.has(file))
			throw new Error(
				`Prerendered Route ${url} has no emitted Client Artifact file ${file}.`,
			);
		const publicUrl = publicPageUrl(evidence, url);
		if (seenUrls.has(publicUrl))
			throw new Error(
				`Ambiguous Prerendered Route ${publicUrl}.`,
			);
		seenUrls.add(publicUrl);
		let planned = prerenderedRoutes.get(route.pattern);
		if (!planned) {
			planned = {
				kind: "prerendered",
				routeKind: route.type as "page" | "endpoint",
				pattern: withBase(base, route.pattern),
				priority: resolvedRoutes.indexOf(route),
				patternRegex: route.patternRegex.source,
				paths: [],
			};
			prerenderedRoutes.set(route.pattern, planned);
		}
		planned.paths.push({
			url: publicUrl,
			objectKey: objectKey(base, file),
			artifactId: clientId,
		});
	};

	const clientPath = fileURLToPath(clientDirectory);
	const assetFile = (asset: URL): string =>
		relative(clientPath, fileURLToPath(asset))
			.split(sep)
			.join("/");
	const pageEmitters = pageEmitterIndex(evidence);

	for (const { pathname } of pages) {
		const url = pageUrl(pathname);
		const file = pageFile(url, files, pageEmitters);
		if (!file)
			throw new Error(
				`Could not match the Prerendered Route ${url} to a Client Artifact file.`,
			);
		const emitters = [...(pageEmitters.get(file) ?? [])];
		const route =
			emitters.length === 1 ? emitters[0] : undefined;
		if (!route)
			throw new Error(
				emitters.length === 0
					? `Missing Astro page emitter evidence for ${url} (Client Artifact file ${file}) in completed-build assets.`
					: `Conflicting Astro page emitter evidence for ${url} (Client Artifact file ${file}) in completed-build assets: ${emitters.map((emitter) => emitter.pattern).join(", ")}.`,
			);
		addPrerendered(route, url, file);
	}

	for (const route of resolvedRoutes) {
		if (route.type !== "endpoint" || !route.isPrerendered)
			continue;
		for (const asset of emittedAssets.get(route.pattern) ?? []) {
			const file = assetFile(asset);
			if (!files.has(file)) continue;
			const url = `/${file.split("/").map(encodeURIComponent).join("/")}`;
			addPrerendered(
				route,
				routeTrailingSlash(
					"endpoint",
					route.pattern,
					evidence.trailingSlash,
				) === "always"
					? `${url}/`
					: url,
				file,
			);
		}
	}

	const onDemand: PlannedRoute[] = hasFunction
		? requiredOnDemandRoutes({
				...evidence,
				clientDocuments: clientDocuments(evidence),
			}).map((route) => ({
				kind: "on-demand" as const,
				routeKind: route.type as "page" | "endpoint",
				pattern: withBase(base, route.pattern),
				artifactId: functionId,
				priority: resolvedRoutes.indexOf(route),
				patternRegex: route.patternRegex.source,
				origin: route.origin,
			}))
		: [];
	for (const route of prerenderedRoutes.values())
		route.paths.sort((a, b) => a.url.localeCompare(b.url));
	return {
		base,
		trailingSlash: evidence.trailingSlash,
		routes: [...prerenderedRoutes.values(), ...onDemand].sort(
			(a, b) => a.pattern.localeCompare(b.pattern),
		),
	};
}

/** Projects the route plan into the portable Manifest contract. */
export function manifestRoutes(
	plan: RoutePlan,
	recursive404 = false,
): {
	prerendered: PrerenderedRouteRequirement[];
	onDemand: OnDemandRouteRequirement[];
	notFound: DeploymentManifestV1["routes"]["notFound"];
} {
	const prerendered: PrerenderedRouteRequirement[] = [];
	const onDemand: OnDemandRouteRequirement[] = [];
	const notFound: Array<
		DeploymentManifestV1["routes"]["notFound"][number]
	> = [];
	for (const route of plan.routes) {
		if (route.kind === "prerendered") {
			prerendered.push(
				...route.paths.map((path) => ({
					kind: route.routeKind,
					...path,
				})),
			);
			if (
				route.routeKind === "page" &&
				/\/404\/?$/.test(route.pattern)
			) {
				notFound.push(
					...route.paths
						.map((path) => ({
							scope: path.url.replace(/\/404\/?$/, "") || "/",
							...path,
						}))
						.filter(
							({ scope }) => recursive404 || scope === plan.base,
						),
				);
			}
		} else {
			onDemand.push({
				kind: route.routeKind,
				pattern: route.pattern,
				artifactId: route.artifactId,
			});
		}
	}
	prerendered.sort((a, b) => a.url.localeCompare(b.url));
	onDemand.sort((a, b) => a.pattern.localeCompare(b.pattern));
	notFound.sort((a, b) => a.scope.localeCompare(b.scope));
	return { prerendered, onDemand, notFound };
}

/** Astro 7's endpoint extension rule: a final segment ending in `.` and word characters. */
export function hasFileExtension(pathname: string): boolean {
	return /\/[^/]+\.\w+$/.test(pathname);
}

/**
 * Astro 7 decides an endpoint's slash policy from its route definition, so a
 * dotted value substituted for `[slug]` keeps the configured policy.
 */
export function routeTrailingSlash(
	routeKind: "page" | "endpoint",
	pattern: string,
	trailingSlash: RoutePlan["trailingSlash"],
): RoutePlan["trailingSlash"] {
	return routeKind === "endpoint" && hasFileExtension(pattern)
		? "never"
		: trailingSlash;
}
