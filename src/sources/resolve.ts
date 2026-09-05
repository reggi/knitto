import path from "node:path";
import os from "node:os";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as tar from "tar";
import { KnittoError } from "../errors.js";
import {
  type ProjectLock,
  type Snapshot,
  type SnapshotProvenance,
  type SourceConfig,
} from "../types.js";
import {
  assertNoEscapingSymlink,
  resolveInside,
} from "../filesystem/paths.js";
import { loadTemplateManifest } from "../template/manifest.js";
import {
  cacheSnapshot,
  digestDirectory,
  loadCachedSnapshot,
} from "../snapshots/canonical.js";
import { run } from "./process.js";
import {
  repositoryAssetDirectory,
  repositoryAssetPath,
} from "../template/assets.js";

interface MaterializedSource {
  root: string;
  repositoryRoot: string;
  provenance: SnapshotProvenance;
  cleanup?: () => Promise<void>;
}

async function materializeLocal(
  source: Extract<SourceConfig, { type: "local" }>,
  projectRoot: string,
): Promise<MaterializedSource> {
  const root = path.resolve(projectRoot, source.path);
  const relative = path.relative(projectRoot, root);
  return {
    root,
    repositoryRoot:
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
        ? projectRoot
        : root,
    provenance: {
      sourceType: "local",
      locator: source.path,
    },
  };
}

async function materializeHttp(
  source: Extract<SourceConfig, { type: "http" }>,
): Promise<MaterializedSource> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "knitto-http-"));
  const archive = path.join(temporary, "template.tar");
  const extracted = path.join(temporary, "extracted");

  try {
    const response = await fetch(source.url, {
      headers: { accept: "application/gzip, application/x-tar, application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new KnittoError(
        `Template request failed with HTTP ${response.status}: ${source.url}`,
        "SOURCE",
      );
    }

    await mkdir(extracted);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await tar.x({
      file: archive,
      cwd: extracted,
      strict: true,
      preservePaths: false,
    });
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    return {
      root: source.path ? resolveInside(extracted, source.path) : extracted,
      repositoryRoot: extracted,
      provenance: {
        sourceType: "http",
        locator: source.url,
        ...(source.path ? { templatePath: source.path } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      },
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error instanceof KnittoError) throw error;
    throw new KnittoError(`Unable to resolve HTTP source: ${source.url}`, "SOURCE", {
      cause: error,
    });
  }
}

async function materializeGit(
  source: Extract<SourceConfig, { type: "git" }>,
  lockedRevision?: string,
): Promise<MaterializedSource> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "knitto-git-"));
  const checkout = path.join(temporary, "checkout");
  const requestedRef = lockedRevision ?? source.ref ?? "HEAD";

  try {
    await mkdir(checkout);
    await run("git", ["init", "--quiet"], { cwd: checkout });
    await run("git", ["remote", "add", "origin", source.url], { cwd: checkout });
    await run("git", ["fetch", "--quiet", "--depth=1", "origin", requestedRef], {
      cwd: checkout,
    });
    await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      cwd: checkout,
    });
    const revision = await run("git", ["rev-parse", "HEAD"], { cwd: checkout });

    return {
      root: source.path ? resolveInside(checkout, source.path) : checkout,
      repositoryRoot: checkout,
      provenance: {
        sourceType: "git",
        locator: source.url,
        ...(source.path ? { templatePath: source.path } : {}),
        revision,
      },
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error instanceof KnittoError) throw error;
    throw new KnittoError(`Unable to resolve Git source: ${source.url}`, "SOURCE", {
      cause: error,
    });
  }
}

async function materialize(
  source: SourceConfig,
  projectRoot: string,
  lockedRevision?: string,
): Promise<MaterializedSource> {
  switch (source.type) {
    case "local":
      return materializeLocal(source, projectRoot);
    case "http":
      return materializeHttp(source);
    case "git":
      return materializeGit(source, lockedRevision);
  }
}

async function snapshotMaterialized(
  materialized: MaterializedSource,
): Promise<Snapshot> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "knitto-snapshot-"));
  const snapshotRoot = path.join(temporary, "template");
  try {
    const manifest = await loadTemplateManifest(materialized.root);
    await cp(materialized.root, snapshotRoot, { recursive: true });
    const assetDirectory = resolveInside(
      snapshotRoot,
      repositoryAssetDirectory(),
    );
    await rm(assetDirectory, { recursive: true, force: true });
    for (const rule of manifest.rules) {
      if (rule.type !== "file" || !("source" in rule)) continue;
      const source = resolveInside(materialized.repositoryRoot, rule.source);
      await assertNoEscapingSymlink(materialized.repositoryRoot, source);
      const metadata = await stat(source).catch((error: unknown) => {
        throw new KnittoError(
          `Repository source for rule ${rule.id} does not exist: ${rule.source}`,
          "TEMPLATE",
          { cause: error },
        );
      });
      if (!metadata.isFile()) {
        throw new KnittoError(
          `Repository source for rule ${rule.id} is not a file: ${rule.source}`,
          "TEMPLATE",
        );
      }
      const destination = resolveInside(
        snapshotRoot,
        repositoryAssetPath(rule.source),
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    const digest = await digestDirectory(snapshotRoot);
    const directory = await cacheSnapshot(snapshotRoot, digest);
    return {
      digest,
      directory,
      manifest,
      provenance: materialized.provenance,
    };
  } catch (error) {
    if (error instanceof KnittoError) throw error;
    throw new KnittoError("Unable to create template snapshot", "TEMPLATE", {
      cause: error,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await materialized.cleanup?.();
  }
}

export async function resolveCurrentSnapshot(
  source: SourceConfig,
  projectRoot: string,
): Promise<Snapshot> {
  return snapshotMaterialized(await materialize(source, projectRoot));
}

export async function resolveLockedSnapshot(
  lock: ProjectLock,
  projectRoot: string,
): Promise<Snapshot> {
  const cached = await loadCachedSnapshot(lock.digest, lock.provenance);
  if (cached) return cached;

  const materialized = await materialize(
    lock.source,
    projectRoot,
    lock.provenance.revision,
  );
  const snapshot = await snapshotMaterialized(materialized);
  if (snapshot.digest !== lock.digest) {
    throw new KnittoError(
      `Locked snapshot ${lock.digest} is unavailable; source resolved to ${snapshot.digest}`,
      "SOURCE",
    );
  }
  return snapshot;
}
