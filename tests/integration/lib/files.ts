import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Captures every regular file's relative path and bytes using the filesystem's
 * recursive listing. It supplies test inputs without using an uploader's traversal.
 */
export async function readDirectorySnapshot(
  directory: string,
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const path of await readdir(directory, { recursive: true })) {
    const file = join(directory, path);
    if ((await stat(file)).isFile()) {
      files.push({
        path: path.replaceAll("\\", "/"),
        bytes: await readFile(file),
      });
    }
  }
  return files;
}
