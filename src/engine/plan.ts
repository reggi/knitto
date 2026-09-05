import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { glob } from "glob";
import { KnittoError } from "../errors.js";
import {
  assertNoEscapingSymlink,
  resolveInside,
} from "../filesystem/paths.js";
import { buildContext } from "../context/build.js";
import {
  renderTemplate,
  type TemplatePartial,
} from "../context/render.js";
import { repositoryAssetPath } from "../template/assets.js";
import { prepareContent } from "../parsers/index.js";
import { discoverProjectUnits } from "../project/discover.js";
import { runChecks } from "../checks/run.js";
import {
  applyContextHooks,
  assertHooksTrusted,
  runCheckHooks,
  runParserHook,
} from "../hooks/run.js";
import type {
  ContentRule,
  FileRule,
  JsonRule,
  ParserName,
  CheckResult,
  PlanOperation,
  ProjectConfig,
  ReconciliationPlan,
  Snapshot,
  TemplateRule,
} from "../types.js";

function digest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

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

async function renderRule(
  rule: Exclude<TemplateRule, { type: "delete" }>,
  snapshot: Snapshot,
  context: Awaited<ReturnType<typeof buildContext>>,
  partials: TemplatePartial[],
): Promise<string> {
  if (rule.type === "file" && "contents" in rule) {
    return rule.contents;
  }
  if (rule.type === "file" && "source" in rule) {
    return readFile(
      resolveInside(snapshot.directory, repositoryAssetPath(rule.source)),
      "utf8",
    );
  }
  const templatePath = resolveInside(snapshot.directory, rule.template);
  const template = await readFile(templatePath, "utf8");
  return renderTemplate(template, context, rule.template, partials);
}

async function loadPartials(snapshot: Snapshot): Promise<TemplatePartial[]> {
  const partials: TemplatePartial[] = [];

  for (const [name, file] of Object.entries(
    snapshot.manifest.partials ?? {},
  )) {
    const contents = await readFile(resolveInside(snapshot.directory, file), "utf8");
    partials.push({ name, contents });
  }
  return partials;
}

function parserFor(rule: FileRule | JsonRule | ContentRule): ParserName {
  if (rule.type === "file") return "text";
  if (rule.type === "json") return "json-merge";
  return rule.parser;
}

function rulePointers(
  rule: TemplateRule,
): string[] | undefined {
  return rule.type === "json" || rule.type === "content"
    ? rule.pointers
    : undefined;
}

function ruleSchema(rule: TemplateRule): string | undefined {
  return rule.type === "json" || rule.type === "content"
    ? rule.schema
    : undefined;
}

function structuredRule(rule: TemplateRule): boolean {
  if (rule.type === "json") return true;
  return rule.type === "content" && rule.parser !== "text";
}

function ruleEnabled(
  rule: TemplateRule,
  context: Awaited<ReturnType<typeof buildContext>>,
  partials: TemplatePartial[],
): boolean {
  if (!rule.when) return true;
  const rendered = renderTemplate(rule.when, context, `${rule.id}.when`, partials)
    .trim()
    .toLowerCase();
  return rendered !== "" && rendered !== "false" && rendered !== "0";
}

function appliesToUnit(rule: TemplateRule, isRoot: boolean): boolean {
  const scope = rule.scope ?? "root";
  return scope === "all" || (scope === "root" ? isRoot : !isRoot);
}

function relativeProjectPath(root: string, destination: string): string {
  return path.relative(root, destination).split(path.sep).join("/");
}

function validateExceptions(
  config: ProjectConfig,
  snapshot: Snapshot,
): void {
  const rules = new Map(snapshot.manifest.rules.map((rule) => [rule.id, rule]));
  for (const ruleId of config.exclude?.rules ?? []) {
    if (!rules.has(ruleId)) {
      throw new KnittoError(`Excluded rule does not exist: ${ruleId}`, "CONFIG");
    }

  }

  for (const [ruleId, pointers] of Object.entries(
    config.exclude?.pointers ?? {},
  )) {
    const rule = rules.get(ruleId);
    if (!rule || !structuredRule(rule)) {
      throw new KnittoError(
        `Pointer exclusions require a JSON rule: ${ruleId}`,
        "CONFIG",
      );
    }
    for (const pointer of pointers) {
      const pointers = rulePointers(rule);
      if (pointers && !pointers.includes(pointer)) {
        throw new KnittoError(
          `Excluded pointer is not managed by ${ruleId}: ${pointer}`,
          "CONFIG",
        );
      }
    }
  }

  for (const [ruleId, overrides] of Object.entries(config.overrides ?? {})) {
    const rule = rules.get(ruleId);
    if (!rule || !structuredRule(rule)) {
      throw new KnittoError(
        `Overrides require a JSON rule: ${ruleId}`,
        "CONFIG",
      );
    }
    for (const pointer of Object.keys(overrides)) {
      const pointers = rulePointers(rule);
      if (pointers && !pointers.includes(pointer)) {
        throw new KnittoError(
          `Override pointer is not managed by ${ruleId}: ${pointer}`,
          "CONFIG",
        );
      }
    }
  }
}

