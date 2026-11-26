import type { Stats } from "node:fs";
import { readFile, readlink, realpath, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace, resolve } from "@vercel/nft";

import type { PlannedFile } from "../.types.ts";

/** Runtime files and packages that the emitted server can load. */
export interface RuntimeTrace {
  /** Packages that emitted server files load directly. */
  readonly packages: ReadonlySet<string>;
  /**
   * Absolute paths of traced files outside the server output, including symlinks,
   * and of server files that a file outside the server output loads.
   */
  readonly files: ReadonlySet<string>;
  /** Absolute paths of the files that load each traced file. */
  readonly parents: ReadonlyMap<string, readonly string[]>;
}

const javaScript = /\.(?:c|m)?js$/;

/**
 * Traces runtime dependencies with @vercel/nft, the community standard that
 * Astro's Vercel and Netlify adapters use. Loads that static analysis cannot
 * resolve are not discovered; see ADR 0011.
 */
export async function traceRuntimeDependencies(
  files: readonly PlannedFile[],
  serverDirectory: URL,
): Promise<RuntimeTrace> {
  // nft reports canonical paths, so compare against the canonical server directory.
  const server = await realpath(fileURLToPath(serverDirectory)).catch(
    (cause: unknown) => {
      if (missing(cause)) return fileURLToPath(serverDirectory);
      throw cause;
    },
  );
  const root = parse(server).root;
  const planned = new Map(files.map((file) => [join(server, file.path), file]));
  // Preparation replaces a planned file that is not already in place, link or not.
  const configured = fileURLToPath(serverDirectory);
  const replaced = (path: string) => {
    const file = planned.get(path);
    return (
      file !== undefined &&
      (file.from === undefined ||
        fileURLToPath(file.from) !== join(configured, file.path))
    );
  };
  // nft analyzes each file at its canonical path, so module identities use it too.
  const identities = new Map<string, Promise<string>>();
  const canonical = (path: string): Promise<string> => {
    let identity = identities.get(path);
    if (!identity) {
      identity = replaced(path)
        ? canonical(dirname(path)).then((directory) =>
            join(directory, basename(path)),
          )
        : realpath(path).catch((cause: unknown) => {
            if (missing(cause)) return path;
            throw cause;
          });
      identities.set(path, identity);
    }
    return identity;
  };
  const inServer = (path: string) => {
    const local = relative(server, path);
    return (
      local !== "" &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local)
    );
  };
  // The nearest package.json scopes an emitted module's imports map.
  const manifests = new Map<string, Promise<unknown>>();
  const nearestManifest = async (directory: string): Promise<unknown> => {
    const path = join(directory, "package.json");
    let manifest = manifests.get(path);
    if (!manifest) {
      manifest = (async () => {
        const file = planned.get(path);
        const source =
          file?.contents ??
          (await readFile(file?.from ?? path, "utf8").catch((cause: unknown) => {
            if (missing(cause)) return undefined;
            throw cause;
          }));
        if (source === undefined) return undefined;
        try {
          return JSON.parse(source.replace(/^\uFEFF/, "")) as unknown;
        } catch {
          return null;
        }
      })();
      manifests.set(path, manifest);
    }
    const found = await manifest;
    if (found !== undefined || !inServer(path)) return found;
    return nearestManifest(dirname(directory));
  };
  // Emitted imports name the packages, as aliases and symlinks hide them in paths.
  // An import nft cannot resolve still names a package the artifact needs.
  const imports: { name: string; parent: string }[] = [];
  // Module loads go through resolve; assets read through new URL() do not.
  const moduleEdges = new Map<string, Set<string>>();
  const entries = [...planned.keys()].filter((path) => javaScript.test(path));
  const { fileList, reasons } = await nodeFileTrace(entries, {
    base: root,
    // Node 22 also selects node-addons exports by default.
    conditions: ["node", "node-addons"],
    // Planned files may differ from the files on disk or not exist yet.
    readFile: async (path) => {
      const file = planned.get(path);
      if (file?.contents !== undefined) return file.contents;
      if (file?.binaryContents !== undefined)
        return Buffer.from(file.binaryContents);
      try {
        return await readFile(file?.from ?? path);
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    },
    resolve: async (specifier, parent, job, cjsResolve) => {
      // nft resolves a package that an imports map targets without calling this hook.
      const target = specifier.startsWith("#")
        ? importsTarget(
            await nearestManifest(dirname(parent)),
            specifier,
            new Set(["node", "node-addons", cjsResolve ? "require" : "import"]),
          )
        : specifier;
      const name = target === undefined ? undefined : barePackageName(target);
      if (name && inServer(parent)) imports.push({ name, parent });
      const resolved = await resolve(specifier, parent, job, cjsResolve);
      const targets = moduleEdges.get(parent) ?? new Set<string>();
      for (const target of [resolved].flat()) targets.add(target);
      moduleEdges.set(parent, targets);
      return resolved;
    },
    // A replaced file is a regular file after preparation, even where a link exists now.
    readlink: async (path) => {
      if (replaced(path)) return null;
      try {
        return await readlink(path);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code ?? "";
        if (["EINVAL", "ENOENT", "UNKNOWN"].includes(code)) return null;
        throw cause;
      }
    },
    stat: async (path) => {
      const file = planned.get(path);
      try {
        return await stat(file?.from ?? path);
      } catch (cause) {
        if (!missing(cause)) throw cause;
        return file ? plannedFileStats : null;
      }
    },
  });
  const absolute = (path: string) => join(root, path);
  const traced = new Set<string>();
  const parentsOf = new Map<string, readonly string[]>();
  for (const path of fileList) {
    const file = absolute(path);
    const parents = [...(reasons.get(path)?.parents ?? [])].map(absolute);
    // A server file loaded from outside the server output, such as by a local
    // package, still needs its edge for archive validation.
    if (inServer(file) && parents.every(inServer)) continue;
    traced.add(file);
    parentsOf.set(file, parents);
  }
  // Imports count only from files loaded as modules, not from assets read as text.
  const modules = new Set<string>();
  const pending = await Promise.all(entries.map(canonical));
  while (pending.length) {
    const path = pending.pop()!;
    if (modules.has(path)) continue;
    modules.add(path);
    pending.push(
      ...(await Promise.all([...(moduleEdges.get(path) ?? [])].map(canonical))),
    );
  }
  const packages = new Set(
    imports.filter(({ parent }) => modules.has(parent)).map(({ name }) => name),
  );
  return { packages, files: traced, parents: parentsOf };
}

