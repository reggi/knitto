import { createHash } from "node:crypto";

const REPOSITORY_ASSET_DIRECTORY = ".knitto-repository-assets";

export function repositoryAssetPath(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex");
  return `${REPOSITORY_ASSET_DIRECTORY}/${digest}`;
}

export function repositoryAssetDirectory(): string {
  return REPOSITORY_ASSET_DIRECTORY;
}
