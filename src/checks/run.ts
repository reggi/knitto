import path from "node:path";
import { readFile } from "node:fs/promises";
import { intersects, subset, validRange } from "semver";
import { KnittoError } from "../errors.js";
import { resolveInside } from "../filesystem/paths.js";
import { renderTemplate, type TemplatePartial } from "../context/render.js";
import type {
  CheckResult,
  ProjectUnit,
  RenderContext,
  TemplateCheck,
} from "../types.js";

function applies(check: TemplateCheck, isRoot: boolean): boolean {
  const scope = check.scope ?? "root";
  return scope === "all" || (scope === "root" ? isRoot : !isRoot);
}

function enabled(
  check: TemplateCheck,
  context: RenderContext,
  partials: TemplatePartial[],
): boolean {
  if (!check.when) return true;
  const result = renderTemplate(
    check.when,
    context,
    `${check.id}.when`,
    partials,
  )
    .trim()
    .toLowerCase();
  return result !== "" && result !== "false" && result !== "0";
}

function dependencySections(pkg: Record<string, unknown>) {
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((location) => {
    const value = pkg[location];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? [[location, value as Record<string, unknown>] as const]
      : [];
  });
}

function splitSpec(spec: string): { name: string; range: string } {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator === -1
      ? { name: spec, range: "*" }
      : { name: spec.slice(0, separator), range: spec.slice(separator + 1) };
  }
  const separator = spec.indexOf("@");
  return separator === -1
    ? { name: spec, range: "*" }
    : { name: spec.slice(0, separator), range: spec.slice(separator + 1) };
}

function rangeMatches(actual: unknown, required: string): boolean {
  if (typeof actual !== "string") return false;
  if (required === "*" || required === "") return true;
  const actualRange = validRange(actual);
  const requiredRange = validRange(required);
  return actualRange && requiredRange
    ? intersects(actualRange, requiredRange)
    : actual === required;
}

async function runCheck(
  check: TemplateCheck,
  unit: ProjectUnit,
  context: RenderContext,
  partials: TemplatePartial[],
): Promise<CheckResult | null> {
  if (check.type === "required-packages") {
    const missing: string[] = [];
    for (const [location, specs] of Object.entries(check.packages)) {
      const section = unit.packageJson[location];
      const packages =
        typeof section === "object" && section !== null && !Array.isArray(section)
          ? (section as Record<string, unknown>)
          : {};
      for (const raw of specs) {
        const spec = splitSpec(raw);
        if (!rangeMatches(packages[spec.name], spec.range)) missing.push(raw);
      }
    }
    if (missing.length === 0) return null;
    return {
      id: check.id,
      project: unit.relativePath,
      title: "Required packages are missing or incompatible",
      body: missing,
      solution: "Install the required packages in their configured locations.",
    };
  }

  if (check.type === "unwanted-packages") {
    const installed = new Set(
      dependencySections(unit.packageJson).flatMap(([, packages]) =>
        Object.keys(packages),
      ),
    );
    const allowed = new Set(check.allowed ?? []);
    const unwanted = check.packages.filter(
      (name) => installed.has(name) && !allowed.has(name),
    );
    if (unwanted.length === 0) return null;
    return {
      id: check.id,
      project: unit.relativePath,
      title: "Unwanted packages are installed",
      body: unwanted,
      solution: `Remove: ${unwanted.join(" ")}`,
    };
  }

  if (check.type === "file-regex") {
    const renderedPath = renderTemplate(
      check.path,
      context,
      `${check.id}.path`,
      partials,
    );
    const file = resolveInside(unit.path, renderedPath);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      throw new KnittoError(
        `Unable to read checked file: ${path.relative(unit.repositoryRoot, file)}`,
        "TEMPLATE",
        { cause: error },
      );
    }
    const matches = new RegExp(check.pattern, check.flags).test(contents);
    if (matches === (check.mustMatch ?? true)) return null;
    return {
      id: check.id,
      project: unit.relativePath,
      title: check.message ?? `${renderedPath} failed its content check`,
      body: [`Pattern: ${check.pattern}`],
      ...(check.solution ? { solution: check.solution } : {}),
    };
  }

  const projectRange =
    typeof (unit.packageJson.engines as Record<string, unknown> | undefined)
      ?.node === "string"
      ? String(
          (unit.packageJson.engines as Record<string, unknown>).node,
        )
      : null;
  if (!projectRange || !validRange(projectRange)) return null;

  const incompatible: string[] = [];
  const production = unit.packageJson.dependencies;
  if (typeof production !== "object" || production === null) return null;
  for (const name of Object.keys(production)) {
    if (check.omit?.includes(name)) continue;
    try {
      const installed = JSON.parse(
        await readFile(path.join(unit.path, "node_modules", name, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const dependencyRange =
        typeof (installed.engines as Record<string, unknown> | undefined)?.node ===
        "string"
          ? String((installed.engines as Record<string, unknown>).node)
          : null;
      if (
        dependencyRange &&
        validRange(dependencyRange) &&
        !subset(projectRange, dependencyRange)
      ) {
        incompatible.push(
          `${name}@${String(installed.version ?? "unknown")}: ${dependencyRange}`,
        );
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
  }
  if (incompatible.length === 0) return null;
  return {
    id: check.id,
    project: unit.relativePath,
    title: `Production dependencies are incompatible with engines.node ${projectRange}`,
    body: incompatible,
    solution: "Remove incompatible dependencies or move them to devDependencies.",
  };
}

export async function runChecks(
  checks: TemplateCheck[],
  unit: ProjectUnit,
  context: RenderContext,
  partials: TemplatePartial[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (!applies(check, unit.isRoot)) continue;
    if (unit.config.exclude?.checks?.includes(check.id)) continue;
    if (!enabled(check, context, partials)) continue;
    const result = await runCheck(check, unit, context, partials);
    if (result) results.push(result);
  }
  return results;
}
