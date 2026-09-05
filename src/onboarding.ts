import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { renderTemplate } from "./context/render.js";
import { KnittoError } from "./errors.js";
import type {
  ProjectConfig,
  RenderContext,
  TemplateManifest,
  TemplatePrompt,
} from "./types.js";

function parseBoolean(value: string, pathValue: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  throw new KnittoError(
    `Template input ${pathValue} expects true or false`,
    "USAGE",
  );
}

function parseValue(prompt: TemplatePrompt, value: string): unknown {
  if (prompt.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new KnittoError(
        `Template input ${prompt.path} expects a number`,
        "USAGE",
      );
    }
    return number;
  }
  if (prompt.type === "confirm") return parseBoolean(value, prompt.path);
  if (
    prompt.type === "select" &&
    !prompt.choices.some((choice) => choice.value === value)
  ) {
    throw new KnittoError(
      `Template input ${prompt.path} must be one of: ${prompt.choices
        .map((choice) => choice.value)
        .join(", ")}`,
      "USAGE",
    );
  }
  return value;
}

function configValue(config: ProjectConfig, pathValue: string): unknown {
  const [section, name] = pathValue.split(".", 2);
  if (!name) return undefined;
  if (section === "metadata") return config.metadata?.[name];
  if (section === "variables") return config.variables?.[name];
  return undefined;
}

function setConfigValue(
  config: ProjectConfig,
  pathValue: string,
  value: unknown,
): void {
  const [section, name] = pathValue.split(".", 2);
  if (!name) {
    throw new KnittoError(
      `Template input path is missing a field name: ${pathValue}`,
      "TEMPLATE",
    );
  }
  if (section === "metadata") {
    config.metadata = { ...(config.metadata ?? {}), [name]: value };
    return;
  }
  if (section === "variables") {
    config.variables = { ...(config.variables ?? {}), [name]: value };
    return;
  }
  throw new KnittoError(
    `Template input path must begin with metadata. or variables.: ${pathValue}`,
    "TEMPLATE",
  );
}

function renderDefault(
  prompt: TemplatePrompt,
  context: RenderContext,
): string | undefined {
  if (prompt.default === undefined) return undefined;
  if (typeof prompt.default !== "string") return String(prompt.default);
  return renderTemplate(prompt.default, context, `${prompt.path}.default`);
}

function inputContext(
  root: string,
  config: ProjectConfig,
  manifest: TemplateManifest,
): RenderContext {
  return {
    project: {
      path: root,
      name: path.basename(root),
    },
    files: {},
    metadata: config.metadata ?? {},
    variables: {
      ...(manifest.variables ?? {}),
      ...(config.variables ?? {}),
    },
    pkg: {},
    derived: {},
  };
}

function promptEnabled(
  prompt: TemplatePrompt,
  context: RenderContext,
): boolean {
  if (!prompt.when) return true;
  const result = renderTemplate(
    prompt.when,
    context,
    `${prompt.path}.when`,
  )
    .trim()
    .toLowerCase();
  return result !== "" && result !== "false" && result !== "0";
}

function promptLabel(prompt: TemplatePrompt, defaultValue?: string): string {
  const choices =
    prompt.type === "select"
      ? ` (${prompt.choices
          .map((choice) =>
            choice.label ? `${choice.label}=${choice.value}` : choice.value,
          )
          .join(", ")})`
      : "";
  const suffix =
    defaultValue === undefined || defaultValue === ""
      ? ""
      : ` [${defaultValue}]`;
  return `${prompt.message}${choices}${suffix}: `;
}

export function parsePromptAssignments(values: string[]): Record<string, string> {
  const assignments: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new KnittoError(
        `Invalid --set value; expected path=value: ${value}`,
        "USAGE",
      );
    }
    assignments[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return assignments;
}

