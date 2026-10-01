import { isBuiltin } from "node:module";
import { basename, join, relative } from "node:path";
import { readFile } from "node:fs/promises";

import { parse } from "acorn";
import { glob } from "tinyglobby";

import { defaults } from "../defaults.js";
import { compareNames } from "../install-lockfile.js";
import type { DependencyStrategy } from "../types.js";

export async function findRuntimePackageImports(
  directoryPath: DirectoryPath,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Promise<Set<string>> {
  const dependencyNames = new Set<string>();
  for (const absolutePath of await listFunctionScriptPaths(
    directoryPath,
    strategy,
  )) {
    const moduleSource = await readFile(absolutePath, "utf8");
    const relativePath = relative(directoryPath, absolutePath);
    for (const dependencyName of findImportedPackageNames(
      moduleSource,
      relativePath,
      strategy,
    ))
      dependencyNames.add(dependencyName);
  }
  return dependencyNames;
}

async function listFunctionScriptPaths(
  directoryPath: DirectoryPath,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Promise<string[]> {
  const relativePaths = await emittedRelativePaths(directoryPath);
  const fileNames = relativePaths.map((relativePath) => basename(relativePath));
  const hasNativeModule = fileNames.some((fileName) => fileName.endsWith(".node"));
  if (hasNativeModule && strategy === "bundle") {
    throw new Error(
      'The Function Artifact contains a native runtime module, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.',
    );
  }
  const hasCommonJsModule = fileNames.some((fileName) =>
    fileName.endsWith(".cjs"),
  );
  if (hasCommonJsModule) {
    throw new Error(
      "The function artifact contains an unsupported CommonJS module. V1 function artifacts must use ESM.",
    );
  }
  return relativePaths
    .filter((relativePath) => /\.m?js$/.test(basename(relativePath)))
    .map((relativePath) => join(directoryPath, relativePath));
}

declare const directoryPathBrand: unique symbol;

export type DirectoryPath = string & {
  readonly [directoryPathBrand]: "DirectoryPath";
};

export function asDirectoryPath(path: string): DirectoryPath {
  return path as DirectoryPath;
}

async function emittedRelativePaths(
  directoryPath: DirectoryPath,
): Promise<string[]> {
  const paths = await glob(["**/*"], {
    cwd: directoryPath,
    dot: true,
    onlyFiles: true,
  });
  return paths.sort(compareNames);
}

function findImportedPackageNames(
  moduleSource: string,
  relativePath: string,
  strategy: DependencyStrategy = defaults.STRATEGY,
): Set<string> {
  const dependencyNames = new Set<string>();
  const program = parse(moduleSource, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as SyntaxNode;

  const collectPackageImport = (importSpecifier: string): void => {
    if (importSpecifier.endsWith(".node") && strategy === "bundle") {
      throw new Error(
        `The Function Artifact contains the native runtime module ${importSpecifier} referenced by ${relativePath}, which cannot use the "bundle" dependency strategy. It requires dependencyStrategy: "install", which keeps runtime package imports with exact package metadata and a lockfile.`,
      );
    }
    // Native file imports stay inside the owning package for install builds,
    // so the package itself is pinned; bundle builds cannot carry native code.
    if (!isBareImportSpecifier(importSpecifier)) return;
    dependencyNames.add(packageNameFromSpecifier(importSpecifier));
  };
  const rejectDynamicImport = (): never => {
    if (strategy === "install") {
      throw new Error(
        `The Function Artifact contains unresolved dynamic runtime dependency resolution in ${relativePath}, which cannot use the "install" dependency strategy. Replace it with a fixed package import so its exact version can be written to the Function Artifact.`,
      );
    }
    throw new Error(
      `The Function Artifact contains unresolved dynamic or native runtime dependency resolution in ${relativePath}, which cannot use the "bundle" dependency strategy. Bundle a fixed package import or select dependencyStrategy: "install" to keep runtime package imports.`,
    );
  };
  visitSyntax(program, (node, ancestors) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration": {
        const importSpecifier = getStaticString(node.source);
        if (importSpecifier) collectPackageImport(importSpecifier);
        return;
      }
      case "ImportExpression": {
        const importSpecifier = getStaticString(node.source);
        if (importSpecifier) {
          collectPackageImport(importSpecifier);
        } else if (!isAstroLoggerImport(node.source, relativePath, ancestors)) {
          rejectDynamicImport();
        }
        return;
      }
      case "CallExpression": {
        const callee = node.callee;
        if (
          !isSyntaxNode(callee) ||
          callee.type !== "Identifier" ||
          (callee.name !== "require" && callee.name !== "__require")
        ) {
          return;
        }
        const arguments_ = node.arguments;
        const requireArgument: unknown = Array.isArray(arguments_)
          ? arguments_[0]
          : undefined;
        collectPackageImport(
          getStaticString(requireArgument) ?? rejectDynamicImport(),
        );
        return;
      }
      default: {
        return;
      }
    }
  });
  return dependencyNames;
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
    importSpecifier.startsWith("file:")
  ) {
    return false;
  }
  return !isBuiltin(importSpecifier);
}

