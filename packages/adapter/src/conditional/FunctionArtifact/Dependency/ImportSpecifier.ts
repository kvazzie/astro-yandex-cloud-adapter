import {
	getStaticString,
	isSyntaxNode,
	lookupLexicalBinding,
	parseModule,
	readLexicalScopes,
	visitSyntax,
	type LexicalScope,
	type SyntaxNode,
} from "../../../.emittedModules.ts";
import { isBuiltin } from "node:module";
import {
	basename,
	dirname,
	extname,
	join,
	resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	PlannedFile,
	PreparationSettings,
} from "../.types.ts";
import { stripJsonBom } from "./Source.ts";

type PackageRequestMode = "import" | "require" | "resolveImport";
type ResolveImport = (
	specifier: string,
	dynamic?: boolean,
) => LoaderRole | undefined;
export type PackageSubpathRequests = Map<
	string,
	Map<string, Set<PackageRequestMode>>
>;

export const commonJsExtensions = [
	".js",
	".json",
	".node",
] as const;

export function commonJsDirectoryRequest(
	specifier: string,
): boolean {
	return /(?:\/(?:\.{1,2})?|^\.{1,2})$/.test(specifier);
}

/** Inspects the files that will form an artifact, without requiring output files on disk. */
export function findRuntimePackageImports(
	files: readonly PlannedFile[],
	strategy: PreparationSettings["dependencyStrategy"],
	requests?: PackageSubpathRequests,
): Set<string> {
	if (
		strategy === "bundle" &&
		files.some((file) => file.path.endsWith(".node"))
	)
		throw new Error(
			'The Function Artifact contains a native runtime module, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
		);
	if (files.some((file) => file.path.endsWith(".cjs")))
		throw new Error(
			"The function artifact contains an unsupported CommonJS module. V1 function artifacts must use ESM.",
		);
	const names = new Set<string>();
	const emittedFiles = new Map(
		files.map((file) => [pathToFileURL(file.path).href, file]),
	);
	const firstEmittedFile = (
		target: string,
		suffixes: readonly string[],
	) =>
		suffixes
			.map((suffix) => pathToFileURL(target + suffix).href)
			.find((candidate) => emittedFiles.has(candidate));
	const emittedFile = (target: string) =>
		firstEmittedFile(target, ["", ...commonJsExtensions]);
	const emittedIndex = (target: string) =>
		firstEmittedFile(join(target, "index"), commonJsExtensions);
	const retainedManifest = (directory: string) => {
		const file = emittedFiles.get(
			pathToFileURL(join(directory, "package.json")).href,
		);
		// Preparation replaces the root manifest with an ESM manifest without main.
		if (
			file?.contents === undefined ||
			file.path === "package.json"
		)
			return undefined;
		const metadata: unknown = JSON.parse(
			stripJsonBom(file.contents),
		);
		return metadata && typeof metadata === "object"
			? (metadata as Record<string, unknown>)
			: {};
	};
	const emittedDirectory = (target: string) => {
		const main = retainedManifest(target)?.main;
		if (typeof main === "string" && main) {
			const entry = resolve(target, main);
			const candidate =
				emittedFile(entry) ?? emittedIndex(entry);
			if (candidate) return candidate;
		}
		return emittedIndex(target);
	};
	const extensionlessPackageType = (path: string) => {
		let directory = dirname(path);
		while (directory !== ".") {
			// Node's package scope lookup stops at a node_modules directory.
			if (basename(directory) === "node_modules")
				return undefined;
			const metadata = retainedManifest(directory);
			if (metadata) {
				const { type } = metadata;
				return type === "commonjs" || type === "module"
					? type
					: undefined;
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		return "module";
	};
	const isJavaScript = (path: string) => /\.m?js$/.test(path);
	const programs = new Map<string, SyntaxNode>();
	const modules = new Map<
		string,
		{ namespace: EmittedNamespace; inspect: () => void }
	>();
	const classifiedLoads = new Set<string>();
	const loadEmittedModule = (
		url: URL,
		dynamic = false,
		loader: "import" | "require" = "import",
	): EmittedNamespace | undefined => {
		const sourceURL = new URL(url);
		sourceURL.search = "";
		sourceURL.hash = "";
		const file = emittedFiles.get(sourceURL.href);
		if (
			!file ||
			(!isJavaScript(file.path) &&
				(extname(file.path) || file.contents === undefined))
		)
			return undefined;
		if (file.contents === undefined)
			throw new Error(
				`Missing computed module contents for ${file.path}.`,
			);
		const extensionless = !isJavaScript(file.path);
		// Each loader classifies an extensionless file by its own rules.
		const load = `${loader} ${sourceURL.href}`;
		if (extensionless && !classifiedLoads.has(load)) {
			let packageType: "commonjs" | "module" | undefined;
			// The CommonJS loader applies a package type only to .js files.
			if (loader === "import")
				try {
					packageType = extensionlessPackageType(file.path);
				} catch (error) {
					// Node reports an invalid package scope to this dynamic import's caller.
					if (dynamic && error instanceof SyntaxError)
						return undefined;
					throw error;
				}
			// Node runs a typeless file as CommonJS unless it needs ESM syntax.
			if (packageType !== "module") {
				const commonJsError = commonJsSyntaxError(file.contents);
				if (!commonJsError)
					throw new Error(
						`The function artifact contains an unsupported CommonJS module at ${file.path}. V1 function artifacts must use ESM.`,
					);
				if (packageType === "commonjs") {
					// Node reports this dynamic import's failure to the caller at runtime.
					if (dynamic) return undefined;
					throw commonJsError;
				}
			}
			classifiedLoads.add(load);
		}
		const loaded = modules.get(url.href);
		if (loaded) return loaded.namespace;
		let program = programs.get(sourceURL.href);
		if (!program) {
			try {
				program = parseModule(file.contents);
			} catch (error) {
				// Node reports this dynamic import's failure to the caller at runtime.
				if (
					dynamic &&
					extensionless &&
					error instanceof SyntaxError
				)
					return undefined;
				throw error;
			}
			programs.set(sourceURL.href, program);
		}
		addModule(url, program, file.path);
		return modules.get(url.href)?.namespace;
	};
	const addModule = (
		url: URL,
		program: SyntaxNode,
		path: string,
	): void => {
		const resolveImport: ResolveImport = (
			specifier,
			dynamic,
		) => {
			const builtin = builtinModuleRole(specifier);
			if (builtin) return builtin;
			const target = URL.parse(specifier);
			if (target?.protocol === "data:") {
				if (!modules.has(target.href)) {
					const inline = inlineJavaScript(new URL(target));
					if (inline !== undefined)
						addModule(
							target,
							parseModule(inline),
							`inline module in ${path}`,
						);
				}
				return modules.get(target.href)?.namespace;
			}
			if (!isRelativeSpecifier(specifier)) return undefined;
			const local = URL.parse(specifier, url);
			if (local?.protocol !== "file:") return undefined;
			let sourcePath: string;
			try {
				sourcePath = fileURLToPath(local);
			} catch (error) {
				if (
					error instanceof URIError ||
					error instanceof TypeError
				)
					return undefined;
				throw error;
			}
			const instance = pathToFileURL(sourcePath);
			// Match Node's file resolution by retaining only nonempty query and fragment values.
			instance.search = local.search;
			instance.hash = local.hash;
			return loadEmittedModule(instance, dynamic);
		};
		const resolveRequire = (
			specifier: string,
			resolveOnly = false,
		): string | undefined => {
			if (url.protocol !== "file:") return undefined;
			// CommonJS resolves a filesystem path, where percent escapes are literal.
			const target = resolve(
				dirname(fileURLToPath(url)),
				specifier,
			);
			const candidate =
				(commonJsDirectoryRequest(specifier)
					? undefined
					: emittedFile(target)) ?? emittedDirectory(target);
			return candidate &&
				(resolveOnly ||
					/\.(json|node)$/.test(candidate) ||
					loadEmittedModule(
						new URL(candidate),
						false,
						"require",
					))
				? candidate
				: undefined;
		};
		const bindings = runtimeLoaderBindings(
			program,
			resolveImport,
			(specifier, seen) => {
				const target = resolveRequire(specifier);
				const namespace = target
					? modules.get(target)?.namespace
					: undefined;
				const interop = namespace?.resolve(
					"module.exports",
					seen,
				);
				return interop && interop !== ambiguousExport
					? interop.role
					: namespace;
			},
		);
		modules.set(url.href, {
			namespace: emittedNamespace(
				program,
				bindings.bindingValue,
				resolveImport,
			),
			inspect: () => {
				for (const [
					request,
					modes,
				] of findImportedPackageSpecifiers(
					program,
					path,
					strategy,
					bindings,
					resolveImport,
					resolveRequire,
				)) {
					const name = packageNameFromSpecifier(request);
					names.add(name);
					if (requests) {
						const subpaths =
							requests.get(name) ??
							new Map<string, Set<PackageRequestMode>>();
						const subpath = "." + request.slice(name.length);
						const loaders =
							subpaths.get(subpath) ??
							new Set<PackageRequestMode>();
						for (const mode of modes) loaders.add(mode);
						subpaths.set(subpath, loaders);
						requests.set(name, subpaths);
					}
				}
			},
		});
	};
	// A filename without an extension can also be a text or binary asset.
	// Load it as a module only when an import or require selects it.
	for (const [href, file] of emittedFiles)
		if (isJavaScript(file.path))
			loadEmittedModule(new URL(href));
	// Linking is lazy so imports can refer to later files or to cyclic re-exports.
	// Map iteration also inspects module instances discovered by the visitor.
	for (const module of modules.values()) module.inspect();
	return names;
}

const commonJsWrapperNames = new Set([
	"exports",
	"require",
	"module",
	"__filename",
	"__dirname",
]);

/** Returns the error that makes Node reject the CommonJS wrapper for this source. */
function commonJsSyntaxError(
	source: string,
): SyntaxError | undefined {
	let program: SyntaxNode;
	try {
		program = parseModule(source, "commonjs");
	} catch (error) {
		if (error instanceof SyntaxError) return error;
		throw error;
	}
	// Node retries as ESM when a lexical declaration shadows a wrapper parameter.
	for (const statement of program.body as SyntaxNode[]) {
		const names =
			statement.type === "ClassDeclaration"
				? bindingNames(statement.id)
				: statement.type === "VariableDeclaration" &&
					  statement.kind !== "var"
					? (statement.declarations as SyntaxNode[]).flatMap(
							(declaration) => bindingNames(declaration.id),
						)
					: [];
		const name = names.find((name) =>
			commonJsWrapperNames.has(name),
		);
		if (name)
			return new SyntaxError(
				`Identifier '${name}' has already been declared`,
			);
	}
	return undefined;
}

function bindingNames(pattern: unknown): string[] {
	if (!isSyntaxNode(pattern)) return [];
	switch (pattern.type) {
		case "Identifier":
			return [pattern.name as string];
		case "ObjectPattern":
			return (pattern.properties as SyntaxNode[]).flatMap(
				(property) =>
					bindingNames(
						property.type === "RestElement"
							? property.argument
							: property.value,
					),
			);
		case "ArrayPattern":
			return (pattern.elements as unknown[]).flatMap(
				bindingNames,
			);
		case "AssignmentPattern":
			return bindingNames(pattern.left);
		case "RestElement":
			return bindingNames(pattern.argument);
		default:
			return [];
	}
}

declare const directoryPathBrand: unique symbol;

export type DirectoryPath = string & {
	readonly [directoryPathBrand]: "DirectoryPath";
};

export function asDirectoryPath(path: string): DirectoryPath {
	return path as DirectoryPath;
}

function findImportedPackageSpecifiers(
	program: SyntaxNode,
	relativePath: string,
	strategy: PreparationSettings["dependencyStrategy"],
	bindings: ReturnType<typeof runtimeLoaderBindings>,
	resolveImport: ResolveImport,
	resolveRequire: (
		specifier: string,
		resolveOnly?: boolean,
	) => string | undefined,
) {
	const specifiers = new Map<
		BareImportSpecifier,
		Set<PackageRequestMode>
	>();
	const collectPackageImport = (
		importSpecifier: string,
		mode: PackageRequestMode,
	): void => {
		if (
			importSpecifier.endsWith(".node") &&
			strategy === "bundle"
		) {
			throw new Error(
				`The Function Artifact contains the native runtime module ${importSpecifier} referenced by ${relativePath}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
			);
		}
		// Native file imports stay inside the owning package for install builds,
		// so the package itself is pinned; bundle builds cannot carry native code.
		if (!isBareImportSpecifier(importSpecifier)) return;
		const modes =
			specifiers.get(importSpecifier) ??
			new Set<PackageRequestMode>();
		modes.add(mode);
		specifiers.set(importSpecifier, modes);
	};
	const inspectModuleImport = (
		specifier: string,
		dynamic = false,
	): void => {
		const url = URL.parse(specifier);
		if (
			url?.protocol === "data:" ||
			isRelativeSpecifier(specifier)
		) {
			resolveImport(specifier, dynamic);
		} else collectPackageImport(specifier, "import");
	};
	const rejectDynamicImport = (detail?: string): never => {
		if (strategy === "install") {
			throw new Error(
				`The Function Artifact contains unresolved dynamic runtime dependency resolution${detail ? ` (${detail})` : ""} in ${relativePath}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
			);
		}
		throw new Error(
			`The Function Artifact contains unresolved dynamic or native runtime dependency resolution${detail ? ` (${detail})` : ""} in ${relativePath}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
		);
	};
	const { bindingRole, isUnbound } = bindings;
	visitSyntax(program, (node, ancestors) => {
		const parent = ancestors.at(-1);
		if (
			node.type === "Identifier" &&
			parent &&
			(parent.type === "MetaProperty" ||
				(parent.type === "ExportSpecifier" &&
					(parent.local !== node ||
						isSyntaxNode(ancestors.at(-2)?.source))) ||
				(parent.type === "ExportAllDeclaration" &&
					parent.exported === node) ||
				(parent.type === "MemberExpression" &&
					parent.property === node &&
					!parent.computed) ||
				([
					"Property",
					"MethodDefinition",
					"PropertyDefinition",
				].includes(parent.type) &&
					parent.key === node &&
					!parent.computed &&
					parent.value !== node))
		)
			return;

		const role = bindingRole(node);
		if (
			role === "register" &&
			!parent?.type.startsWith("Import")
		)
			rejectDynamicImport(
				"Node module registration cannot be packaged statically",
			);
		if (
			role === "factory" ||
			role === "require" ||
			role === "resolveImport" ||
			role === "resolveRequire" ||
			role === "module" ||
			role === "meta" ||
			role === "builtin"
		) {
			const declaration =
				parent?.type === "VariableDeclarator" &&
				isSyntaxNode(parent.id) &&
				(parent.id.type === "Identifier"
					? parent.init === null ||
						(bindingRole(parent.id) === role &&
							bindingRole(parent.init) === role)
					: (role === "module" || role === "meta") &&
						isLoaderPattern(parent.id, role, bindingRole)) &&
				(ancestors.at(-3)?.type !== "ExportNamedDeclaration" ||
					(role === "meta" &&
						parent.id.type === "ObjectPattern" &&
						Array.isArray(parent.id.properties) &&
						parent.id.properties.every(
							(property: unknown) =>
								isSyntaxNode(property) &&
								loaderPropertyRole(
									role,
									isSyntaxNode(property.key) &&
										property.key.type === "Identifier"
										? property.key.name
										: getStaticString(property.key),
								) === undefined &&
								bindingRole(property.value) === undefined,
						))) &&
				(parent.id === node || parent.init === node);
			const importBinding = parent?.type.startsWith("Import");
			const patternBinding =
				parent?.type === "Property" &&
				parent.value === node &&
				isLoaderPattern(ancestors.at(-2), role);
			const awaited =
				parent?.type === "AwaitExpression" &&
				parent.argument === node;
			const observation =
				parent?.type === "UnaryExpression" &&
				parent.operator === "typeof" &&
				parent.argument === node;
			if (
				node.type === "ImportExpression" &&
				!awaited &&
				!observation
			)
				rejectDynamicImport();
			const call =
				parent?.type === "CallExpression" &&
				parent.callee === node;
			const member =
				parent?.type === "MemberExpression" &&
				parent.object === node &&
				((role === "meta" &&
					(parent.computed
						? getStaticString(parent.property) !== undefined
						: isSyntaxNode(parent.property) &&
							parent.property.type === "Identifier")) ||
					(role === "module" &&
						!parent.computed &&
						node.type !== "ImportExpression") ||
					(role === "require" &&
						bindingRole(parent) === "resolveRequire"));
			if (
				!declaration &&
				!importBinding &&
				!patternBinding &&
				!awaited &&
				!call &&
				!observation &&
				!member
			)
				rejectDynamicImport();
		}
		if (
			node.type === "VariableDeclarator" &&
			bindingRole(node.init) === "process" &&
			isSyntaxNode(node.id) &&
			node.id.type === "ObjectPattern" &&
			(!isLoaderPattern(node.id, "process", bindingRole) ||
				(ancestors.at(-2)?.type === "ExportNamedDeclaration" &&
					Array.isArray(node.id.properties) &&
					node.id.properties.some(
						(property: unknown) =>
							isSyntaxNode(property) &&
							loaderPropertyRole(
								"process",
								isSyntaxNode(property.key) &&
									property.key.type === "Identifier"
									? property.key.name
									: getStaticString(property.key),
							) === "builtin",
					)))
		)
			rejectDynamicImport(
				"process getter destructuring changes or exports a loader binding",
			);
		if (
			node.type === "AssignmentPattern" &&
			bindingRole(node.right) === "process" &&
			isSyntaxNode(node.left) &&
			node.left.type === "ObjectPattern" &&
			!isLoaderPattern(node.left, "process", bindingRole)
		)
			rejectDynamicImport(
				"process parameter destructuring changes a loader binding",
			);
		// Process is ordinary data until a property can select its builtin loader.
		if (
			node.type === "MemberExpression" &&
			node.computed &&
			getStaticString(node.property) === undefined
		) {
			const owner = bindingRole(node.object);
			if (owner === "process")
				rejectDynamicImport(
					"process builtin lookup must use a fixed property",
				);
			if (
				typeof owner === "object" &&
				namespaceExposesLoader(owner)
			)
				rejectDynamicImport(
					"namespace lookup must use a fixed property",
				);
		}
		const pattern =
			node.type === "VariableDeclarator"
				? node.id
				: node.type === "AssignmentPattern" ||
					  node.type === "AssignmentExpression"
					? node.left
					: undefined;
		if (
			isSyntaxNode(pattern) &&
			pattern.type === "ObjectPattern" &&
			Array.isArray(pattern.properties) &&
			pattern.properties.some(
				(property: unknown) =>
					isSyntaxNode(property) &&
					property.computed &&
					getStaticString(property.key) === undefined,
			)
		) {
			const owner = bindingRole(
				node.type === "VariableDeclarator"
					? node.init
					: node.right,
			);
			if (
				typeof owner === "object" &&
				namespaceExposesLoader(owner)
			)
				rejectDynamicImport(
					"namespace lookup must use a fixed property",
				);
		}
		if (
			node.type === "VariableDeclarator" &&
			isSyntaxNode(node.id) &&
			node.id.type === "Identifier" &&
			node.init !== null &&
			(bindingRole(node.id) === "process" ||
				bindingRole(node.init) === "process") &&
			bindingRole(node.id) !== bindingRole(node.init)
		)
			rejectDynamicImport(
				"process alias initialization changes its binding role",
			);
		if (
			node.type === "AssignmentExpression" &&
			(bindingRole(node.left) === "process" ||
				bindingRole(node.right) === "process") &&
			!(
				node.operator === "=" &&
				isSyntaxNode(node.left) &&
				((node.left.type === "Identifier" &&
					bindingRole(node.left) === bindingRole(node.right)) ||
					(bindingRole(node.right) === "process" &&
						isLoaderPattern(node.left, "process", bindingRole)))
			)
		)
			rejectDynamicImport(
				"process alias assignment cannot preserve its binding role",
			);

		if (
			node.type === "CallExpression" &&
			bindingRole(node.callee) === "builtin" &&
			(!Array.isArray(node.arguments) ||
				node.arguments.length !== 1 ||
				getStaticString(node.arguments[0]) === undefined)
		)
			rejectDynamicImport(
				"process.getBuiltinModule must use one fixed builtin name",
			);
		if (
			node.type === "CallExpression" &&
			bindingRole(node.callee) === "factory"
		) {
			const argument: unknown = Array.isArray(node.arguments)
				? node.arguments[0]
				: undefined;
			if (
				!isSyntaxNode(argument) ||
				argument.type !== "MemberExpression" ||
				(argument.computed
					? getStaticString(argument.property) !== "url"
					: !isIdentifier(argument.property, "url")) ||
				!isSyntaxNode(argument.object) ||
				argument.object.type !== "MetaProperty" ||
				!isIdentifier(argument.object.meta, "import") ||
				!isIdentifier(argument.object.property, "meta") ||
				(node.arguments &&
					(node.arguments as unknown[]).length !== 1)
			)
				rejectDynamicImport(
					"createRequire must use import.meta.url",
				);
		}
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration": {
				const importSpecifier = getStaticString(node.source);
				if (
					node.type !== "ImportDeclaration" &&
					builtinModuleRole(importSpecifier) !== undefined &&
					(node.type === "ExportAllDeclaration" ||
						(Array.isArray(node.specifiers) &&
							node.specifiers.some((specifier: unknown) => {
								if (!isSyntaxNode(specifier)) return false;
								const name =
									isSyntaxNode(specifier.local) &&
									specifier.local.type === "Identifier"
										? specifier.local.name
										: getStaticString(specifier.local);
								return builtinModuleRole(importSpecifier) ===
									"process"
									? name === "getBuiltinModule" ||
											name === "default"
									: loaderPropertyRole("module", name) !==
											undefined || name === "register";
							})))
				)
					rejectDynamicImport(
						"Node loader re-exports cannot be tracked across modules",
					);
				if (importSpecifier)
					inspectModuleImport(importSpecifier);
				return;
			}
			case "ImportExpression": {
				const importSpecifier = getStaticString(node.source);
				if (importSpecifier) {
					inspectModuleImport(importSpecifier, true);
				} else if (
					!isAstroLoggerImport(node.source, ancestors, bindings)
				) {
					rejectDynamicImport();
				}
				return;
			}
			case "CallExpression": {
				const { callee, arguments: parameters } = node;
				if (!isSyntaxNode(callee)) return;
				const role = bindingRole(callee);
				const resolves =
					role === "resolveImport" || role === "resolveRequire";
				const requires =
					role === "require" ||
					(isUnbound(callee) &&
						(isIdentifier(callee, "require") ||
							isIdentifier(callee, "__require")));
				if (!resolves && !requires) return;
				const args = Array.isArray(parameters)
					? (parameters as unknown[])
					: [];
				if (resolves && args.length !== 1)
					rejectDynamicImport(
						"resolution options or additional arguments are not accounted for; use require.resolve('package') or import.meta.resolve('package') without options",
					);
				const specifier =
					getStaticString(args[0]) ?? rejectDynamicImport();
				if (
					(requires || role === "resolveRequire") &&
					isCommonJsRelativeSpecifier(specifier) &&
					!resolveRequire(specifier, role === "resolveRequire")
				)
					rejectDynamicImport(
						`relative ${role === "resolveRequire" ? "require.resolve" : "require"} "${specifier}" does not name a retained file supported by the Function Artifact`,
					);
				collectPackageImport(
					specifier,
					role === "resolveImport" ? "resolveImport" : "require",
				);
				return;
			}
			default: {
				return;
			}
		}
	});
	return specifiers;
}

function inlineJavaScript(url: URL): string | undefined {
	url.hash = "";
	const comma = url.href.indexOf(",");
	const header = url.href.slice(5, comma).trim();
	if (
		comma < 0 ||
		!/^(?:text|application)\/javascript\s*(?:;|$)/i.test(header)
	)
		return undefined;
	// Data URLs percent-decode bytes first, including base64 padding. A raw
	// percent sign (e.g. the JS remainder operator) remains part of the source.
	const body = Buffer.from(url.href.slice(comma + 1))
		.toString("latin1")
		.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
	return Buffer.from(
		body,
		/; *base64$/i.test(header) ? "base64" : "latin1",
	).toString("utf8");
}

declare const bareSpecifierBrand: unique symbol;

type BareImportSpecifier = string & {
	readonly [bareSpecifierBrand]: "BareImportSpecifier";
};

function isBareImportSpecifier(
	importSpecifier: string,
): importSpecifier is BareImportSpecifier {
	if (
		importSpecifier.startsWith(".") ||
		importSpecifier.startsWith("/") ||
		importSpecifier.startsWith("file:") ||
		URL.parse(importSpecifier)?.protocol === "data:"
	) {
		return false;
	}
	return !isBuiltin(importSpecifier);
}

function packageNameFromSpecifier(
	bareSpecifier: BareImportSpecifier,
): string {
	if (bareSpecifier.startsWith("@")) {
		return bareSpecifier.split("/").slice(0, 2).join("/");
	}
	const slashIndex = bareSpecifier.indexOf("/");
	return slashIndex === -1
		? bareSpecifier
		: bareSpecifier.slice(0, slashIndex);
}

function isAstroLoggerImport(
	sourceNode: unknown,
	ancestors: SyntaxNode[],
	{
		sameBinding,
		isStableBinding,
	}: Pick<
		ReturnType<typeof runtimeLoaderBindings>,
		"sameBinding" | "isStableBinding"
	>,
): boolean {
	// Astro's builtin logger dispatch survives minification; its local names do not.
	const dispatch = ancestors.findLast(
		(node) => node.type === "SwitchStatement",
	);
	const loader = ancestors.findLast(
		(node) => node.type === "FunctionDeclaration",
	);
	const branch = ancestors.findLast(
		(node) => node.type === "SwitchCase",
	);
	if (
		!dispatch ||
		!loader ||
		!branch ||
		!Array.isArray(dispatch.cases) ||
		!isSyntaxNode(dispatch.discriminant) ||
		!isSyntaxNode(dispatch.discriminant.object) ||
		dispatch.discriminant.object.type !== "Identifier" ||
		!Array.isArray(loader.params) ||
		!isSyntaxNode(loader.body) ||
		!Array.isArray(loader.body.body)
	)
		return false;
	const configName = dispatch.discriminant.object.name;
	if (
		typeof configName !== "string" ||
		!sameBinding(loader.params[0], dispatch.discriminant.object)
	)
		return false;
	const isEntrypoint = (
		value: unknown,
		object: string,
	): boolean =>
		isSyntaxNode(value) &&
		value.type === "MemberExpression" &&
		isIdentifier(value.object, object) &&
		(value.computed
			? getStaticString(value.property) === "entrypoint"
			: isIdentifier(value.property, "entrypoint"));
	if (!isEntrypoint(dispatch.discriminant, configName))
		return false;
	const cases = dispatch.cases.flatMap((node) =>
		isSyntaxNode(node) ? [getStaticString(node.test)] : [],
	);
	if (
		![
			"astro/logger/node",
			"astro/logger/console",
			"astro/logger/json",
			"astro/logger/compose",
		].every((name) => cases.includes(name))
	)
		return false;
	for (const statement of loader.body.body as unknown[]) {
		if (
			!isSyntaxNode(statement) ||
			statement.type !== "VariableDeclaration" ||
			!Array.isArray(statement.declarations)
		)
			continue;
		for (const declaration of statement.declarations as unknown[]) {
			if (
				!isSyntaxNode(declaration) ||
				!isSyntaxNode(declaration.id) ||
				declaration.id.type !== "Identifier" ||
				typeof declaration.id.name !== "string" ||
				!isSyntaxNode(declaration.init) ||
				declaration.init.type !== "CallExpression" ||
				!isSyntaxNode(declaration.init.callee) ||
				declaration.init.callee.type !== "Identifier" ||
				typeof declaration.init.callee.name !== "string" ||
				!Array.isArray(declaration.init.arguments) ||
				declaration.init.arguments.length !== 1 ||
				!isEntrypoint(
					declaration.init.arguments[0],
					configName,
				) ||
				!isSyntaxNode(declaration.init.arguments[0]) ||
				!sameBinding(
					declaration.init.arguments[0].object,
					loader.params[0],
				)
			)
				continue;
			if (
				branch.test === null &&
				sameBinding(sourceNode, declaration.id) &&
				isStableBinding(declaration.id)
			)
				return true;
			const callback = ancestors.findLast(
				(node) => node.type === "ArrowFunctionExpression",
			);
			const parameter: unknown =
				callback && Array.isArray(callback.params)
					? callback.params[0]
					: undefined;
			if (
				getStaticString(branch.test) ===
					"astro/logger/compose" &&
				isSyntaxNode(parameter) &&
				parameter.type === "Identifier" &&
				typeof parameter.name === "string" &&
				isSyntaxNode(sourceNode) &&
				sourceNode.type === "CallExpression" &&
				sameBinding(
					sourceNode.callee,
					declaration.init.callee,
				) &&
				isStableBinding(declaration.init.callee) &&
				Array.isArray(sourceNode.arguments) &&
				sourceNode.arguments.length === 1 &&
				isEntrypoint(sourceNode.arguments[0], parameter.name) &&
				isSyntaxNode(sourceNode.arguments[0]) &&
				sameBinding(sourceNode.arguments[0].object, parameter)
			)
				return true;
		}
	}
	return false;
}

function isRelativeSpecifier(specifier: string): boolean {
	return (
		specifier.startsWith("./") || specifier.startsWith("../")
	);
}

function isCommonJsRelativeSpecifier(
	specifier: string,
): boolean {
	return (
		specifier === "." ||
		specifier === ".." ||
		isRelativeSpecifier(specifier)
	);
}

function isIdentifier(value: unknown, name: string): boolean {
	return (
		isSyntaxNode(value) &&
		value.type === "Identifier" &&
		value.name === name
	);
}

interface ExportBinding {
	origin?: object;
	role?: LoaderRole;
	isDefined?: () => boolean;
	mutableCopy?: true;
}

const ambiguousExport: ExportBinding = {};

interface EmittedNamespace {
	exportNames(seen: Set<EmittedNamespace>): Set<string>;
	resolve(
		name: string,
		seen: Set<unknown>,
	): ExportBinding | undefined;
}

function exportName(value: unknown): string | undefined {
	return isSyntaxNode(value) && typeof value.name === "string"
		? value.name
		: getStaticString(value);
}

/** Resolve a static export back to its lexical binding without evaluating either module. */
function emittedNamespace(
	program: SyntaxNode,
	bindingValue: (
		value: unknown,
		seen: Set<unknown>,
	) => ExportBinding,
	resolveImport: ResolveImport,
): EmittedNamespace {
	const exports = new Map<
		string,
		(seen: Set<unknown>) => ExportBinding
	>();
	const stars: Array<() => LoaderRole | undefined> = [];
	for (const statement of program.body as SyntaxNode[]) {
		const { declaration, source } = statement;
		if (statement.type === "ExportDefaultDeclaration") {
			exports.set("default", (seen) => ({
				...bindingValue(declaration, seen),
				origin: undefined,
			}));
			continue;
		}
		if (
			statement.type !== "ExportNamedDeclaration" &&
			statement.type !== "ExportAllDeclaration"
		)
			continue;
		const specifier = getStaticString(source);
		const imported = () =>
			specifier ? resolveImport(specifier) : undefined;
		if (statement.type === "ExportAllDeclaration") {
			const name = exportName(statement.exported);
			if (name)
				exports.set(name, () => {
					const role = imported();
					return {
						role,
						origin: typeof role === "object" ? role : undefined,
						isDefined: () => true,
					};
				});
			else stars.push(imported);
			continue;
		}
		if (isSyntaxNode(declaration)) {
			if (Array.isArray(declaration.declarations)) {
				const bindPattern = (id: unknown): void => {
					if (!isSyntaxNode(id)) return;
					if (
						id.type === "Identifier" &&
						typeof id.name === "string"
					)
						exports.set(id.name, (seen) =>
							bindingValue(id, seen),
						);
					else if (
						id.type === "ObjectPattern" &&
						Array.isArray(id.properties)
					)
						for (const prop of id.properties as SyntaxNode[])
							bindPattern(prop.value ?? prop.argument);
					else if (
						id.type === "ArrayPattern" &&
						Array.isArray(id.elements)
					)
						for (const element of id.elements)
							bindPattern(element);
					else if (
						id.type === "AssignmentPattern" ||
						id.type === "RestElement"
					)
						bindPattern(id.left ?? id.argument);
				};
				for (const d of declaration.declarations as SyntaxNode[])
					bindPattern(d.id);
			} else {
				const name = exportName(declaration.id);
				if (name) exports.set(name, () => ({}));
			}
		}
		for (const item of statement.specifiers as SyntaxNode[]) {
			const name = exportName(item.exported),
				local = exportName(item.local);
			if (name && local)
				exports.set(name, (seen) =>
					specifier
						? (loaderPropertyValue(imported(), local, seen) ??
							{})
						: bindingValue(item.local, seen),
				);
		}
	}
	const keys = new Map<string, object>();
	return {
		exportNames(seen) {
			if (seen.has(this)) return new Set();
			const path = new Set(seen).add(this);
			const names = new Set(exports.keys());
			for (const target of stars) {
				const namespace = target();
				if (typeof namespace === "object")
					for (const name of namespace.exportNames(path))
						if (name !== "default") names.add(name);
			}
			return names;
		},
		resolve(name, seen) {
			const key = keys.get(name) ?? {};
			if (seen.has(key)) return undefined;
			keys.set(name, key);
			const path = new Set(seen).add(key);
			const explicit = exports.get(name);
			if (explicit) {
				const selected = explicit(path);
				return selected === ambiguousExport || selected.origin
					? selected
					: { ...selected, origin: key };
			}
			if (name === "default") return undefined;
			let result: ExportBinding | undefined;
			for (const target of stars) {
				const namespace = target();
				if (typeof namespace !== "object") continue;
				const selected = namespace.resolve(name, path);
				if (!selected) continue;
				if (
					selected === ambiguousExport ||
					(result && result.origin !== selected.origin)
				)
					return ambiguousExport;
				result = selected;
			}
			return result;
		},
	};
}

type LoaderRole =
	| EmittedNamespace
	| "factory"
	| "require"
	| "resolveImport"
	| "resolveRequire"
	| "module"
	| "meta"
	| "process"
	| "builtin"
	| "register";

function namespaceExposesLoader(
	namespace: EmittedNamespace,
	seen = new Set<EmittedNamespace>(),
): boolean {
	if (seen.has(namespace)) return false;
	seen.add(namespace);
	for (const name of namespace.exportNames(new Set())) {
		const role = namespace.resolve(name, new Set())?.role;
		if (
			typeof role === "object"
				? namespaceExposesLoader(role, seen)
				: role !== undefined
		)
			return true;
	}
	return false;
}

function builtinModuleRole(
	specifier: string | undefined,
): LoaderRole | undefined {
	if (["module", "node:module"].includes(specifier ?? ""))
		return "module";
	if (["process", "node:process"].includes(specifier ?? ""))
		return "process";
	return undefined;
}

function loaderPropertyRole(
	role: LoaderRole | undefined,
	property: unknown,
	seen = new Set<unknown>(),
): LoaderRole | undefined {
	if (typeof role === "object" && typeof property === "string")
		return role.resolve(property, seen)?.role;
	if (role === "module") {
		if (property === "register") return "register";
		if (property === "createRequire") return "factory";
		if (property === "default" || property === "Module")
			return "module";
	}
	if (role === "process") {
		if (property === "getBuiltinModule") return "builtin";
		if (property === "default") return "process";
	}
	if (role === "meta" && property === "resolve")
		return "resolveImport";
	if (role === "require" && property === "resolve")
		return "resolveRequire";
	return undefined;
}

function loaderPropertyValue(
	role: LoaderRole | undefined,
	property: unknown,
	seen: Set<unknown>,
): ExportBinding | undefined {
	if (typeof role === "object" && typeof property === "string")
		return role.resolve(property, seen);
	const selectedRole = loaderPropertyRole(role, property, seen);
	return selectedRole ? { role: selectedRole } : undefined;
}

function isLoaderPattern(
	value: unknown,
	role?: LoaderRole,
	bindingRole?: (value: unknown) => LoaderRole | undefined,
): boolean {
	return (
		isSyntaxNode(value) &&
		value.type === "ObjectPattern" &&
		Array.isArray(value.properties) &&
		value.properties.length > 0 &&
		value.properties.every(
			(property: unknown) =>
				isSyntaxNode(property) &&
				property.type === "Property" &&
				!property.computed &&
				isSyntaxNode(property.key) &&
				(property.key.type === "Identifier" ||
					getStaticString(property.key) !== undefined) &&
				(role !== "module" ||
					(!isIdentifier(property.key, "register") &&
						getStaticString(property.key) !== "register")) &&
				isSyntaxNode(property.value) &&
				property.value.type === "Identifier" &&
				(!bindingRole ||
					bindingRole(property.value) ===
						loaderPropertyRole(
							role,
							property.key.type === "Identifier"
								? property.key.name
								: getStaticString(property.key),
						)),
		)
	);
}

/** Distinguishes Node loaders from variables that happen to be named require. */
export function readRuntimeRequireBindings(
	program: SyntaxNode,
	commonjs: boolean,
) {
	const { bindingRole } = runtimeLoaderBindings(
		program,
		builtinModuleRole,
		() => undefined,
		commonjs,
	);
	return (callee: SyntaxNode) =>
		bindingRole(callee) === "require";
}

/** Resolve lexical bindings before inspecting calls, including declarations after a use. */
function runtimeLoaderBindings(
	program: SyntaxNode,
	resolveImport: ResolveImport,
	resolveRequire: (
		specifier: string,
		seen: Set<unknown>,
	) => LoaderRole | undefined,
	commonjs = false,
): {
	bindingRole: (
		value: unknown,
		seen?: Set<unknown>,
	) => LoaderRole | undefined;
	bindingValue: (
		value: unknown,
		seen: Set<unknown>,
	) => ExportBinding;
	isUnbound: (value: unknown) => boolean;
	sameBinding: (a: unknown, b: unknown) => boolean;
	isStableBinding: (value: SyntaxNode) => boolean;
} {
	interface Binding {
		value?: unknown;
		importValue?: (
			seen: Set<unknown>,
		) => ExportBinding | undefined;
		lexicalInitializer?: boolean;
		role?: LoaderRole;
		property?: string;
		fallback?: unknown;
		restExcludes?: ReadonlySet<string>;
		restNamespaces?: WeakMap<EmittedNamespace, EmittedNamespace>;
		previous?: Binding;
		declaration?: SyntaxNode;
		bodyScope?: Scope;
		direct?: boolean;
	}
	type Scope = LexicalScope<Binding>;
	const declarePattern = (
		value: unknown,
		scope: Scope,
		binding: Binding = {},
	) => {
		if (!isSyntaxNode(value)) return;
		if (
			value.type === "Identifier" &&
			typeof value.name === "string"
		)
			scope.bindings.set(value.name, binding);
		else if (value.type === "RestElement")
			declarePattern(value.argument, scope);
		else if (value.type === "AssignmentPattern")
			declarePattern(
				value.left,
				scope,
				binding.property === undefined
					? { ...binding, value: value.right }
					: { ...binding, fallback: value.right },
			);
		else if (
			value.type === "ArrayPattern" &&
			Array.isArray(value.elements)
		) {
			for (const element of value.elements)
				declarePattern(element, scope);
		} else if (
			value.type === "ObjectPattern" &&
			Array.isArray(value.properties)
		) {
			const keys = new Set<string>();
			for (const property of value.properties as unknown[]) {
				if (!isSyntaxNode(property)) continue;
				if (property.type === "RestElement") {
					declarePattern(property.argument, scope, {
						value: binding.value,
						restExcludes: keys,
					});
					continue;
				}
				const key = property.computed
					? getStaticString(property.key)
					: exportName(property.key);
				if (key !== undefined) keys.add(key);
				declarePattern(
					property.value,
					scope,
					key !== undefined &&
						isSyntaxNode(property.value) &&
						(property.value.type === "Identifier" ||
							(property.value.type === "AssignmentPattern" &&
								isSyntaxNode(property.value.left) &&
								property.value.left.type === "Identifier"))
						? { value: binding.value, property: key }
						: {},
				);
			}
		}
	};
	const scopes = readLexicalScopes<Binding>(
		program,
		(node, scope, outer, ancestors, isFunction) => {
			if (commonjs && node.type === "Program") {
				const requireParameter: Binding = { role: "require" };
				scope.bindings.set("require", requireParameter);
				scope.parameters = new Map([
					["require", requireParameter],
				]);
			}
			const parent = ancestors.at(-1);
			if (
				(node.type === "FunctionDeclaration" ||
					node.type === "ClassDeclaration") &&
				outer
			)
				declarePattern(node.id, outer);
			if (
				node.type === "ClassDeclaration" ||
				node.type === "ClassExpression"
			)
				declarePattern(node.id, scope);
			if (isFunction) {
				declarePattern(node.id, scope);
				if (Array.isArray(node.params))
					for (const param of node.params)
						declarePattern(param, scope);
			}
			if (node.type === "CatchClause")
				declarePattern(node.param, scope);
			if (node.type === "VariableDeclarator") {
				let target = scope;
				if (parent?.kind === "var")
					while (!target.varScope && target.parent)
						target = target.parent;
				if (
					parent?.kind === "var" &&
					node.init === null &&
					isSyntaxNode(node.id) &&
					node.id.type === "Identifier" &&
					typeof node.id.name === "string" &&
					target.bindings.has(node.id.name)
				)
					return;
				const name = isSyntaxNode(node.id)
					? node.id.name
					: undefined;
				const previous =
					parent?.kind === "var" &&
					typeof name === "string" &&
					target.parameters?.has(name)
						? target.bindings.get(name)
						: undefined;
				declarePattern(
					node.id,
					target,
					previous
						? {
								value: node.init,
								previous,
								declaration: node,
								bodyScope: target,
								direct:
									scope === target &&
									(ancestors.at(-2)?.type === "BlockStatement" ||
										ancestors.at(-2)?.type === "Program"),
							}
						: {
								value: node.init,
								lexicalInitializer: parent?.kind !== "var",
							},
				);
			}
			if (
				node.type === "ImportDeclaration" &&
				Array.isArray(node.specifiers)
			) {
				const source = getStaticString(node.source);
				if (!source) return;
				for (const item of node.specifiers as SyntaxNode[]) {
					declarePattern(item.local, scope, {
						importValue: (seen) => {
							const imported = resolveImport(source);
							if (item.type === "ImportNamespaceSpecifier")
								return { role: imported, isDefined: () => true };
							return loaderPropertyValue(
								imported,
								item.type === "ImportDefaultSpecifier"
									? "default"
									: exportName(item.imported),
								seen,
							);
						},
					});
				}
			}
		},
	);
	const lookup = (value: SyntaxNode) =>
		lookupLexicalBinding(scopes, value);
	const isUnbound = (value: unknown): boolean =>
		isSyntaxNode(value) &&
		value.type === "Identifier" &&
		!lookup(value);
	const sameBinding = (a: unknown, b: unknown): boolean =>
		isSyntaxNode(a) &&
		isSyntaxNode(b) &&
		a.type === "Identifier" &&
		isIdentifier(b, String(a.name)) &&
		lookup(a) === lookup(b);
	// Full minification can emit a single-init let in place of const.
	// Keep lexical identity and reject any later write to that binding.
	let writtenBindings: Set<Binding> | undefined;
	const isStableBinding = (value: SyntaxNode): boolean => {
		const binding = lookup(value);
		if (!binding) return false;
		if (!writtenBindings) {
			const writes = new Set<Binding>();
			const initializers = new Set<Binding>();
			const mark = (
				target: unknown,
				initialize: boolean,
			): void => {
				if (!isSyntaxNode(target)) return;
				switch (target.type) {
					case "Identifier": {
						const entry = lookup(target);
						if (!entry) return;
						if (!initialize || initializers.has(entry))
							writes.add(entry);
						else initializers.add(entry);
						return;
					}
					case "ArrayPattern":
						for (const element of target.elements as unknown[])
							mark(element, initialize);
						return;
					case "ObjectPattern":
						for (const property of target.properties as SyntaxNode[])
							mark(
								property.type === "RestElement"
									? property.argument
									: property.value,
								initialize,
							);
						return;
					case "AssignmentPattern":
						mark(target.left, initialize);
						return;
					case "RestElement":
						mark(target.argument, initialize);
				}
			};
			visitSyntax(program, (node, ancestors) => {
				if (node.type === "AssignmentExpression")
					mark(node.left, false);
				else if (node.type === "UpdateExpression")
					mark(node.argument, false);
				else if (
					node.type === "ForInStatement" ||
					node.type === "ForOfStatement"
				)
					mark(node.left, false);
				else if (node.type === "VariableDeclarator") {
					const declaration = ancestors.at(-2);
					const repeated =
						declaration?.type === "ForInStatement" ||
						declaration?.type === "ForOfStatement";
					if (node.init || repeated) mark(node.id, !repeated);
				}
			});
			writtenBindings = writes;
		}
		return !writtenBindings.has(binding);
	};
	let escapedRestBindings: Set<Binding> | undefined;
	const restMayChange = (binding: Binding): boolean => {
		if (!escapedRestBindings) {
			const escaped = new Set<Binding>();
			visitSyntax(program, (node, ancestors) => {
				if (node.type !== "Identifier") return;
				const entry = lookup(node);
				if (!entry?.restExcludes) return;
				const parent = ancestors.at(-1);
				if (!parent) return;
				if (
					parent.type === "RestElement" &&
					parent.argument === node
				) {
					if (
						ancestors.some(
							(ancestor) =>
								ancestor.type === "ExportNamedDeclaration",
						)
					)
						escaped.add(entry);
					return;
				}
				if (
					(parent.type === "Property" &&
						parent.key === node &&
						parent.value !== node &&
						!parent.computed) ||
					(parent.type === "MemberExpression" &&
						parent.property === node &&
						!parent.computed)
				)
					return;
				if (
					(parent.type === "VariableDeclarator" &&
						parent.init === node &&
						isSyntaxNode(parent.id) &&
						parent.id.type === "ObjectPattern") ||
					(parent.type === "AssignmentPattern" &&
						parent.right === node &&
						isSyntaxNode(parent.left) &&
						parent.left.type === "ObjectPattern")
				)
					return;
				if (
					parent.type === "MemberExpression" &&
					parent.object === node
				) {
					const observed = !ancestors.some((ancestor, index) => {
						const child = ancestors[index + 1] ?? node;
						return (
							([
								"AssignmentExpression",
								"ForInStatement",
								"ForOfStatement",
							].includes(ancestor.type) &&
								ancestor.left === child) ||
							((ancestor.type === "UpdateExpression" ||
								(ancestor.type === "UnaryExpression" &&
									ancestor.operator === "delete")) &&
								ancestor.argument === child) ||
							(ancestor.type === "CallExpression" &&
								ancestor.callee === child) ||
							(ancestor.type === "TaggedTemplateExpression" &&
								ancestor.tag === child)
						);
					});
					if (observed) return;
				}
				escaped.add(entry);
			});
			escapedRestBindings = escaped;
		}
		return escapedRestBindings.has(binding);
	};
	const roleOf = (
		value: unknown,
		seen = new Set<unknown>(),
	): LoaderRole | undefined => {
		if (!isSyntaxNode(value) || seen.has(value))
			return undefined;
		seen.add(value);
		if (
			value.type === "MetaProperty" &&
			isIdentifier(value.meta, "import") &&
			isIdentifier(value.property, "meta")
		)
			return "meta";
		if (value.type === "ImportExpression")
			return resolveImport(
				getStaticString(value.source) ?? "",
				true,
			);
		if (value.type === "AwaitExpression")
			return roleOf(value.argument, seen);
		if (
			value.type === "SequenceExpression" &&
			Array.isArray(value.expressions)
		)
			return roleOf(value.expressions.at(-1), seen);
		if (
			value.type === "AssignmentExpression" &&
			value.operator === "=" &&
			roleOf(value.right, seen) === "process"
		)
			return "process";
		if (
			value.type === "Identifier" &&
			typeof value.name === "string"
		) {
			const binding = lookup(value);
			if (binding) {
				const read = (
					record: Binding,
				): LoaderRole | undefined => {
					if (
						record.previous &&
						record.declaration &&
						record.declaration.id !== value
					) {
						let frame = scopes.get(value);
						while (frame && !frame.varScope)
							frame = frame.parent;
						const sameFrame = frame === record.bodyScope;
						if (
							sameFrame &&
							Number(value.start) <
								Number(record.declaration.end)
						)
							return read(record.previous);
						// A nested function or conditional initializer can still observe the parameter.
						if (!sameFrame || !record.direct) {
							const previous = read(record.previous);
							if (
								previous === "process" ||
								previous === "require"
							)
								return previous;
						}
					}
					const role =
						record.importValue?.(seen)?.role ??
						record.role ??
						roleOf(record.value, new Set(seen));
					if (record.restExcludes) {
						if (typeof role !== "object") return undefined;
						const excluded = record.restExcludes;
						const copies = (record.restNamespaces ??=
							new WeakMap());
						let copy = copies.get(role);
						if (!copy) {
							copy = {
								exportNames: (seen) => {
									const names = role.exportNames(seen);
									for (const name of excluded)
										names.delete(name);
									return names;
								},
								resolve: (name, path) => {
									if (excluded.has(name)) return undefined;
									const selected = role.resolve(name, path);
									if (selected && restMayChange(record))
										return {
											...selected,
											isDefined: undefined,
											mutableCopy: true,
										};
									return selected;
								},
							};
							copies.set(role, copy);
						}
						return copy;
					}
					if (record.property === undefined) return role;
					const selected = loaderPropertyValue(
						role,
						record.property,
						seen,
					);
					if (selected?.role && !selected.mutableCopy)
						return selected.role;
					// An ordinary defined value does not take the initializer.
					const fallback = roleOf(
						record.fallback,
						new Set(seen),
					);
					if (
						fallback &&
						selected?.role &&
						selected.role !== fallback &&
						(typeof selected.role !== "object" ||
							namespaceExposesLoader(selected.role))
					)
						throw new Error(
							"Cannot determine a runtime loader from a mutable namespace copy with a different loader default.",
						);
					return fallback && !selected?.isDefined?.()
						? fallback
						: selected?.role;
				};
				return read(binding);
			}
			if (value.name === "process") return "process";
		}
		if (value.type === "MemberExpression") {
			const role = roleOf(value.object, seen);
			const property = value.computed
				? getStaticString(value.property)
				: isSyntaxNode(value.property) &&
					  value.property.type === "Identifier"
					? value.property.name
					: undefined;
			if (
				property === "process" &&
				isIdentifier(value.object, "globalThis") &&
				isUnbound(value.object)
			)
				return "process";
			if (
				!value.computed ||
				role === "process" ||
				role === "meta" ||
				role === "require" ||
				typeof role === "object"
			) {
				const selected = loaderPropertyRole(
					role,
					property,
					seen,
				);
				if (selected) return selected;
			}
		}
		if (value.type === "CallExpression") {
			const role = roleOf(value.callee, seen);
			if (role === "factory") return "require";
			if (
				Array.isArray(value.arguments) &&
				(role === "require" ||
					(role === "builtin" && value.arguments.length === 1))
			) {
				const specifier = getStaticString(value.arguments[0]);
				if (
					role === "require" &&
					specifier &&
					isCommonJsRelativeSpecifier(specifier)
				)
					return resolveRequire(specifier, seen);
				return builtinModuleRole(specifier);
			}
		}

		if (
			value.type === "ConditionalExpression" &&
			[value.consequent, value.alternate].some(
				(branch) => roleOf(branch, new Set(seen)) === "process",
			)
		)
			return "process";

		if (
			value.type === "LogicalExpression" &&
			(roleOf(value.right, new Set(seen)) === "process" ||
				(value.operator !== "&&" &&
					roleOf(value.left, seen) === "process"))
		)
			return "process";
		return undefined;
	};
	const isDefinitelyDefined = (
		value: unknown,
		seen: Set<unknown>,
	): boolean => {
		if (!isSyntaxNode(value) || seen.has(value)) return false;
		const path = new Set(seen).add(value);
		if (
			[
				"Literal",
				"TemplateLiteral",
				"ObjectExpression",
				"ArrayExpression",
				"ArrowFunctionExpression",
				"FunctionExpression",
				"ClassExpression",
			].includes(value.type)
		)
			return true;
		if (value.type !== "Identifier") return false;
		const binding = lookup(value);
		if (!binding || path.has(binding) || !isStableBinding(value))
			return false;
		path.add(binding);
		if (binding.importValue)
			return binding.importValue(path)?.isDefined?.() === true;
		return Boolean(
			binding.lexicalInitializer &&
			binding.property === undefined &&
			!binding.restExcludes &&
			isDefinitelyDefined(binding.value, path),
		);
	};
	return {
		bindingRole: roleOf,
		bindingValue(value, seen) {
			const origin =
				isSyntaxNode(value) && value.type === "Identifier"
					? lookup(value)
					: undefined;
			const imported = origin?.importValue?.(new Set(seen));
			if (imported === ambiguousExport || imported?.origin)
				return imported;
			const role = roleOf(value, new Set(seen));
			return role
				? { role, origin }
				: {
						origin,
						isDefined: () => isDefinitelyDefined(value, seen),
					};
		},
		isUnbound,
		sameBinding,
		isStableBinding,
	};
}
