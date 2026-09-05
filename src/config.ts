import path from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  CONFIG_FILE,
  LOCK_FILE,
  type ProjectConfig,
  type ProjectLock,
  type ParserName,
  type SourceConfig,
  type TemplateCheck,
  type TemplateHook,
  type TemplateManifest,
  type TemplateRule,
} from "./types.js";
import { KnittoError } from "./errors.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "./version.js";
import { gte, parse, valid } from "semver";

export function isEngineCompatible(
  requiredVersion: string,
  runningVersion = KNITTO_VERSION,
): boolean {
  const required = parse(requiredVersion);
  const running = parse(runningVersion);
  return Boolean(
    required &&
      running &&
      running.major === required.major &&
      gte(running, required),
  );
}

async function readJson(file: string, kind: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    throw new KnittoError(`Unable to read ${kind}: ${file}`, "CONFIG", {
      cause: error,
    });
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new KnittoError(`Invalid JSON in ${kind}: ${file}`, "CONFIG", {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParserName(value: unknown): value is ParserName {
  return (
    value === "text" ||
    value === "json" ||
    value === "json-merge" ||
    value === "package-json" ||
    value === "yaml" ||
    value === "yaml-merge" ||
    value === "ini" ||
    value === "ini-merge" ||
    value === "hook"
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function validateCheck(value: unknown): TemplateCheck {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new KnittoError("Template contains an invalid check", "TEMPLATE");
  }
  const common: {
    id: string;
    when?: string;
    scope?: "root" | "workspace" | "all";
  } = {
    id: value.id,
    ...(typeof value.when === "string" ? { when: value.when } : {}),
    ...(value.scope === "root" ||
    value.scope === "workspace" ||
    value.scope === "all"
      ? { scope: value.scope }
      : {}),
  };

  if (value.type === "required-packages" && isRecord(value.packages)) {
    const packages: Record<string, string[]> = {};
    for (const [location, specs] of Object.entries(value.packages)) {
      const parsed = stringArray(specs);
      if (!parsed) {
        throw new KnittoError(
          `Required package specs for ${location} must be strings`,
          "TEMPLATE",
        );
      }
      packages[location] = parsed;
    }
    return { ...common, type: "required-packages", packages };
  }

  if (value.type === "unwanted-packages") {
    const packages = stringArray(value.packages);
    const allowed =
      value.allowed === undefined ? undefined : stringArray(value.allowed);
    if (!packages || (value.allowed !== undefined && !allowed)) {
      throw new KnittoError(
        "Unwanted package checks require string arrays",
        "TEMPLATE",
      );
    }
    return {
      ...common,
      type: "unwanted-packages",
      packages,
      ...(allowed ? { allowed } : {}),
    };
  }

  if (
    value.type === "file-regex" &&
    typeof value.path === "string" &&
    typeof value.pattern === "string"
  ) {
    return {
      ...common,
      type: "file-regex",
      path: value.path,
      pattern: value.pattern,
      ...(typeof value.flags === "string" ? { flags: value.flags } : {}),
      ...(typeof value.mustMatch === "boolean"
        ? { mustMatch: value.mustMatch }
        : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.solution === "string"
        ? { solution: value.solution }
        : {}),
    };
  }

  if (value.type === "engines") {
    const omit = value.omit === undefined ? undefined : stringArray(value.omit);
    if (value.omit !== undefined && !omit) {
      throw new KnittoError("Engine omissions must be strings", "TEMPLATE");
    }
    return {
      ...common,
      type: "engines",
      ...(omit ? { omit } : {}),
    };
  }

  throw new KnittoError(`Invalid template check: ${value.id}`, "TEMPLATE");
}

function validateHook(value: unknown): TemplateHook {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.kind !== "context" &&
      value.kind !== "parser" &&
      value.kind !== "check") ||
    typeof value.command !== "string"
  ) {
    throw new KnittoError("Template contains an invalid hook", "TEMPLATE");
  }
  const args = value.args === undefined ? undefined : stringArray(value.args);
  if (value.args !== undefined && !args) {
    throw new KnittoError(
      `Hook arguments must be strings: ${value.id}`,
      "TEMPLATE",
    );
  }
  return {
    id: value.id,
    kind: value.kind,
    command: value.command,
    ...(args ? { args } : {}),
  };
}

export function validateSource(value: unknown): SourceConfig {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new KnittoError("Project source is missing or invalid", "CONFIG");
  }

  if (value.type === "local" && typeof value.path === "string") {
    return { type: "local", path: value.path };
  }

  if (value.type === "http" && typeof value.url === "string") {
    return {
      type: "http",
      url: value.url,
      ...(typeof value.path === "string" ? { path: value.path } : {}),
    };
  }

  if (value.type === "git" && typeof value.url === "string") {
    return {
      type: "git",
      url: value.url,
      ...(typeof value.path === "string" ? { path: value.path } : {}),
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    };
  }

  throw new KnittoError(`Unsupported source type: ${value.type}`, "CONFIG");
}

export function validateProjectConfig(
  value: unknown,
  options: { enforceEngine?: boolean } = {},
): ProjectConfig {
  if (!isRecord(value)) {
    throw new KnittoError("Project configuration must be an object", "CONFIG");
  }

  const source = validateSource(value.source);
  const config: ProjectConfig = { source };

  if (value.engine !== undefined) {
    if (
      !isRecord(value.engine) ||
      value.engine.package !== KNITTO_PACKAGE ||
      typeof value.engine.version !== "string" ||
      valid(value.engine.version) === null
    ) {
      throw new KnittoError(
        "Project engine must specify a minimum knitto semantic version",
        "CONFIG",
      );
    }
    if (
      options.enforceEngine !== false &&
      !isEngineCompatible(value.engine.version)
    ) {
      throw new KnittoError(
        `Project requires ${KNITTO_PACKAGE}@${value.engine.version} or newer within major version ${parse(value.engine.version)?.major}, but this is ${KNITTO_PACKAGE}@${KNITTO_VERSION}; run with npx ${KNITTO_PACKAGE}@${value.engine.version}`,
        "CONFIG",
      );
    }
    config.engine = {
      package: KNITTO_PACKAGE,
      version: value.engine.version,
    };
  }

  if (isRecord(value.metadata)) config.metadata = value.metadata;
  if (isRecord(value.variables)) config.variables = value.variables;
  if (value.trust !== undefined) {
    if (!isRecord(value.trust)) {
      throw new KnittoError("Project trust configuration must be an object", "CONFIG");
    }
    const hooks =
      value.trust.hooks === undefined ? undefined : stringArray(value.trust.hooks);
    if (value.trust.hooks !== undefined && !hooks) {
      throw new KnittoError("Trusted hook digests must be strings", "CONFIG");
    }
    config.trust = {
      ...(hooks ? { hooks } : {}),
    };
  }
  if (isRecord(value.overrides)) {
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const [ruleId, ruleOverrides] of Object.entries(value.overrides)) {
      if (!isRecord(ruleOverrides)) {
        throw new KnittoError(
          `Overrides for ${ruleId} must be an object`,
          "CONFIG",
        );
      }
      overrides[ruleId] = ruleOverrides;
    }
    config.overrides = overrides;
  }
  if (isRecord(value.exclude)) {
    let rules: string[] | undefined;
    if (value.exclude.rules !== undefined) {
      if (
        !Array.isArray(value.exclude.rules) ||
        !value.exclude.rules.every((item) => typeof item === "string")
      ) {
        throw new KnittoError("Excluded rules must be strings", "CONFIG");
      }
      rules = value.exclude.rules;
    }

    let pointers: Record<string, string[]> | undefined;
    if (value.exclude.pointers !== undefined) {
      if (!isRecord(value.exclude.pointers)) {
        throw new KnittoError(
          "Excluded pointers must be grouped by rule ID",
          "CONFIG",
        );
      }
      pointers = {};
      for (const [ruleId, rulePointers] of Object.entries(
        value.exclude.pointers,
      )) {
        if (
          !Array.isArray(rulePointers) ||
          !rulePointers.every((item) => typeof item === "string")
        ) {
          throw new KnittoError(
            `Excluded pointers for ${ruleId} must be strings`,
            "CONFIG",
          );
        }
        pointers[ruleId] = rulePointers;
      }
    }

    const checks =
      value.exclude.checks === undefined
        ? undefined
        : stringArray(value.exclude.checks);
    if (value.exclude.checks !== undefined && !checks) {
      throw new KnittoError("Excluded checks must be strings", "CONFIG");
    }

    config.exclude = {
      ...(rules ? { rules } : {}),
      ...(checks ? { checks } : {}),
      ...(pointers ? { pointers } : {}),
    };
  }

  return config;
}