/** Selects an imports map target as Node does, for exact and single-wildcard keys. */
function importsTarget(
  manifest: unknown,
  specifier: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  const map =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { imports?: unknown }).imports
      : undefined;
  if (typeof map !== "object" || map === null || Array.isArray(map))
    return undefined;
  const entries = map as Record<string, unknown>;
  if (Object.hasOwn(entries, specifier) && !specifier.includes("*"))
    return selectTarget(entries[specifier], conditions);
  // Node prefers the matching pattern with the longest prefix.
  const [key, match] =
    Object.keys(entries)
      .flatMap((key) => {
        const star = key.indexOf("*");
        if (star === -1 || key.indexOf("*", star + 1) !== -1) return [];
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        return specifier.length >= key.length &&
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix)
          ? [
              [
                key,
                specifier.slice(prefix.length, specifier.length - suffix.length),
              ] as const,
            ]
          : [];
      })
      .sort(
        ([a], [b]) => b.indexOf("*") - a.indexOf("*") || b.length - a.length,
      )[0] ?? [];
  if (key === undefined || match === undefined) return undefined;
  return selectTarget(entries[key], conditions)?.replaceAll("*", match);
}

function selectTarget(
  target: unknown,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target))
    for (const entry of target) {
      const selected = selectTarget(entry, conditions);
      if (selected !== undefined) return selected;
    }
  else if (typeof target === "object" && target !== null)
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== "default" && !conditions.has(condition)) continue;
      const selected = selectTarget(value, conditions);
      if (selected !== undefined) return selected;
    }
  return undefined;
}

/** Names the package of a bare specifier, excluding builtins, URLs and private imports. */
function barePackageName(specifier: string): string | undefined {
  // Node parses URL specifiers, including ones with leading spaces, before packages.
  if (isBuiltin(specifier) || URL.canParse(specifier) || /^[./#]/.test(specifier))
    return undefined;
  const [first, second] = specifier.split("/");
  if (!first) return undefined;
  return first.startsWith("@") ? second && `${first}/${second}` : first;
}

function missing(cause: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(
    (cause as NodeJS.ErrnoException).code ?? "",
  );
}

// nft only asks whether a planned path is a file.
const plannedFileStats = {
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
} as Stats;
