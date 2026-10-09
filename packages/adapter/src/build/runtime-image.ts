import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { IntegrationResolvedRoute } from "astro";
import { glob } from "tinyglobby";

import {
  isSyntaxNode,
  localModuleReferences,
  parseModule,
  visitSyntax,
  type SyntaxNode,
} from "../function/emitted-modules.js";

/** Finds image calls reachable from runtime routes, excluding registered-only endpoints. */
export async function hasRuntimeImageCalls(
  directory: URL,
  routes: readonly IntegrationResolvedRoute[],
): Promise<boolean> {
  const components = new Set(
    routes
      .filter(
        (route) =>
          !route.isPrerendered &&
          (route.origin !== "internal" || route.pattern.startsWith("/_actions/")),
      )
      .map((route) => route.entrypoint),
  );
  const modules = new Map<
    string,
    { source: string; syntax: SyntaxNode; declarations: Map<string, SyntaxNode> }
  >();
  for (const file of await glob(["**/*.js", "**/*.mjs"], {
    cwd: fileURLToPath(directory),
    onlyFiles: true,
  })) {
    const source = await readFile(new URL(file, directory), "utf8");
    const syntax = parseModule(source);
    const declarations = new Map<string, SyntaxNode>();
    visitSyntax(syntax, (node) => {
      if (
        node.type === "VariableDeclarator" &&
        isSyntaxNode(node.id) &&
        typeof node.id.name === "string"
      )
        declarations.set(node.id.name, node);
    });
    modules.set(new URL(file, directory).href, { source, syntax, declarations });
  }

  const mapModules = new Set<string>();
  const pending: string[] = [];
  for (const [url, { declarations }] of modules) {
    for (const [name, declaration] of declarations) {
      if (!/^(?:pageMap|serverIslandMap)(?:\$\d+)?$/.test(name)) continue;
      mapModules.add(url);
      const init = declaration.init;
      if (!isSyntaxNode(init) || !Array.isArray(init.arguments)) continue;
      const entries: unknown = init.arguments[0];
      if (!isSyntaxNode(entries) || !Array.isArray(entries.elements)) continue;
      for (const entry of entries.elements as unknown[]) {
        if (!isSyntaxNode(entry) || !Array.isArray(entry.elements)) continue;
        const [component, loader] = entry.elements as unknown[];
        if (!isSyntaxNode(component) || !isSyntaxNode(loader)) continue;
        if (
          name.startsWith("pageMap") &&
          (typeof component.value !== "string" || !components.has(component.value))
        )
          continue;
        const selected =
          loader.type === "Identifier" && typeof loader.name === "string"
            ? declarations.get(loader.name)?.init
            : loader;
        if (!isSyntaxNode(selected)) continue;
        visitSyntax(selected, (node) => {
          if (
            node.type === "ImportExpression" &&
            isSyntaxNode(node.source) &&
            typeof node.source.value === "string" &&
            node.source.value.startsWith(".")
          )
            pending.push(new URL(node.source.value, url).href);
        });
      }
    }
  }

  const visited = new Set<string>();
  while (pending.length) {
    const url = pending.pop()!;
    if (visited.has(url) || mapModules.has(url)) continue;
    visited.add(url);
    const module = modules.get(url);
    if (!module) continue;
    let imageCall = false;
    visitSyntax(module.syntax, (node) => {
      if (
        node.type === "CallExpression" &&
        isSyntaxNode(node.callee) &&
        node.callee.type === "Identifier" &&
        typeof node.callee.name === "string" &&
        /^getImage(?:\$\d+)?$/.test(node.callee.name)
      )
        imageCall = true;
    });
    if (imageCall) return true;
    pending.push(
      ...localModuleReferences(module.source).map(
        (reference) => new URL(reference, url).href,
      ),
    );
  }
  return false;
}
