import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace, resolve } from "@vercel/nft";

import {
  parseModule,
  staticModuleReference,
  visitSyntax,
} from "../../../.emittedModules.ts";
import type { PlannedFile } from "../.types.ts";

/** Runtime files and packages that the emitted server can load. */
export interface RuntimeTrace {
  /** Packages that emitted server files load directly. */
  readonly packages: ReadonlySet<string>;
  /** Absolute paths of traced files outside the server output, including symlinks. */
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
  const inServer = (path: string) => {
    const local = relative(server, path);
    return (
      local !== "" &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local)
    );
  };
  // Emitted imports name the packages, as aliases and symlinks hide them in paths.
  // An import nft cannot resolve still names a package the artifact needs.
  const imports: { name: string; parent: string }[] = [];
  const { fileList, reasons } = await nodeFileTrace(
    [...planned.keys()].filter((path) => javaScript.test(path)),
    {
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
        if (name && inServer(parent)) imports.push({ name, parent });
        return resolve(specifier, parent, job, cjsResolve);
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
    },
  );
  const absolute = (path: string) => join(root, path);
  const traced = new Set<string>();
  const parentsOf = new Map<string, readonly string[]>();
  for (const path of fileList) {
    const file = absolute(path);
    if (inServer(file)) continue;
    traced.add(file);
    const parents = [...(reasons.get(path)?.parents ?? [])].map(absolute);
    parentsOf.set(file, parents);
  }
  // Imports count only from files loaded as modules, not from assets read as text.
  const modules = await moduleFiles(planned);
  const packages = new Set(
    imports.filter(({ parent }) => modules.has(parent)).map(({ name }) => name),
  );
  return { packages, files: traced, parents: parentsOf };
}

/**
 * Follows fixed relative module edges from the emitted JavaScript files. nft
 * also analyzes files read through new URL(), which Node never runs.
 */
async function moduleFiles(
  planned: ReadonlyMap<string, PlannedFile>,
): Promise<Set<string>> {
  const pending = [...planned.keys()].filter((path) => javaScript.test(path));
  const modules = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (modules.has(path)) continue;
    modules.add(path);
    const file = planned.get(path);
    const source =
      file?.contents ??
      (file?.binaryContents === undefined
        ? await readFile(file?.from ?? path, "utf8").catch(() => undefined)
        : Buffer.from(file.binaryContents).toString("utf8"));
    if (source === undefined) continue;
    let syntax;
    try {
      syntax = parseModule(source);
    } catch {
      continue;
    }
    visitSyntax(syntax, (node) => {
      const reference = staticModuleReference(node);
      if (!reference?.startsWith(".")) return;
      let target: string;
      try {
        target = resolvePath(
          dirname(path),
          decodeURIComponent(reference.split(/[?#]/, 1)[0]!),
        );
      } catch (cause) {
        // Node cannot load an undecodable file URL either.
        if (cause instanceof URIError) return;
        throw cause;
      }
      if (planned.has(target)) pending.push(target);
    });
  }
  return modules;
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
