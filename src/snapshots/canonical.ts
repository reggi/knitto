import { createHash } from "node:crypto";
import path from "node:path";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { KnittoError } from "../errors.js";
import type { SnapshotProvenance } from "../types.js";
import { loadTemplateManifest } from "../template/manifest.js";

interface CanonicalEntry {
  path: string;
  mode: number;
  contents: Buffer;
}

async function collectEntries(
  root: string,
  directory = root,
): Promise<CanonicalEntry[]> {
  const entries: CanonicalEntry[] = [];
  const children = await readdir(directory, { withFileTypes: true });

  for (const child of children) {
    if (child.name === ".git") continue;

    const absolute = path.join(directory, child.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);

    if (metadata.isSymbolicLink()) {
      throw new KnittoError(
        `Template snapshots cannot contain symlinks: ${relative}`,
        "TEMPLATE",
      );
    }

    if (metadata.isDirectory()) {
      entries.push(...(await collectEntries(root, absolute)));
      continue;
    }

    if (!metadata.isFile()) {
      throw new KnittoError(
        `Unsupported template entry: ${relative}`,
        "TEMPLATE",
      );
    }

    entries.push({
      path: relative,
      mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      contents: await readFile(absolute),
    });
  }

  return entries;
}

function frame(value: string | Buffer): Buffer {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([Buffer.from(`${buffer.length}:`), buffer]);
}

export async function digestDirectory(root: string): Promise<string> {
  let metadata;
  try {
    metadata = await stat(root);
  } catch (error) {
    throw new KnittoError(
      `Template directory does not exist: ${root}`,
      "SOURCE",
      { cause: error },
    );
  }

  if (!metadata.isDirectory()) {
    throw new KnittoError(`Template source is not a directory: ${root}`, "SOURCE");
  }

  const entries = await collectEntries(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(frame(entry.path));
    hash.update(frame(entry.mode.toString(8)));
    hash.update(frame(entry.contents));
  }

  return `sha256:${hash.digest("hex")}`;
}

export function cacheRoot(): string {
  const configured = process.env.XDG_CACHE_HOME;
  const base = configured
    ? path.resolve(configured)
    : path.join(process.env.HOME ?? process.cwd(), ".cache");
  return path.join(base, "knitto", "snapshots");
}

export function cachePath(digest: string): string {
  const value = digest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new KnittoError(`Invalid snapshot digest: ${digest}`, "CONFIG");
  }
  return path.join(cacheRoot(), value);
}

export async function cacheSnapshot(
  sourceDirectory: string,
  digest: string,
): Promise<string> {
  const destination = cachePath(digest);
  try {
    const metadata = await stat(destination);
    if (metadata.isDirectory()) {
      const actualDigest = await digestDirectory(destination);
      if (actualDigest !== digest) {
        throw new KnittoError(
          `Cached snapshot is corrupt: expected ${digest}, found ${actualDigest}`,
          "SOURCE",
        );
      }
      return destination;
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;

  try {
    await cp(sourceDirectory, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } catch (error) {
    try {
      const metadata = await stat(destination);
      if (!metadata.isDirectory()) throw error;
    } catch {
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return destination;
}

export async function loadCachedSnapshot(
  digest: string,
  provenance: SnapshotProvenance,
) {
  const directory = cachePath(digest);
  try {
    await stat(directory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  try {
    const actualDigest = await digestDirectory(directory);
    if (actualDigest !== digest) {
      throw new KnittoError(
        `Cached snapshot is corrupt: expected ${digest}, found ${actualDigest}`,
        "SOURCE",
      );
    }
    return {
      digest,
      directory,
      manifest: await loadTemplateManifest(directory),
      provenance,
    };
  } catch (error) {
    throw new KnittoError(`Unable to load cached snapshot: ${digest}`, "SOURCE", {
      cause: error,
    });
  }
}