export function describeTemplateInputs(
  root: string,
  config: ProjectConfig,
  manifest: TemplateManifest,
): {
  inputs: Array<{
    path: string;
    type: TemplatePrompt["type"];
    message: string;
    description?: string;
    required: boolean;
    configured: boolean;
    willPrompt: boolean;
    value?: unknown;
    default?: string;
    choices?: Array<{ value: string; label?: string }>;
  }>;
  willPrompt: boolean;
  missingRequired: string[];
} {
  const context = inputContext(root, config, manifest);
  const inputs = (manifest.prompts ?? [])
    .filter((prompt) => promptEnabled(prompt, context))
    .map((prompt) => {
    const value = configValue(config, prompt.path);
    const configured = value !== undefined;
    const defaultValue = renderDefault(prompt, context);
    return {
      path: prompt.path,
      type: prompt.type,
      message: prompt.message,
      ...(prompt.description ? { description: prompt.description } : {}),
      required: prompt.required ?? false,
      configured,
      willPrompt: !configured,
      ...(configured ? { value } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(prompt.type === "select" ? { choices: prompt.choices } : {}),
    };
    });
  return {
    inputs,
    willPrompt: inputs.some((input) => input.willPrompt),
    missingRequired: inputs
      .filter(
        (input) =>
          input.required && !input.configured && input.default === undefined,
      )
      .map((input) => input.path),
  };
}

export function assertCiTemplateInputsConfigured(
  root: string,
  config: ProjectConfig,
  manifest: TemplateManifest,
  supplied: Record<string, string>,
  ci: boolean,
): void {
  if (!ci) return;
  const pending = describeTemplateInputs(root, config, manifest).inputs
    .filter((input) => !input.configured && !(input.path in supplied))
    .map((input) => input.path);
  if (pending.length === 0) return;

  const manualFlags = pending
    .map((inputPath) => `--set '${inputPath}=<value>'`)
    .join(" ");
  throw new KnittoError(
    [
      `CI cannot collect template inputs that require a human decision: ${pending.join(", ")}`,
      "Create a pull request that populates these fields in .knitto.json before automated reconciliation continues.",
      "",
      "From the repository root, collect and save them interactively:",
      "  knitto plan --update",
      "",
      "Or provide every value explicitly without prompting:",
      `  knitto plan --update ${manualFlags}`,
      "",
      "Commit the resulting .knitto.json change in that pull request, then rerun CI.",
      "Use knitto inputs --update --json to inspect the required values programmatically.",
    ].join("\n"),
    "CONFIG",
  );
}

export async function resolveTemplateInputs(
  root: string,
  originalConfig: ProjectConfig,
  manifest: TemplateManifest,
  supplied: Record<string, string>,
): Promise<{ config: ProjectConfig; changed: boolean }> {
  const prompts = manifest.prompts ?? [];
  const known = new Set<string>(prompts.map((prompt) => prompt.path));
  for (const pathValue of Object.keys(supplied)) {
    if (!known.has(pathValue)) {
      throw new KnittoError(
        `Unknown template input supplied with --set: ${pathValue}`,
        "USAGE",
      );
    }
  }

  const config = structuredClone(originalConfig);
  const context = (): RenderContext => inputContext(root, config, manifest);
  const terminal = stdin.isTTY
    ? createInterface({ input: stdin, output: stdout })
    : null;
  let changed = false;

  try {
    for (const prompt of prompts) {
      if (!promptEnabled(prompt, context())) continue;
      const existing = configValue(config, prompt.path);
      if (existing !== undefined && !(prompt.path in supplied)) continue;
      const defaultValue = renderDefault(prompt, context());
      let raw = supplied[prompt.path];
      if (raw === undefined && terminal) {
        if (prompt.description) stdout.write(`${prompt.description}\n`);
        raw = (await terminal.question(promptLabel(prompt, defaultValue))).trim();
      }
      if (raw === undefined || raw === "") raw = defaultValue;
      if (raw === undefined || raw === "") {
        if (prompt.required) {
          throw new KnittoError(
            `Template input ${prompt.path} is required; run interactively or pass --set ${prompt.path}=value`,
            "USAGE",
          );
        }
        continue;
      }
      const parsed = parseValue(prompt, raw);
      if (!Object.is(existing, parsed)) {
        setConfigValue(config, prompt.path, parsed);
        changed = true;
      }
    }
  } finally {
    terminal?.close();
  }

  return { config, changed };
}