function validateRule(value: unknown): TemplateRule {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.destination !== "string"
  ) {
    throw new KnittoError("Template contains an invalid rule", "TEMPLATE");
  }

  if (value.type === "delete") {
    return {
      id: value.id,
      type: "delete",
      destination: value.destination,
      ...(typeof value.glob === "boolean" ? { glob: value.glob } : {}),
      ...(typeof value.when === "string" ? { when: value.when } : {}),
      ...(value.scope === "root" ||
      value.scope === "workspace" ||
      value.scope === "all"
        ? { scope: value.scope }
        : {}),
      ...(value.target === "project" || value.target === "root"
        ? { target: value.target }
        : {}),
    };
  }

  if (value.type === "file" && typeof value.template === "string") {
    return {
      id: value.id,
      type: "file",
      destination: value.destination,
      template: value.template,
      ...(typeof value.mode === "number" ? { mode: value.mode } : {}),
      ...(typeof value.when === "string" ? { when: value.when } : {}),
      ...(value.scope === "root" ||
      value.scope === "workspace" ||
      value.scope === "all"
        ? { scope: value.scope }
        : {}),
      ...(value.target === "project" || value.target === "root"
        ? { target: value.target }
        : {}),
    };
  }

  if (
    value.type === "json" &&
    typeof value.template === "string" &&
    (value.pointers === undefined || stringArray(value.pointers))
  ) {
    const pointers = stringArray(value.pointers);
    const exact = stringArray(value.exact);
    if (value.exact !== undefined && !exact) {
      throw new KnittoError(
        "Exact structured pointers must be strings",
        "TEMPLATE",
      );
    }
    return {
      id: value.id,
      type: "json",
      destination: value.destination,
      template: value.template,
      ...(pointers ? { pointers } : {}),
      ...(exact ? { exact } : {}),
      ...(typeof value.indent === "number" ? { indent: value.indent } : {}),
      ...(typeof value.schema === "string" ? { schema: value.schema } : {}),
      ...(typeof value.when === "string" ? { when: value.when } : {}),
      ...(value.scope === "root" ||
      value.scope === "workspace" ||
      value.scope === "all"
        ? { scope: value.scope }
        : {}),
      ...(value.target === "project" || value.target === "root"
        ? { target: value.target }
        : {}),
    };
  }

  if (
    value.type === "content" &&
    typeof value.template === "string" &&
    isParserName(value.parser) &&
    (value.parser !== "hook" || typeof value.hook === "string") &&
    (value.pointers === undefined || stringArray(value.pointers))
  ) {
    const pointers = stringArray(value.pointers);
    const exact = stringArray(value.exact);
    if (value.exact !== undefined && !exact) {
      throw new KnittoError(
        "Exact structured pointers must be strings",
        "TEMPLATE",
      );
    }
    return {
      id: value.id,
      type: "content",
      destination: value.destination,
      template: value.template,
      parser: value.parser,
      ...(typeof value.hook === "string" ? { hook: value.hook } : {}),
      ...(typeof value.schema === "string" ? { schema: value.schema } : {}),
      ...(pointers ? { pointers } : {}),
      ...(exact ? { exact } : {}),
      ...(typeof value.indent === "number" ? { indent: value.indent } : {}),
      ...(typeof value.mode === "number" ? { mode: value.mode } : {}),
      ...(typeof value.when === "string" ? { when: value.when } : {}),
      ...(value.scope === "root" ||
      value.scope === "workspace" ||
      value.scope === "all"
        ? { scope: value.scope }
        : {}),
      ...(value.target === "project" || value.target === "root"
        ? { target: value.target }
        : {}),
    };
  }

  throw new KnittoError(`Invalid template rule: ${value.id}`, "TEMPLATE");
}

