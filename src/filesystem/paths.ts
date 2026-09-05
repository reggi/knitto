import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { KnittoError } from "../errors.js";

export function resolveInside(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new KnittoError(
      `Absolute paths are not allowed: ${relativePath}`,
      "TEMPLATE",
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new KnittoError(
      `Path escapes the selected root: ${relativePath}`,
      "TEMPLATE",
    );
  }

  return resolved;
}

export async function assertNoEscapingSymlink(
  root: string,
  target: string,
): Promise<void> {
  const resolvedRoot = await realpath(root);
  let current = path.resolve(target);

  while (current.startsWith(path.resolve(root))) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        const destination = await realpath(current);
        const relative = path.relative(resolvedRoot, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new KnittoError(
            `Symlink escapes the selected root: ${target}`,
            "TEMPLATE",
          );
        }
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // Missing destination components are safe until created.
      } else {
        throw error;
      }
    }

    if (current === path.resolve(root)) {
      break;
    }
    current = path.dirname(current);
  }
}