export async function createPlan(
  projectRoot: string,
  config: ProjectConfig,
  snapshot: Snapshot,
): Promise<ReconciliationPlan> {
  const root = path.resolve(projectRoot);
  const partials = await loadPartials(snapshot);
  const units = await discoverProjectUnits(root, config);
  const excludedRules = new Set<string>();
  const excludedPointers: Record<string, string[]> = {};
  const operations: PlanOperation[] = [];
  const checks: CheckResult[] = [];
  const operatedPaths = new Map<string, string>();

  for (const unit of units) {
    assertHooksTrusted(snapshot, unit);
    validateExceptions(unit.config, snapshot);
    const context = await applyContextHooks(
      snapshot,
      unit,
      await buildContext(unit, snapshot.manifest),
    );
    for (const ruleId of unit.config.exclude?.rules ?? []) {
      excludedRules.add(ruleId);
    }
    for (const [ruleId, pointers] of Object.entries(
      unit.config.exclude?.pointers ?? {},
    )) {
      excludedPointers[ruleId] = [
        ...new Set([...(excludedPointers[ruleId] ?? []), ...pointers]),
      ];
    }

    for (const rule of snapshot.manifest.rules) {
      if (!appliesToUnit(rule, unit.isRoot)) continue;
      if (unit.config.exclude?.rules?.includes(rule.id)) continue;
      if (!ruleEnabled(rule, context, partials)) continue;

      const renderedDestination = renderTemplate(
        rule.destination,
        context,
        `${rule.id}.destination`,
        partials,
      );
      const destinationRoot = rule.target === "root" ? root : unit.path;

      if (rule.type === "delete" && rule.glob) {
        const matches = await glob(renderedDestination, {
          cwd: destinationRoot,
          dot: true,
          nodir: true,
        });
        for (const match of matches.sort()) {
          const matchedDestination = resolveInside(destinationRoot, match);
          await assertNoEscapingSymlink(root, matchedDestination);
          const matchedCurrent = await readOptional(matchedDestination);
          if (matchedCurrent !== null) {
            const operationPath = relativeProjectPath(root, matchedDestination);
            operations.push({
              type: "delete",
              ruleId: rule.id,
              path: operationPath,
              before: matchedCurrent,
              beforeDigest: digest(matchedCurrent),
            });
          }
        }
        continue;
      }

      const destination = resolveInside(destinationRoot, renderedDestination);
      await assertNoEscapingSymlink(root, destination);
      const current = await readOptional(destination);
      const operationPath = relativeProjectPath(root, destination);
      const existingRule = operatedPaths.get(operationPath);
      if (existingRule) {
        throw new KnittoError(
          `Rules ${existingRule} and ${rule.id} both manage ${operationPath}`,
          "TEMPLATE",
        );
      }

      if (rule.type === "delete") {
        if (current !== null) {
          operatedPaths.set(operationPath, rule.id);
          operations.push({
            type: "delete",
            ruleId: rule.id,
            path: operationPath,
            before: current,
            beforeDigest: digest(current),
          });
        }
        continue;
      }

      if (rule.type === "file" && rule.ifMissing && current !== null) {
        continue;
      }

      const rendered = await renderRule(rule, snapshot, context, partials);
      const pointers = rulePointers(rule);
      const schemaPath = ruleSchema(rule);
      let schema: unknown;
      if (schemaPath) {
        const schemaTemplate = await readFile(
          resolveInside(snapshot.directory, schemaPath),
          "utf8",
        );
        const renderedSchema = renderTemplate(
          schemaTemplate,
          context,
          schemaPath,
          partials,
        );
        try {
          schema = JSON.parse(renderedSchema) as unknown;
        } catch (error) {
          throw new KnittoError(
            `Rendered JSON Schema is invalid: ${schemaPath}`,
            "TEMPLATE",
            { cause: error },
          );
        }
      }
      const excluded = unit.config.exclude?.pointers?.[rule.id];
      const overrides = unit.config.overrides?.[rule.id];
      const prepared =
        rule.type === "content" && rule.parser === "hook"
          ? await runParserHook(snapshot, rule.hook ?? "", {
              rule,
              rendered,
              current,
              schema,
              pointers,
              excludedPointers: excluded ?? [],
              overrides: overrides ?? {},
              context,
            })
          : prepareContent({
              parser: parserFor(rule),
              rendered,
              current,
              ...(schema !== undefined ? { schema } : {}),
              ...((rule.type === "json" || rule.type === "content") &&
              rule.exact
                ? { exactPointers: rule.exact }
                : {}),
              ...(pointers ? { pointers } : {}),
              ...(excluded ? { excludedPointers: excluded } : {}),
              ...(overrides ? { overrides } : {}),
              ...((rule.type === "json" || rule.type === "content") &&
              rule.indent !== undefined
                ? { indent: rule.indent }
                : {}),
            });
      const desired = prepared.contents;

      if (current !== desired) {
        operatedPaths.set(operationPath, rule.id);
        operations.push({
          type: "write",
          ruleId: rule.id,
          path: operationPath,
          before: current,
          after: desired,
          beforeDigest: current === null ? null : digest(current),
          ...(prepared.jsonPatch ? { jsonPatch: prepared.jsonPatch } : {}),
          ...((rule.type === "file" || rule.type === "content") &&
          rule.mode !== undefined
            ? { mode: rule.mode }
            : {}),
        });
      }
    }

    checks.push(
      ...(await runChecks(
        snapshot.manifest.checks ?? [],
        unit,
        context,
        partials,
      )),
      ...(await runCheckHooks(snapshot, unit, context)),
    );
  }

  return {
    projectRoot: root,
    templateDigest: snapshot.digest,
    operations,
    checks,
    excludedRules: [...excludedRules],
    excludedPointers,
  };
}
