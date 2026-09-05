import { createHash } from "node:crypto";
import path from "node:path";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { KnittoError } from "../errors.js";
import { assertNoEscapingSymlink, resolveInside } from "../filesystem/paths.js";
import type { ReconciliationPlan } from "../types.js";

function digest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function pruneEmptyParents(file: string, projectRoot: string): Promise<void> {
  let directory = path.dirname(file);
  while (directory !== projectRoot) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOTEMPTY" ||
          error.code === "EEXIST" ||
          error.code === "ENOENT")
      ) {
        return;
      }
      throw error;
    }
    directory = path.dirname(directory);
  }
}

async function writeAtomically(
  destination: string,
  contents: string,
  mode?: number,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.knitto-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, contents, {
      ...(mode !== undefined ? { mode } : {}),
    });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyPlan(plan: ReconciliationPlan): Promise<void> {
  for (const operation of plan.operations) {
    const destination = resolveInside(plan.projectRoot, operation.path);
    const current = await readFile(destination, "utf8").catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    });
    const currentDigest = current === null ? null : digest(current);
    if (currentDigest !== operation.beforeDigest) {
      throw new KnittoError(
        `Refusing to apply stale plan; ${operation.path} changed after planning`,
        "APPLY",
      );
    }
  }

  const applied: typeof plan.operations = [];
  try {
    for (const operation of plan.operations) {
      const destination = resolveInside(plan.projectRoot, operation.path);
      await assertNoEscapingSymlink(plan.projectRoot, destination);

      if (operation.type === "delete") {
        await unlink(destination);
        await pruneEmptyParents(destination, plan.projectRoot);
        applied.push(operation);
        continue;
      }

      await writeAtomically(destination, operation.after, operation.mode);
      applied.push(operation);
    }
  } catch (error) {
    try {
      for (const operation of [...applied].reverse()) {
        const destination = resolveInside(plan.projectRoot, operation.path);
        if (operation.before === null) {
          await rm(destination, { force: true });
        } else {
          await writeAtomically(destination, operation.before);
        }
      }
    } catch (rollbackError) {
      throw new KnittoError(
        "Apply failed and the previous project state could not be fully restored",
        "APPLY",
        { cause: rollbackError },
      );
    }

    throw new KnittoError("Unable to apply reconciliation plan", "APPLY", {
      cause: error,
    });
  }
}
