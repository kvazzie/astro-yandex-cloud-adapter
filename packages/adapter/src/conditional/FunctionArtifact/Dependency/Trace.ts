import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileTrace, resolve } from "@vercel/nft";

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
  const server = fileURLToPath(serverDirectory);
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
  const packages = new Set<string>();
  const { fileList, reasons } = await nodeFileTrace(
    [...planned.keys()].filter((path) => javaScript.test(path)),
    {
      base: root,
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
        if (name && inServer(parent)) packages.add(name);
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
  return { packages, files: traced, parents: parentsOf };
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
