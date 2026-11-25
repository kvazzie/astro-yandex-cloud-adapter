import type { PackageJson } from "pkg-types";
import npa from "npm-package-arg";
import semver from "semver";
import { parseRegistryRequirement } from "./Registry.ts";

/** The declared requirement for a root edge in the detected installation. */
export function applicationDependencyRequirement(
	application: PackageJson | undefined,
	name: string,
	developmentFirst = true,
): string | undefined {
	const development = application?.devDependencies?.[name];
	return (
		(developmentFirst ? development : undefined) ??
		application?.optionalDependencies?.[name] ??
		application?.dependencies?.[name] ??
		development ??
		application?.peerDependencies?.[name]
	);
}

/** The root application's npm override rules, inherited along dependency edges. */
export class ApplicationOverrides {
	private readonly application: PackageJson;
	private readonly parent?: ApplicationOverrides;
	private readonly key: string;
	private readonly children: ApplicationOverrides[];
	private readonly name?: string;
	private readonly range: string;
	private readonly value?: string;
	readonly identity: string;
	constructor(
		application: PackageJson,
		value: unknown = application.overrides,
		parent?: ApplicationOverrides,
		key = "",
	) {
		this.application = application;
		this.parent = parent;
		this.key = key;
		const object =
			typeof value === "string"
				? { ".": value }
				: value && typeof value === "object"
					? (value as Record<string, unknown>)
					: {};
		const split = key.lastIndexOf("@");
		this.name = key
			? split > 0
				? key.slice(0, split)
				: key
			: undefined;
		this.range = split > 0 ? key.slice(split + 1) : "*";
		// npm defaults a rule without "." to its key range; "*" keeps the requested spec.
		this.value =
			typeof object["."] === "string"
				? object["."] || "*"
				: parent
					? this.range
					: undefined;
		this.identity = parent ? `${parent.identity}/${key}` : "";
		this.children = Object.entries(object)
			.filter(([name]) => name !== ".")
			.map(
				([name, rules]) =>
					new ApplicationOverrides(
						application,
						rules,
						this,
						name,
					),
			);
	}
	forDependency(
		name: string,
		requested: string,
	): {
		spec: string;
		context: ApplicationOverrides;
		useOverrideBase?: true;
	} {
		const rules = new Map<string, ApplicationOverrides>();
		const contexts: ApplicationOverrides[] = [this];
		for (
			let context = this.parent;
			context;
			context = context.parent
		)
			contexts.push(context);
		for (const context of contexts) {
			for (const rule of context.children)
				if (!rules.has(rule.key)) rules.set(rule.key, rule);
			if (context.parent && !rules.has(context.key))
				rules.set(context.key, context);
		}
		const candidates = [...rules.values()].filter(
			(rule) => rule.name === name,
		);
		if (candidates.length === 0)
			return { spec: requested, context: this };
		const requirement = parseRegistryRequirement(
			name,
			requested,
		).requirement;
		const source = /^(workspace|link):/.test(requirement)
			? undefined
			: npa.resolve(name, requirement);
		const rule = candidates.find((rule) => {
			if (rule.name !== name) return false;
			if (rule.range === "*") return true;
			if (source?.type === "git")
				return Boolean(
					source.gitRange &&
					semver.intersects(source.gitRange, rule.range),
				);
			return (
				!semver.validRange(requirement) ||
				(semver.validRange(rule.range) !== null &&
					semver.intersects(requirement, rule.range))
			);
		});
		if (!rule) return { spec: requested, context: this };
		const replacement =
			rule.value !== "*" ? rule.value : undefined;
		let spec = replacement ?? requested;
		if (spec.startsWith("$")) {
			const reference = spec.slice(1);
			const value = applicationDependencyRequirement(
				this.application,
				reference,
			);
			if (typeof value !== "string")
				throw new Error(
					`Unable to resolve application override reference ${spec}.`,
				);
			spec = value;
		}
		return {
			spec,
			context: rule,
			// npm uses the override root for matched edges, including * rules.
			useOverrideBase: true,
		};
	}
}