export function validateTemplateManifest(value: unknown): TemplateManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.name !== "string" ||
    !Array.isArray(value.rules)
  ) {
    throw new KnittoError("Invalid template manifest", "TEMPLATE");
  }

  const rules = value.rules.map(validateRule);
  const checks = Array.isArray(value.checks)
    ? value.checks.map(validateCheck)
    : undefined;
  const hooks = Array.isArray(value.hooks)
    ? value.hooks.map(validateHook)
    : undefined;
  let engine: TemplateManifest["engine"];
  if (value.engine !== undefined) {
    if (
      !isRecord(value.engine) ||
      value.engine.package !== KNITTO_PACKAGE ||
      typeof value.engine.version !== "string" ||
      valid(value.engine.version) === null
    ) {
      throw new KnittoError(
        "Template engine must specify a minimum knitto semantic version",
        "TEMPLATE",
      );
    }
    engine = {
      package: KNITTO_PACKAGE,
      version: value.engine.version,
    };
  }
  let release: TemplateManifest["release"];
  if (value.release !== undefined) {
    if (
      !isRecord(value.release) ||
      value.release.provider !== "release-please" ||
      typeof value.release.version !== "string" ||
      valid(value.release.version) === null ||
      typeof value.release.tagFormat !== "string" ||
      !value.release.tagFormat.includes("{version}")
    ) {
      throw new KnittoError(
        "Template release must specify a semantic version and tagFormat containing {version}",
        "TEMPLATE",
      );
    }
    release = {
      provider: "release-please",
      version: value.release.version,
      tagFormat: value.release.tagFormat,
    };
  }
  const prompts = Array.isArray(value.prompts)
    ? value.prompts.map((prompt) => {
        if (
          !isRecord(prompt) ||
          typeof prompt.path !== "string" ||
          !/^(metadata|variables)\.[^.]+$/.test(prompt.path) ||
          typeof prompt.message !== "string" ||
          (prompt.when !== undefined && typeof prompt.when !== "string") ||
          !["text", "number", "confirm", "select"].includes(
            String(prompt.type),
          )
        ) {
          throw new KnittoError(
            "Template contains an invalid onboarding prompt",
            "TEMPLATE",
          );
        }
        const defaultValue =
          typeof prompt.default === "string" ||
          typeof prompt.default === "number" ||
          typeof prompt.default === "boolean"
            ? prompt.default
            : undefined;
        if (prompt.type === "select") {
          if (
            !Array.isArray(prompt.choices) ||
            !prompt.choices.every(
              (choice) =>
                isRecord(choice) &&
                typeof choice.value === "string" &&
                (choice.label === undefined ||
                  typeof choice.label === "string"),
            )
          ) {
            throw new KnittoError(
              `Select prompt ${prompt.path} must define string choices`,
              "TEMPLATE",
            );
          }
          return {
            path: prompt.path as `metadata.${string}` | `variables.${string}`,
            message: prompt.message,
            type: "select" as const,
            choices: prompt.choices.map((choice) => ({
              value: String((choice as Record<string, unknown>).value),
              ...(typeof (choice as Record<string, unknown>).label === "string"
                ? { label: String((choice as Record<string, unknown>).label) }
                : {}),
            })),
            ...(typeof prompt.description === "string"
              ? { description: prompt.description }
              : {}),
            ...(typeof prompt.required === "boolean"
              ? { required: prompt.required }
              : {}),
            ...(defaultValue !== undefined ? { default: defaultValue } : {}),
            ...(typeof prompt.when === "string" ? { when: prompt.when } : {}),
          };
        }
        return {
          path: prompt.path as `metadata.${string}` | `variables.${string}`,
          message: prompt.message,
          type: prompt.type as "text" | "number" | "confirm",
          ...(typeof prompt.description === "string"
            ? { description: prompt.description }
            : {}),
          ...(typeof prompt.required === "boolean"
            ? { required: prompt.required }
            : {}),
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          ...(typeof prompt.when === "string" ? { when: prompt.when } : {}),
        };
      })
    : undefined;
  let partials: Record<string, string> | undefined;
  if (value.partials !== undefined) {
    if (!isRecord(value.partials)) {
      throw new KnittoError(
        "Template partials must map names to files",
        "TEMPLATE",
      );
    }
    partials = {};
    for (const [name, file] of Object.entries(value.partials)) {
      if (typeof file !== "string") {
        throw new KnittoError(
          `Template partial ${name} must reference a file`,
          "TEMPLATE",
        );
      }
      partials[name] = file;
    }
  }
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new KnittoError(
        `Duplicate template rule ID: ${rule.id}`,
        "TEMPLATE",
      );
    }
    ids.add(rule.id);
  }
  const promptPaths = new Set<string>();
  for (const prompt of prompts ?? []) {
    if (promptPaths.has(prompt.path)) {
      throw new KnittoError(
        `Duplicate template prompt path: ${prompt.path}`,
        "TEMPLATE",
      );
    }
    promptPaths.add(prompt.path);
  }

  return {
    schemaVersion: 1,
    name: value.name,
    ...(engine ? { engine } : {}),
    ...(release ? { release } : {}),
    rules,
    ...(checks ? { checks } : {}),
    ...(hooks ? { hooks } : {}),
    ...(Array.isArray(value.extends) &&
    value.extends.every((entry) => typeof entry === "string")
      ? { extends: value.extends }
      : {}),
    ...(Array.isArray(value.inputs) &&
    value.inputs.every((input) => typeof input === "string")
      ? { inputs: value.inputs }
      : {}),
    ...(partials ? { partials } : {}),
    ...(isRecord(value.variables) ? { variables: value.variables } : {}),
    ...(prompts ? { prompts } : {}),
  };
}

