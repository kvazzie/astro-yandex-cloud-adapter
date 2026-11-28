import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	html,
	parse,
	type DefaultTreeAdapterTypes,
} from "parse5";

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
	/** For a recursive 404 page, the scope below which it answers every missing URL. */
	fallbackScope?: string;
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
	/** Whether the Manifest maps 404 pages below the base scope too. */
	recursive404?: boolean | undefined;
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
	const pageEmitters = new Map<
		string,
		Set<IntegrationResolvedRoute>
	>();
	for (const route of evidence.resolvedRoutes) {
		if (route.type !== "page" || !route.isPrerendered) continue;
		for (const asset of evidence.emittedAssets.get(
			route.pattern,
		) ?? []) {
			const file = clientFile(evidence.clientDirectory, asset);
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

// Without `site`, a reserved origin stands in for the application's origin.
const unknownOrigin = "https://application.invalid";

/**
 * Spells a decoded page path as its canonical URL path, as the Manifest
 * requires. Astro already escapes `#` and `?` in page parameters, so an
 * existing `%XX` escape stays as it is and only a bare `%` is encoded.
 */
function canonicalUrlPath(path: string): string {
	return new URL(
		path
			.replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
			.replaceAll("\\", "%5C")
			.replaceAll("?", "%3F")
			.replaceAll("#", "%23"),
		unknownOrigin,
	).pathname;
}

function publicPageUrl(
	evidence: Pick<RouteEvidence, "base" | "trailingSlash">,
	url: string,
): string {
	return url === "/" &&
		evidence.base !== "/" &&
		evidence.trailingSlash === "never"
		? evidence.base
		: canonicalUrlPath(withBase(evidence.base, url));
}

/** A Client Artifact file's path relative to the client directory, with forward slashes. */
function clientFile(clientDirectory: URL, asset: URL): string {
	return relative(
		fileURLToPath(clientDirectory),
		fileURLToPath(asset),
	)
		.split(sep)
		.join("/");
}

/**
 * The URL a prerendered endpoint serves an emitted file at, before `base`.
 * Astro 7.1.6 applies the slash policy of the route definition: a probe build
 * with `base: "/docs"` and `trailingSlash: "always"` renders `/[page]` with
 * `page: "guide.html"` at `/docs/guide.html/`, while `/feed.xml` stays slashless.
 */
function endpointUrl(
	route: IntegrationResolvedRoute,
	file: string,
	trailingSlash: RoutePlan["trailingSlash"],
): string {
	// Astro already escaped the emitted name, so `publicPageUrl` canonicalizes it as is.
	const url = `/${file}`;
	return routeTrailingSlash(
		"endpoint",
		route.pattern,
		trailingSlash,
	) === "always"
		? `${url}/`
		: url;
}

/** The scope of a 404 page at `url`: the path above its final `404` segment. */
function notFoundScope(url: string): string {
	return url.replace(/\/404\/?$/, "") || "/";
}

/** Whether the Manifest maps a page of this route at `url` as a 404 page. */
function isNotFoundPage(
	evidence: Pick<RouteEvidence, "base" | "recursive404">,
	pattern: string,
	url: string,
): boolean {
	return (
		/\/404\/?$/.test(pattern) &&
		(evidence.recursive404 === true ||
			notFoundScope(url) === evidence.base)
	);
}

/**
 * Pairs each emitted HTML file with the URLs it is served at, as the Gateway
 * template serves them: a prerendered page's or endpoint's public URL, plus the
 * other slash spelling where its route accepts both or it is a Manifest 404
 * page, or the object URL of any other HTML file.
 */
export function clientDocuments(
	evidence: RouteEvidence,
): ClientDocument[] {
	const files = new Set(evidence.clientFiles);
	const pageEmitters = pageEmitterIndex(evidence);
	const urls = new Map<string, string[]>();
	const fallbackScopes = new Map<string, string>();
	const add = (
		file: string,
		publicUrl: string,
		alias: boolean,
	) => {
		const fileUrls = urls.get(file) ?? [];
		fileUrls.push(publicUrl);
		if (alias && publicUrl !== "/")
			fileUrls.push(
				publicUrl.endsWith("/")
					? publicUrl.slice(0, -1)
					: `${publicUrl}/`,
			);
		urls.set(file, fileUrls);
	};
	for (const { pathname } of evidence.pages) {
		const url = pageUrl(pathname);
		// An unmatched page fails route reconciliation with its own diagnostic.
		const file = pageFile(url, files, pageEmitters);
		if (!file) continue;
		const publicUrl = publicPageUrl(evidence, url);
		const emitters = [...(pageEmitters.get(file) ?? [])];
		const notFound =
			emitters.length === 1 &&
			isNotFoundPage(evidence, emitters[0]!.pattern, publicUrl);
		if (notFound && evidence.recursive404 === true)
			fallbackScopes.set(file, notFoundScope(publicUrl));
		add(
			file,
			publicUrl,
			evidence.trailingSlash === "ignore" || notFound,
		);
	}
	for (const route of evidence.resolvedRoutes) {
		if (route.type !== "endpoint" || !route.isPrerendered)
			continue;
		for (const asset of evidence.emittedAssets.get(
			route.pattern,
		) ?? []) {
			const file = clientFile(evidence.clientDirectory, asset);
			if (!evidence.clientHtml.has(file)) continue;
			add(
				file,
				publicPageUrl(
					evidence,
					endpointUrl(route, file, evidence.trailingSlash),
				),
				routeTrailingSlash(
					"endpoint",
					route.pattern,
					evidence.trailingSlash,
				) === "ignore",
			);
		}
	}
	return [...evidence.clientHtml].map(([file, html]) => {
		const fallbackScope = fallbackScopes.get(file);
		return {
			urls: urls.get(file) ?? [
				withBase(
					evidence.base,
					file.split("/").map(encodeURIComponent).join("/"),
				),
			],
			html,
			...(fallbackScope === undefined ? {} : { fallbackScope }),
		};
	});
}

/** What a browser reads from an emitted document: its base and the URLs it requests. */
interface DocumentReferences {
	/** The `href` of the first `<base>` element in the document tree. */
	baseHref: string | undefined;
	/** URL attribute values and CSS `url()` references, with character references decoded. */
	urls: string[];
	/** `<link href>` values and `fetch("…")` targets in scripts. */
	requests: string[];
}

const urlAttribute = /^(?:src|href|poster|content|data-.+)$/;
const cssUrl = /url\(\s*["']?([^"')\s]*)/gi;

function attribute(
	element: DefaultTreeAdapterTypes.Element,
	name: string,
): string | undefined {
	return element.attrs.find(
		(candidate) => candidate.name === name,
	)?.value;
}

const asciiWhitespace = /[\t\n\f\r ]/;

/**
 * The image candidate URLs of a `srcset`, split by the HTML parsing rules: a URL
 * ends at whitespace, and descriptors run to the next comma outside parentheses.
 */
function srcsetUrls(value: string): string[] {
	const urls: string[] = [];
	let position = 0;
	while (position < value.length) {
		while (
			position < value.length &&
			(asciiWhitespace.test(value[position]!) ||
				value[position] === ",")
		)
			position++;
		let end = position;
		while (
			end < value.length &&
			!asciiWhitespace.test(value[end]!)
		)
			end++;
		let url = value.slice(position, end);
		position = end;
		if (url.endsWith(",")) url = url.replace(/,+$/, "");
		else {
			let parenthesized = false;
			while (position < value.length) {
				const character = value[position++];
				if (character === "(") parenthesized = true;
				else if (character === ")") parenthesized = false;
				else if (character === "," && !parenthesized) break;
			}
		}
		if (url) urls.push(url);
	}
	return urls;
}

function textContent(
	element: DefaultTreeAdapterTypes.Element,
): string {
	return element.childNodes
		.map((child) => ("value" in child ? child.value : ""))
		.join("");
}

// Keyed by document; the HTML is stored too, so a changed document is parsed again.
const parsedDocuments = new WeakMap<
	ClientDocument,
	{ html: string; references: DocumentReferences }
>();

/**
 * Parses a document as the HTML standard does, with scripting disabled so
 * `<noscript>` content counts. Comments and text are not elements, and template
 * contents are a separate fragment outside the document tree.
 */
function documentReferences(
	document: ClientDocument,
): DocumentReferences {
	const cached = parsedDocuments.get(document);
	if (cached?.html === document.html) return cached.references;
	const references: DocumentReferences = {
		baseHref: undefined,
		urls: [],
		requests: [],
	};
	// Walks in tree order without recursion, so deep markup cannot exhaust the stack.
	const pending = [
		...parse(document.html, { scriptingEnabled: false })
			.childNodes,
	].reverse();
	for (let node = pending.pop(); node; node = pending.pop()) {
		if (!("tagName" in node)) continue;
		const isBase =
			node.tagName === "base" &&
			node.namespaceURI === html.NS.HTML;
		for (const { name, value } of node.attrs) {
			// A base URL only resolves other references; it is not itself a request.
			if (name === "srcset" || name === "imagesrcset")
				references.urls.push(...srcsetUrls(value));
			else if (
				urlAttribute.test(name) &&
				!(isBase && name === "href")
			)
				references.urls.push(value);
			if (name === "style")
				for (const [, url = ""] of value.matchAll(cssUrl))
					references.urls.push(url);
		}
		if (node.namespaceURI === html.NS.HTML) {
			const href = node.attrs.find(
				({ name }) => name === "href",
			)?.value;
			if (node.tagName === "base" && href !== undefined)
				references.baseHref ??= href;
			// Astro preloads an island with `<link rel="preload" as="fetch">`.
			if (
				node.tagName === "link" &&
				href !== undefined &&
				attribute(node, "rel")
					?.toLowerCase()
					.split(/[\t\n\f\r ]+/)
					.includes("preload") &&
				attribute(node, "as")?.toLowerCase() === "fetch"
			)
				references.requests.push(href);
			if (node.tagName === "style")
				for (const [, url = ""] of textContent(node).matchAll(
					cssUrl,
				))
					references.urls.push(url);
			if (node.tagName === "script")
				for (const [, literal = ""] of textContent(
					node,
				).matchAll(/\bfetch\(\s*"((?:[^"\\]|\\.)*)"/g))
					try {
						// Astro writes the fetch URL as a JSON string.
						references.requests.push(
							JSON.parse(`"${literal}"`) as string,
						);
					} catch {
						// Not a JSON string, so not Astro's island request.
					}
		}
		for (
			let index = node.childNodes.length - 1;
			index >= 0;
			index--
		)
			pending.push(node.childNodes[index]!);
	}
	parsedDocuments.set(document, {
		html: document.html,
		references,
	});
	return references;
}

/**
 * The URLs that relative references in a document resolve against: each public
 * document URL, or the first `<base href>` resolved against it, as in a browser.
 * The browser falls back to the document URL for a `data:` or `javascript:` base.
 */
function documentBases(
	urls: readonly string[],
	href: string | undefined,
	origin: string,
): string[] {
	return urls.map((url) => {
		const document = `${origin}${url}`;
		const base =
			href !== undefined && URL.canParse(href, document)
				? new URL(href, document)
				: undefined;
		return base &&
			base.protocol !== "data:" &&
			base.protocol !== "javascript:"
			? base.href
			: document;
	});
}

/**
 * The URLs a document answers when resolving `reference`. A recursive 404 page
 * also answers every missing URL below its scope, so a relative reference can
 * resolve from any depth there. One URL per depth the reference can climb out of
 * covers every distinct result.
 */
function servedUrls(
	document: ClientDocument,
	reference: string,
): readonly string[] {
	if (document.fallbackScope === undefined) return document.urls;
	const scope =
		document.fallbackScope === "/" ? "" : document.fallbackScope;
	return [
		...document.urls,
		...Array.from(
			{ length: reference.split("/").length + 2 },
			(_, depth) => `${scope}/${"_/".repeat(depth)}_`,
		),
	];
}

/**
 * Matches a request to the application's endpoint in a URL attribute, a
 * `srcset` candidate or CSS url(), not in text, a comment or a URL on another
 * origin such as a CDN. Each reference resolves against the document base as a
 * browser resolves it, and a request has a query.
 */
function requestsEndpoint(
	documents: readonly ClientDocument[],
	endpoint: string,
	site: string | undefined,
): boolean {
	const origin = site ? new URL(site).origin : unknownOrigin;
	for (const document of documents) {
		const references = documentReferences(document);
		for (const reference of references.urls)
			for (const base of documentBases(
				servedUrls(document, reference),
				references.baseHref,
				origin,
			)) {
				const resolved = URL.canParse(reference, base)
					? new URL(reference, base)
					: undefined;
				if (
					resolved?.origin === origin &&
					resolved.pathname === endpoint &&
					resolved.search !== ""
				)
					return true;
			}
	}
	return false;
}

/**
 * Matches Astro's generated island preload link or fetch call to the
 * application's island endpoint, not page text, a comment or another origin.
 */
function requestsServerIsland(
	documents: readonly ClientDocument[],
	base: string,
	site: string | undefined,
): boolean {
	const origin = site ? new URL(site).origin : unknownOrigin;
	const prefix = withBase(base, "/_server-islands/");
	for (const document of documents) {
		const references = documentReferences(document);
		for (const target of references.requests)
			for (const documentBase of documentBases(
				servedUrls(document, target),
				references.baseHref,
				origin,
			)) {
				const resolved = URL.canParse(target, documentBase)
					? new URL(target, documentBase)
					: undefined;
				if (
					resolved?.origin === origin &&
					resolved.pathname.startsWith(prefix)
				)
					return true;
			}
	}
	return false;
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
			requestsServerIsland(
				clientDocuments,
				evidence.base,
				evidence.site,
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
			const file = clientFile(clientDirectory, asset);
			if (!files.has(file)) continue;
			addPrerendered(
				route,
				endpointUrl(route, file, evidence.trailingSlash),
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
			// Appending one by one keeps a large route below the engine's argument limit.
			for (const path of route.paths)
				prerendered.push({ kind: route.routeKind, ...path });
			if (route.routeKind === "page")
				for (const path of route.paths)
					if (
						isNotFoundPage(
							{ base: plan.base, recursive404 },
							// Classify the route below the base; a base ending in `/404` is not a 404 page.
							plan.base === "/"
								? route.pattern
								: route.pattern.slice(plan.base.length) || "/",
							path.url,
						)
					)
						notFound.push({
							scope: notFoundScope(path.url),
							...path,
						});
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
