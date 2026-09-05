import path from "node:path";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { validateProjectConfig } from "../config.js";
import { KnittoError } from "../errors.js";
import type { ProjectConfig, ProjectUnit } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageJson(directory: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    ) as unknown;
    if (!isRecord(value)) {
      throw new KnittoError(
        `package.json must contain an object: ${directory}`,
        "CONFIG",
      );
    }
    return value;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    if (error instanceof KnittoError) throw error;
    throw new KnittoError(`Unable to read package.json: ${directory}`, "CONFIG", {
      cause: error,
    });
  }
}

function workspacePatterns(packageJson: Record<string, unknown>): string[] {
  const value = packageJson.workspaces;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (isRecord(value) && Array.isArray(value.packages)) {
    return value.packages.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

function mergeConfig(
  base: ProjectConfig,
  overlayValue: unknown,
): ProjectConfig {
  if (overlayValue === undefined) return base;
  if (!isRecord(overlayValue)) {
    throw new KnittoError("package.json#knitto must be an object", "CONFIG");
  }
  const { source: _ignoredSource, ...overlayWithoutSource } = overlayValue;
  const overlay = validateProjectConfig({
    ...overlayWithoutSource,
    source: base.source,
  });

  const pointerExclusions: Record<string, string[]> = {
    ...(base.exclude?.pointers ?? {}),
  };
  for (const [ruleId, pointers] of Object.entries(
    overlay.exclude?.pointers ?? {},
  )) {
    pointerExclusions[ruleId] = [
      ...new Set([...(pointerExclusions[ruleId] ?? []), ...pointers]),
    ];
  }

  const overrides: Record<string, Record<string, unknown>> = {
    ...(base.overrides ?? {}),
  };
  for (const [ruleId, values] of Object.entries(overlay.overrides ?? {})) {
    overrides[ruleId] = {
      ...(overrides[ruleId] ?? {}),
      ...values,
    };
  }

  return {
    source: base.source,
    metadata: {
      ...(base.metadata ?? {}),
      ...(overlay.metadata ?? {}),
    },
    variables: {
      ...(base.variables ?? {}),
      ...(overlay.variables ?? {}),
    },
    exclude: {
      rules: [
        ...new Set([
          ...(base.exclude?.rules ?? []),
          ...(overlay.exclude?.rules ?? []),
        ]),
      ],
      checks: [
        ...new Set([
          ...(base.exclude?.checks ?? []),
          ...(overlay.exclude?.checks ?? []),
        ]),
      ],
      pointers: pointerExclusions,
    },
    overrides,
    ...(base.trust ? { trust: base.trust } : {}),
  };
}

export async function discoverProjectUnits(
  repositoryRoot: string,
  projectConfig: ProjectConfig,
): Promise<ProjectUnit[]> {
  const root = path.resolve(repositoryRoot);
  const rootPackage = await readPackageJson(root);
  const rootConfig = mergeConfig(projectConfig, rootPackage.knitto);
  const patterns = workspacePatterns(rootPackage);
  const workspacePackageFiles = patterns.length
    ? await glob(
        patterns.map(
          (pattern) => `${pattern.replace(/\/+$/, "")}/package.json`,
        ),
        {
        cwd: root,
        absolute: true,
        dot: false,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        },
      )
    : [];
  const workspaceDirectories = workspacePackageFiles.map((file) =>
    path.dirname(file),
  );

  const workspacePaths: string[] = [];
  const workspacePackages: Array<{
    path: string;
    relativePath: string;
    packageJson: Record<string, unknown>;
  }> = [];
  for (const directory of [...new Set(workspaceDirectories)].sort()) {
    const packageJson = await readPackageJson(directory);
    if (Object.keys(packageJson).length === 0) continue;
    const relativePath = path.relative(root, directory).split(path.sep).join("/");
    workspacePaths.push(relativePath);
    workspacePackages.push({ path: directory, relativePath, packageJson });
  }

  return [
    {
      repositoryRoot: root,
      path: root,
      relativePath: ".",
      packageJson: rootPackage,
      config: rootConfig,
      isRoot: true,
      workspacePaths,
    },
    ...workspacePackages.map((workspace) => ({
      repositoryRoot: root,
      path: workspace.path,
      relativePath: workspace.relativePath,
      packageJson: workspace.packageJson,
      config: mergeConfig(rootConfig, workspace.packageJson.knitto),
      isRoot: false,
      workspacePaths,
    })),
  ];
}
