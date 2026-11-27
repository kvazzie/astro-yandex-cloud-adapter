import type { Stats } from "node:fs";
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import {
  basename,
  dirname,
  extname,
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
  const emittedName = (() => {
    const contents = planned.get(join(server, "package.json"))?.contents;
    if (contents === undefined) return undefined;
    try {
      const { name } = JSON.parse(contents.replace(/^\uFEFF/, "")) as {
        name?: unknown;
      };
      return typeof name === "string" ? name : undefined;
    } catch {
      return undefined;
    }
  })();
  // Emitted imports name the packages, as aliases and symlinks hide them in paths.
  // An import nft cannot resolve still names a package the artifact needs.
  const imports: { name: string; parent: string }[] = [];
  // Module loads go through resolve; assets read through new URL() do not.
  const moduleEdges = new Map<string, Set<string>>();
  const esmTargets = new Set<string>();
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
      const name = barePackageName(specifier);
      const record = name !== undefined && inServer(parent);
      let resolved: Awaited<ReturnType<typeof resolve>>;
      try {
        resolved = await resolve(specifier, parent, job, cjsResolve);
      } catch (cause) {
        // An import nft cannot resolve still names a package the artifact needs.
        if (record && name) imports.push({ name, parent });
        throw cause;
      }
      // Only a self-reference of the emitted package, which keeps its name and exports,
      // names no dependency; a linked external package can also resolve inside.
      if (
        record &&
        name &&
        !(name === emittedName && [resolved].flat().every(inServer))
      )
        imports.push({ name, parent });
      // Publish the parent's edge set before any await, so sibling resolutions
      // of the same parent add to it instead of replacing it.
      let targets = moduleEdges.get(parent);
      if (!targets) moduleEdges.set(parent, (targets = new Set<string>()));
      for (const target of [resolved].flat()) {
        targets.add(target);
        if (!cjsResolve) esmTargets.add(target);
        // nft resolves a package that an imports map selects without calling this
        // hook again and returns its canonical path, so name the binding that
        // Node's lookup from the importing file reaches it through.
        if (specifier.startsWith("#") && inServer(parent) && !inServer(target))
          for (const name of await installedBindings(target, parent))
            imports.push({ name, parent });
      }
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
  // On Windows nft keeps a path on another drive than its base absolute.
  const absolute = (path: string) => (isAbsolute(path) ? path : join(root, path));
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
  // Node selects the format of an imported extensionless file from its package
  // scope, as for .js files, but nft emits that package.json only for .js files.
  const imported = new Set(await Promise.all([...esmTargets].map(canonical)));
  for (const path of modules) {
    if (extname(path) !== "" || !imported.has(path) || !traced.has(path)) continue;
    const manifest = await packageScope(path);
    if (manifest === undefined || inServer(manifest)) continue;
    traced.add(manifest);
    parentsOf.set(manifest, [...(parentsOf.get(manifest) ?? []), path]);
  }
  const packages = new Set(
    imports.filter(({ parent }) => modules.has(parent)).map(({ name }) => name),
  );
  return { packages, files: traced, parents: parentsOf };
}

/** Finds the package.json that Node's package scope lookup selects for a file. */
async function packageScope(path: string): Promise<string | undefined> {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (basename(directory) === "node_modules") return undefined;
    const manifest = join(directory, "package.json");
    const stats = await stat(manifest).catch((cause: unknown) => {
      if (missing(cause)) return undefined;
      throw cause;
    });
    if (stats?.isFile()) return manifest;
    if (dirname(directory) === directory) return undefined;
  }
}

/** Lists the node_modules bindings, nearest first, that resolve to a package path. */
async function installedBindings(
  target: string,
  parent: string,
): Promise<string[]> {
  const parts = target.split(sep);
  const index = parts.lastIndexOf("node_modules");
  if (index === -1) return [];
  const scoped = parts[index + 1]?.startsWith("@");
  const root = parts.slice(0, index + (scoped ? 3 : 2)).join(sep);
  for (const directory of createRequire(parent).resolve.paths("x") ?? []) {
    const names = await installedNames(directory);
    const matches: string[] = [];
    for (const name of names)
      if ((await realpath(join(directory, name)).catch(() => "")) === root)
        matches.push(name);
    if (matches.length) return matches;
  }
  return [parts.slice(index + 1, index + (scoped ? 3 : 2)).join("/")];
}

async function installedNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.startsWith("@")) names.push(entry);
    else
      for (const scoped of await readdir(join(directory, entry)).catch(() => []))
        names.push(`${entry}/${scoped}`);
  }
  return names;
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