export async function loadProjectConfig(
  projectRoot: string,
  options: { enforceEngine?: boolean } = {},
): Promise<ProjectConfig> {
  return validateProjectConfig(
    await readJson(path.join(projectRoot, CONFIG_FILE), "project configuration"),
    options,
  );
}

export async function loadProjectLock(
  projectRoot: string,
): Promise<ProjectLock> {
  const value = await readJson(path.join(projectRoot, LOCK_FILE), "project lock");
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest) ||
    !("source" in value) ||
    !isRecord(value.provenance) ||
    (value.provenance.sourceType !== "local" &&
      value.provenance.sourceType !== "http" &&
      value.provenance.sourceType !== "git") ||
    typeof value.provenance.locator !== "string" ||
    value.templateSchemaVersion !== 1 ||
    typeof value.resolvedAt !== "string"
  ) {
    throw new KnittoError("Invalid project lock", "CONFIG");
  }

  const source = validateSource(value.source);
  let engine: ProjectLock["engine"];
  if (value.engine !== undefined) {
    if (
      !isRecord(value.engine) ||
      value.engine.package !== KNITTO_PACKAGE ||
      typeof value.engine.version !== "string" ||
      valid(value.engine.version) === null
    ) {
      throw new KnittoError("Invalid project lock engine", "CONFIG");
    }
    engine = {
      package: KNITTO_PACKAGE,
      version: value.engine.version,
    };
  }
  return {
    schemaVersion: 1,
    digest: value.digest,
    source,
    ...(engine ? { engine } : {}),
    provenance: {
      sourceType: value.provenance.sourceType,
      locator: value.provenance.locator,
      ...(typeof value.provenance.templatePath === "string"
        ? { templatePath: value.provenance.templatePath }
        : {}),
      ...(typeof value.provenance.revision === "string"
        ? { revision: value.provenance.revision }
        : {}),
      ...(typeof value.provenance.etag === "string"
        ? { etag: value.provenance.etag }
        : {}),
      ...(typeof value.provenance.lastModified === "string"
        ? { lastModified: value.provenance.lastModified }
        : {}),
    },
    templateSchemaVersion: 1,
    resolvedAt: value.resolvedAt,
  };
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  await writeFile(
    path.join(projectRoot, CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    { flag: "wx" },
  );
}

export async function saveProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const destination = path.join(projectRoot, CONFIG_FILE);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeProjectLock(
  projectRoot: string,
  lock: ProjectLock,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const destination = path.join(projectRoot, LOCK_FILE);
  if (options.exclusive) {
    await writeFile(destination, `${JSON.stringify(lock, null, 2)}\n`, {
      flag: "wx",
    });
    return;
  }

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
