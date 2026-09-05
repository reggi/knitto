import path from "node:path";
import { readFile } from "node:fs/promises";
import { KnittoError } from "../errors.js";
import { renderTemplate } from "./render.js";
import {
  assertNoEscapingSymlink,
  resolveInside,
} from "../filesystem/paths.js";
import type {
  ProjectConfig,
  ProjectUnit,
  RenderContext,
  TemplateManifest,
} from "../types.js";
import { templateReleaseTag } from "../template/release.js";

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
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
}

export async function buildContext(
  unit: ProjectUnit,
  manifest: TemplateManifest,
): Promise<RenderContext> {
  const projectRoot = unit.path;
  const config: ProjectConfig = unit.config;
  const releaseTag = templateReleaseTag(manifest.release);
  const inputPaths = new Set([
    ...(manifest.inputs ?? []),
    ...manifest.rules
      .map((rule) => rule.destination)
      .filter((destination) => !destination.includes("{{")),
  ]);
  const files: RenderContext["files"] = {};

  for (const relativePath of [...inputPaths].sort()) {
    const destination = resolveInside(projectRoot, relativePath);
    await assertNoEscapingSymlink(projectRoot, destination);
    const text = await readOptional(destination);
    if (text === null) continue;

    const entry: RenderContext["files"][string] = { text };
    if (relativePath.endsWith(".json")) {
      try {
        entry.json = JSON.parse(text) as unknown;
      } catch (error) {
        throw new KnittoError(
          `Unable to parse project JSON input: ${relativePath}`,
          "TEMPLATE",
          { cause: error },
        );
      }
    }
    files[relativePath] = entry;
  }

  const defaults = manifest.variables ?? {};
  const configured = config.variables ?? {};
  const promptedVariables = new Set(
    (manifest.prompts ?? [])
      .map((prompt) => prompt.path)
      .filter((promptPath) => promptPath.startsWith("variables."))
      .map((promptPath) => promptPath.slice("variables.".length)),
  );
  for (const prompt of manifest.prompts ?? []) {
    if (prompt.when) {
      const enabled = renderTemplate(
        prompt.when,
        {
          project: {
            path: projectRoot,
            name: path.basename(projectRoot),
          },
          files,
          metadata: config.metadata ?? {},
          variables: {
            ...defaults,
            ...configured,
          },
          pkg: unit.packageJson,
          derived: {},
        },
        `${prompt.path}.when`,
      )
        .trim()
        .toLowerCase();
      if (enabled === "" || enabled === "false" || enabled === "0") continue;
    }
    const [section, name] = prompt.path.split(".", 2) as [
      "metadata" | "variables",
      string,
    ];
    const values = section === "metadata" ? config.metadata : configured;
    if (prompt.required && !(name in (values ?? {}))) {
      throw new KnittoError(
        `Template input ${prompt.path} is required; run knitto plan interactively or pass --set ${prompt.path}=value`,
        "CONFIG",
      );
    }
  }
  for (const name of Object.keys(configured)) {
    if (!(name in defaults) && !promptedVariables.has(name)) {
      throw new KnittoError(
        `Project config sets unknown template variable: ${name}`,
        "CONFIG",
      );
    }
  }

  return {
    template: {
      name: manifest.name,
      ...(manifest.engine ? { engine: manifest.engine } : {}),
      ...(manifest.release
        ? {
            release: {
              provider: manifest.release.provider,
              version: manifest.release.version,
              ...(releaseTag ? { tag: releaseTag } : {}),
            },
          }
        : {}),
    },
    project: {
      path: projectRoot,
      name: path.basename(projectRoot),
    },
    files,
    metadata: config.metadata ?? {},
    variables: {
      ...defaults,
      ...configured,
    },
    pkg: unit.packageJson,
    derived: {
      isRoot: unit.isRoot,
      isWorkspace: !unit.isRoot,
      isMono: unit.workspacePaths.length > 0,
      isRootMono: unit.isRoot && unit.workspacePaths.length > 0,
      repoDir: unit.repositoryRoot,
      moduleDir: unit.path,
      pkgPath: unit.relativePath,
      pkgDir: unit.relativePath === "." ? "" : `${unit.relativePath}/`,
      pkgName:
        typeof unit.packageJson.name === "string"
          ? unit.packageJson.name
          : path.basename(unit.path),
      pkgNameFs:
        typeof unit.packageJson.name === "string"
          ? unit.packageJson.name.replaceAll("/", "-").replaceAll("@", "")
          : path.basename(unit.path),
      workspacePaths: unit.workspacePaths,
      workspaceGlobs: unit.workspacePaths.map((workspace) => `${workspace}/**`),
      isPrivate: Boolean(unit.packageJson.private),
      isPublic: !unit.packageJson.private,
      esm:
        unit.packageJson.type === "module" ||
        Boolean((config.variables ?? {}).typescript) ||
        Boolean((config.variables ?? {}).esm),
      cjsExt:
        unit.packageJson.type === "module" ||
        Boolean((config.variables ?? {}).typescript) ||
        Boolean((config.variables ?? {}).esm)
          ? "cjs"
          : "js",
      deleteJsExt:
        unit.packageJson.type === "module" ||
        Boolean((config.variables ?? {}).typescript) ||
        Boolean((config.variables ?? {}).esm)
          ? "js"
          : "cjs",
    },
  };
}
