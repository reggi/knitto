import { createTwoFilesPatch, diffLines } from "diff";
import type {
  JsonPatchOperation,
  PlanOperation,
  ReconciliationPlan,
} from "../types.js";

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function displayDigest(digest: string): string {
  const [algorithm, value] = digest.split(":", 2);
  return value ? `${algorithm}:${value.slice(0, 12)}` : digest.slice(0, 19);
}

function operationAction(operation: PlanOperation): "CREATE" | "UPDATE" | "DELETE" {
  if (operation.type === "delete") return "DELETE";
  return operation.before === null ? "CREATE" : "UPDATE";
}

function changedLineCounts(operation: PlanOperation): {
  added: number;
  removed: number;
} {
  const before = operation.type === "delete" ? operation.before : operation.before ?? "";
  const after = operation.type === "delete" ? "" : operation.after;
  let added = 0;
  let removed = 0;
  for (const change of diffLines(before, after)) {
    const count = change.count ?? 0;
    if (change.added) added += count;
    if (change.removed) removed += count;
  }
  return { added, removed };
}

function patchSymbol(operation: JsonPatchOperation): string {
  if (operation.op === "add" || operation.op === "copy") return "+";
  if (operation.op === "remove") return "-";
  return "~";
}

function formatOperation(operation: PlanOperation, index: number): string {
  const action = operationAction(operation);
  const lines = changedLineCounts(operation);
  const summary = [
    lines.added > 0 ? plural(lines.added, "line") + " added" : "",
    lines.removed > 0 ? plural(lines.removed, "line") + " removed" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const before = operation.type === "delete" ? operation.before : operation.before ?? "";
  const after = operation.type === "delete" ? "" : operation.after;
  const patch = createTwoFilesPatch(
    operation.type === "write" && operation.before === null
      ? "/dev/null"
      : `a/${operation.path}`,
    operation.type === "delete" ? "/dev/null" : `b/${operation.path}`,
    before,
    after,
    operation.ruleId,
    operation.ruleId,
  );
  const structured =
    operation.type === "write" && operation.jsonPatch?.length
      ? [
          "   Structured changes:",
          ...operation.jsonPatch.map(
            (entry) => `     ${patchSymbol(entry)} ${entry.path || "/"}`,
          ),
          "",
        ]
      : [];

  return [
    `${index + 1}. ${action} ${operation.path}`,
    `   Rule: ${operation.ruleId}`,
    `   Change: ${summary || "content changed"}`,
    ...structured,
    "",
    patch.trimEnd(),
  ].join("\n");
}

export function formatPlan(plan: ReconciliationPlan): string {
  const writes = plan.operations.filter((operation) => operation.type === "write").length;
  const deletes = plan.operations.length - writes;
  const excludedPointers = Object.values(plan.excludedPointers).reduce(
    (count, pointers) => count + pointers.length,
    0,
  );
  const compliant = plan.operations.length === 0 && plan.checks.length === 0;
  const header = [
    "Knitto Plan",
    "",
    `Project:   ${plan.projectRoot}`,
    `Template:  ${displayDigest(plan.templateDigest)}`,
    `Status:    ${compliant ? "Compliant" : "Changes required"}`,
    `Changes:   ${plural(writes, "write")}, ${plural(deletes, "deletion")}`,
    `Checks:    ${plural(plan.checks.length, "issue")}`,
    `Excluded:  ${plural(plan.excludedRules.length, "rule")}, ${plural(excludedPointers, "pointer")}`,
  ];

  if (compliant) return `${header.join("\n")}\n`;

  const sections = [header.join("\n")];
  if (plan.operations.length > 0) {
    sections.push(
      ["Changes\n-------", ...plan.operations.map(formatOperation)].join("\n\n"),
    );
  }
  if (plan.checks.length > 0) {
    sections.push(
      [
        "Policy Issues\n-------------",
        ...plan.checks.map((check, index) =>
          [
            `${index + 1}. ${check.title}`,
            `   Check: ${check.id}`,
            `   Project: ${check.project}`,
            ...check.body.map((line) => `   ${line}`),
            ...(check.solution ? [`   Fix: ${check.solution}`] : []),
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}