function packageNameFromSpecifier(bareSpecifier: BareImportSpecifier): string {
  if (bareSpecifier.startsWith("@")) {
    return bareSpecifier.split("/").slice(0, 2).join("/");
  }
  const slashIndex = bareSpecifier.indexOf("/");
  return slashIndex === -1 ? bareSpecifier : bareSpecifier.slice(0, slashIndex);
}

function getStaticString(value: unknown): string | undefined {
  if (!isSyntaxNode(value)) return undefined;
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type !== "TemplateLiteral") return undefined;
  const expressions = value.expressions;
  const quasis = value.quasis;
  if (
    !Array.isArray(expressions) ||
    expressions.length ||
    !Array.isArray(quasis)
  ) {
    return undefined;
  }
  const first: unknown = (quasis as unknown[])[0];
  if (!isSyntaxNode(first)) return undefined;
  const templateValue = first.value;
  if (typeof templateValue !== "object" || templateValue === null) {
    return undefined;
  }
  const cooked = "cooked" in templateValue ? templateValue.cooked : undefined;
  return typeof cooked === "string" ? cooked : undefined;
}

function isAstroLoggerImport(
  sourceNode: unknown,
  relativePath: string,
  ancestors: SyntaxNode[],
): boolean {
  if (
    relativePath !== "index.js" &&
    !/(^|[\\/])chunks[\\/]render-[^\\/]+\.js$/.test(relativePath)
  ) {
    return false;
  }
  if (
    !ancestors.some(
      (ancestor) =>
        ancestor.type === "FunctionDeclaration" &&
        isIdentifier(ancestor.id, "loadLoggerDestination"),
    )
  ) {
    return false;
  }
  if (isIdentifier(sourceNode, "entrypoint")) return true;
  if (!isSyntaxNode(sourceNode) || sourceNode.type !== "CallExpression")
    return false;
  if (!isIdentifier(sourceNode.callee, "normalizeEntrypoint")) return false;
  const arguments_ = sourceNode.arguments;
  const entrypointArgument: unknown = Array.isArray(arguments_)
    ? arguments_[0]
    : undefined;
  return (
    isSyntaxNode(entrypointArgument) &&
    entrypointArgument.type === "MemberExpression" &&
    isIdentifier(entrypointArgument.object, "loggerConfig") &&
    isIdentifier(entrypointArgument.property, "entrypoint")
  );
}

function isIdentifier(value: unknown, name: string): boolean {
  return isSyntaxNode(value) && value.type === "Identifier" && value.name === name;
}

interface SyntaxNode {
  type: string;
  [property: string]: unknown;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function visitSyntax(
  node: SyntaxNode,
  visitor: (node: SyntaxNode, ancestors: SyntaxNode[]) => void,
  ancestors: SyntaxNode[] = [],
): void {
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (isSyntaxNode(value)) visitSyntax(value, visitor, nextAncestors);
    else if (Array.isArray(value)) {
      for (const child of value) {
        if (isSyntaxNode(child)) visitSyntax(child, visitor, nextAncestors);
      }
    }
  }
}
