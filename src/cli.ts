#!/usr/bin/env node

import path from "node:path";
import { access, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command, InvalidArgumentError } from "commander";
import {
  loadProjectConfig,
  loadProjectLock,
  saveProjectConfig,
  writeProjectConfig,
  writeProjectLock,
} from "./config.js";
import { applyPlan } from "./engine/apply.js";
import { formatPlan } from "./engine/diff.js";
import { createPlan } from "./engine/plan.js";
import { exitCodeFor, KnittoError } from "./errors.js";
import { createLock } from "./lock.js";
import {
  assertCiTemplateInputsConfigured,
  describeTemplateInputs,
  parsePromptAssignments,
  resolveTemplateInputs,
} from "./onboarding.js";
import {
  resolveCurrentSnapshot,
  resolveLockedSnapshot,
} from "./sources/resolve.js";
import { run } from "./sources/process.js";
import { initializeTemplate } from "./template/init.js";
import { validateTemplateSnapshot } from "./template/validate.js";
import { templateReleaseTag } from "./template/release.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "./version.js";
import {
  CONFIG_FILE,
  LOCK_FILE,
  type ProjectConfig,
  type Snapshot,
  type SourceConfig,
} from "./types.js";

interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  set?: string[];
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function assignmentValues(options: { set?: unknown }): string[] {
  return Array.isArray(options.set)
    ? options.set.filter(
        (entry: unknown): entry is string => typeof entry === "string",
      )
    : [];
}

function isCiEnvironment(): boolean {
  const value = process.env.CI?.trim().toLowerCase();
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}

async function configuredInputs(
  root: string,
  config: ProjectConfig,
  snapshot: Snapshot,
  options: { set?: unknown },
): Promise<ProjectConfig> {
  const supplied = parsePromptAssignments(assignmentValues(options));
  assertCiTemplateInputsConfigured(
    root,
    config,
    snapshot.manifest,
    supplied,
    isCiEnvironment(),
  );
  const resolved = await resolveTemplateInputs(
    root,
    config,
    snapshot.manifest,
    supplied,
  );
  if (resolved.changed) await saveProjectConfig(root, resolved.config);
  return resolved.config;
}

function projectPath(value: string): string {
  return path.resolve(value);
}

function sourceType(value: string): SourceConfig["type"] {
  if (value === "local" || value === "http" || value === "git") return value;
  throw new InvalidArgumentError("Source type must be local, http, or git");
}

async function promptSource(): Promise<SourceConfig> {
  if (!stdin.isTTY) {
    throw new KnittoError(
      "Interactive init requires a terminal; pass --type and --source",
      "USAGE",
    );
  }

  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    const type = sourceType(
      (await prompts.question("Template source type (local/http/git): ")).trim(),
    );
    const locator = (await prompts.question(
      type === "local" ? "Template directory: " : "Template URL: ",
    )).trim();
    const templatePath = (await prompts.question(
      "Template path within source (optional): ",
    )).trim();

    if (type === "local") return { type, path: locator };
    if (type === "http") {
      return {
        type,
        url: locator,
        ...(templatePath ? { path: templatePath } : {}),
      };
    }

    const ref = (await prompts.question("Git ref (default: HEAD): ")).trim();
    return {
      type,
      url: locator,
      ...(templatePath ? { path: templatePath } : {}),
      ...(ref ? { ref } : {}),
    };
  } finally {
    prompts.close();
  }
}

function configuredSource(options: {
  type?: SourceConfig["type"];
  source?: string;
  templatePath?: string;
  ref?: string;
}): SourceConfig | null {
  if (!options.type && !options.source) return null;
  if (!options.type || !options.source) {
    throw new KnittoError(
      "--type and --source must be provided together",
      "USAGE",
    );
  }

  if (options.type === "local") {
    return { type: "local", path: options.source };
  }
  if (options.type === "http") {
    return {
      type: "http",
      url: options.source,
      ...(options.templatePath ? { path: options.templatePath } : {}),
    };
  }
  return {
    type: "git",
    url: options.source,
    ...(options.templatePath ? { path: options.templatePath } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
  };
}

function sourceFromLocator(
  locator: string,
  options: {
    type?: SourceConfig["type"];
    templatePath?: string;
    ref?: string;
  },
): SourceConfig {
  const type =
    options.type ??
    (locator.startsWith("git@") ||
    locator.startsWith("ssh://") ||
    locator.endsWith(".git") ||
    /^https?:\/\/github\.com\//.test(locator)
      ? "git"
      : /^https?:\/\//.test(locator)
        ? "http"
        : "local");
  if (type === "local") return { type, path: locator };
  if (type === "http") {
    return {
      type,
      url: locator,
      ...(options.templatePath ? { path: options.templatePath } : {}),
    };
  }
  return {
    type,
    url: locator,
    path: options.templatePath ?? ".knitto",
    ...(options.ref ? { ref: options.ref } : {}),
  };
}

async function selectedSnapshot(
  projectRoot: string,
  config: ProjectConfig,
  update: boolean,
): Promise<{ snapshot: Snapshot; advanceLock: boolean }> {
  const lockExists = await access(path.join(projectRoot, LOCK_FILE))
    .then(() => true)
    .catch(() => false);
  if (update || !lockExists) {
    return {
      snapshot: await resolveCurrentSnapshot(config.source, projectRoot),
      advanceLock: true,
    };
  }
  return {
    snapshot: await resolveLockedSnapshot(
      await loadProjectLock(projectRoot),
      projectRoot,
    ),
    advanceLock: false,
  };
}

async function selectedValidatedSnapshot(
  projectRoot: string,
  config: ProjectConfig,
  update: boolean,
): Promise<{ snapshot: Snapshot; advanceLock: boolean }> {
  const selection = await selectedSnapshot(projectRoot, config, update);
  await validateTemplateSnapshot(selection.snapshot);
  if (config.source.type === "git") {
    const expectedTag = templateReleaseTag(
      selection.snapshot.manifest.release,
    );
    if (expectedTag && config.source.ref !== expectedTag) {
      throw new KnittoError(
        `Template updates require an immutable release tag; run knitto source pin ${projectRoot} --ref ${expectedTag}`,
        "CONFIG",
      );
    }
  }
  return selection;
}

function outputPlan(
  plan: Awaited<ReturnType<typeof createPlan>>,
  options: OutputOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else if (!options.quiet) {
    process.stdout.write(formatPlan(plan));
  }
}

const program = new Command();
program
  .name("knitto")
  .description("Reconcile a project directory with a pinned template snapshot")
  .version(KNITTO_VERSION);

program
  .command("init-template")
  .description("scaffold a new self-managed Knitto template")
  .argument("[directory]", "template directory", ".")
  .option("--name <name>", "template name; defaults to the directory name")
  .action(async (directory, options: { name?: string }) => {
    const root = projectPath(directory);
    await initializeTemplate(root, options.name);
    console.log(`Initialized Knitto template in ${root}`);
  });

program
  .command("inputs")
  .description("inspect template-required inputs without prompting")
  .argument("[project]", "project directory", ".")
  .option("--update", "inspect the newest source snapshot")
  .option("--json", "emit machine-readable JSON")
  .action(async (project, options: { update?: boolean; json?: boolean }) => {
    const root = projectPath(project);
    const config = await loadProjectConfig(root);
    const { snapshot } = await selectedSnapshot(
      root,
      config,
      options.update ?? false,
    );
    const description = describeTemplateInputs(
      root,
      config,
      snapshot.manifest,
    );
    const result = {
      projectRoot: root,
      templateDigest: snapshot.digest,
      ...description,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Template Inputs\n\nProject:  ${root}`);
    console.log(`Template: ${snapshot.digest}`);
    console.log(`Prompts:  ${description.willPrompt ? "yes" : "no"}\n`);
    if (description.inputs.length === 0) {
      console.log("No template inputs declared.");
      return;
    }
    for (const input of description.inputs) {
      const status = input.configured
        ? "configured"
        : input.default !== undefined
          ? `default: ${input.default}`
          : "missing";
      console.log(`${input.path} (${input.type}, ${status})`);
      console.log(`  ${input.message}`);
      if (input.choices) {
        console.log(
          `  Choices: ${input.choices
            .map((choice) => choice.value)
            .join(", ")}`,
        );
      }
    }
  });

program
  .command("init")
  .argument("[project]", "project directory", ".")
  .option("--type <type>", "source type", sourceType)
  .option("--source <locator>", "source directory or URL")
  .option("--template-path <path>", "template path within the source")
  .option("--ref <ref>", "Git ref")
  .option(
    "--set <key=value>",
    "set a template onboarding answer; repeatable",
    collectOption,
    [],
  )
  .action(async (project, options) => {
    const root = projectPath(project);
    const explicit = configuredSource(
      options as Parameters<typeof configuredSource>[0],
    );
    let config: ProjectConfig;
    let shouldWriteConfig = false;

    if (explicit) {
      config = {
        source: explicit,
        engine: {
          package: KNITTO_PACKAGE,
          version: KNITTO_VERSION,
        },
      };
      shouldWriteConfig = true;
    } else {
      const configExists = await access(path.join(root, CONFIG_FILE))
        .then(() => true)
        .catch(() => false);
      if (configExists) {
        config = await loadProjectConfig(root);
      } else {
        config = {
          source: await promptSource(),
          engine: {
            package: KNITTO_PACKAGE,
            version: KNITTO_VERSION,
          },
        };
        shouldWriteConfig = true;
      }
    }

    const source = config.source;
    const snapshot = await resolveCurrentSnapshot(source, root);
    if (shouldWriteConfig) await writeProjectConfig(root, config);
    config = await configuredInputs(root, config, snapshot, options);
    await writeProjectLock(root, createLock(source, snapshot), {
      exclusive: true,
    });
    console.log(`Initialized ${root} with ${snapshot.digest}`);
  });

program
  .command("check")
  .description("validate Knitto configuration, template assets, and compliance")
  .argument("[project]", "project directory", ".")
  .option("--update", "validate against the newest source snapshot")
  .option("--json", "emit machine-readable JSON")
  .option("--quiet", "suppress human-readable output")
  .option("--set <path=value>", "set a required template input", collectOption, [])
  .action(async (project, options: OutputOptions & { update?: boolean }) => {
    const root = projectPath(project);
    let config = await loadProjectConfig(root);
    const lockExists = await access(path.join(root, LOCK_FILE))
      .then(() => true)
      .catch(() => false);
    if (lockExists) await loadProjectLock(root);
    const { snapshot } = await selectedValidatedSnapshot(
      root,
      config,
      options.update ?? false,
    );
    config = await configuredInputs(root, config, snapshot, options);
    const plan = await createPlan(root, config, snapshot);
    outputPlan(plan, options);
    if (plan.operations.length > 0 || plan.checks.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("plan")
  .argument("[project]", "project directory", ".")
  .option("--update", "resolve the newest source snapshot")
  .option("--json", "emit machine-readable JSON")
  .option("--set <path=value>", "set a required template input", collectOption, [])
  .action(async (project, options: OutputOptions & { update?: boolean }) => {
    const root = projectPath(project);
    let config = await loadProjectConfig(root);
    const { snapshot } = await selectedValidatedSnapshot(
      root,
      config,
      options.update ?? false,
    );
    config = await configuredInputs(root, config, snapshot, options);
    outputPlan(await createPlan(root, config, snapshot), options);
  });

program
  .command("apply")
  .description("plan and atomically apply repository changes in one command")
  .argument("[project]", "project directory", ".")
  .option("--update", "resolve and apply the newest source snapshot")
  .option("--json", "emit machine-readable JSON")
  .option("--set <path=value>", "set a required template input", collectOption, [])
  .action(async (project, options: OutputOptions & { update?: boolean }) => {
    const root = projectPath(project);
    let config = await loadProjectConfig(root);
    const update = options.update ?? false;
    const { snapshot, advanceLock } = await selectedValidatedSnapshot(
      root,
      config,
      update,
    );
    config = await configuredInputs(root, config, snapshot, options);
    const plan = await createPlan(root, config, snapshot);
    outputPlan(plan, options);
    await applyPlan(plan);
    if (advanceLock) {
      const appliedConfig = await loadProjectConfig(root);
      await writeProjectLock(root, createLock(appliedConfig.source, snapshot));
    }
    if (!options.json) {
      console.log(
        plan.operations.length === 0
          ? "Project already complies."
          : `Applied ${plan.operations.length} operation(s).`,
      );
    }
  });

const source = program.command("source").description("Inspect template sources");
source
  .command("set")
  .description("attach an existing project to a template source")
  .argument("<locator>", "template directory or URL")
  .argument("[project]", "project directory", ".")
  .option("--type <type>", "source type; inferred when omitted", sourceType)
  .option("--template-path <path>", "template path within the source")
  .option("--ref <ref>", "Git ref; released templates select their tag")
  .action(
    async (
      locator,
      project,
      options: {
        type?: SourceConfig["type"];
        templatePath?: string;
        ref?: string;
      },
    ) => {
      const root = projectPath(project);
      const initialSource = sourceFromLocator(locator, options);
      let snapshot = await resolveCurrentSnapshot(initialSource, root);
      await validateTemplateSnapshot(snapshot);

      let selectedSource = initialSource;
      const releaseTag = templateReleaseTag(snapshot.manifest.release);
      if (initialSource.type === "git" && releaseTag) {
        if (options.ref && options.ref !== releaseTag) {
          throw new KnittoError(
            `Template release declares immutable tag ${releaseTag}`,
            "TEMPLATE",
          );
        }
        selectedSource = { ...initialSource, ref: releaseTag };
        snapshot = await resolveCurrentSnapshot(selectedSource, root);
        await validateTemplateSnapshot(snapshot);
      }

      const configExists = await access(path.join(root, CONFIG_FILE))
        .then(() => true)
        .catch(() => false);
      const existing = configExists
        ? await loadProjectConfig(root, { enforceEngine: false })
        : undefined;
      const config: ProjectConfig = {
        ...(existing ?? {}),
        source: selectedSource,
        engine: snapshot.manifest.engine ?? {
          package: KNITTO_PACKAGE,
          version: KNITTO_VERSION,
        },
      };
      if (configExists) {
        await saveProjectConfig(root, config);
      } else {
        await writeProjectConfig(root, config);
      }
      await rm(path.join(root, LOCK_FILE), { force: true });
      console.log(
        `Set ${root} template source to ${
          selectedSource.type === "local"
            ? selectedSource.path
            : selectedSource.url
        }${
          selectedSource.type === "git" && selectedSource.ref
            ? ` at ${selectedSource.ref}`
            : ""
        }`,
      );
    },
  );

source
  .command("pin")
  .description("pin a Git template release and its required Knitto engine")
  .argument("[project]", "project directory", ".")
  .requiredOption("--ref <tag>", "immutable template release tag")
  .action(async (project, options: { ref: string }) => {
    const root = projectPath(project);
    const config = await loadProjectConfig(root);
    if (config.source.type !== "git") {
      throw new KnittoError(
        "Only Git template sources can be pinned to a release tag",
        "CONFIG",
      );
    }
    const pinnedSource: SourceConfig = {
      ...config.source,
      ref: options.ref,
    };
    await run("git", [
      "ls-remote",
      "--exit-code",
      "--tags",
      config.source.url,
      `refs/tags/${options.ref}`,
    ]);
    const snapshot = await resolveCurrentSnapshot(pinnedSource, root);
    await validateTemplateSnapshot(snapshot);
    const expectedTag = templateReleaseTag(snapshot.manifest.release);
    if (expectedTag) {
      if (options.ref !== expectedTag) {
        throw new KnittoError(
          `Template release ${options.ref} declares tag ${expectedTag}`,
          "TEMPLATE",
        );
      }
    }
    await saveProjectConfig(root, {
      ...config,
      source: pinnedSource,
      ...(snapshot.manifest.engine
        ? { engine: snapshot.manifest.engine }
        : {}),
    });
    console.log(
      `Pinned ${root} to ${options.ref}${
        snapshot.manifest.engine
          ? ` with ${snapshot.manifest.engine.package}@${snapshot.manifest.engine.version}`
          : ""
      }`,
    );
  });

source
  .command("inspect")
  .argument("[project]", "project directory", ".")
  .option("--json", "emit machine-readable JSON")
  .action(async (project, options: OutputOptions) => {
    const root = projectPath(project);
    const config = await loadProjectConfig(root);
    const lock = await loadProjectLock(root);
    const current = await resolveCurrentSnapshot(config.source, root);
    const result = {
      source: config.source,
      locked: {
        digest: lock.digest,
        provenance: lock.provenance,
        resolvedAt: lock.resolvedAt,
      },
      current: {
        digest: current.digest,
        provenance: current.provenance,
      },
      updateAvailable: current.digest !== lock.digest,
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Source: ${JSON.stringify(config.source)}`);
      console.log(`Locked: ${lock.digest}`);
      console.log(`Current: ${current.digest}`);
      console.log(`Update available: ${result.updateAvailable ? "yes" : "no"}`);
    }
  });

source
  .command("trust")
  .argument("[project]", "project directory", ".")
  .option("--digest <digest>", "template digest; defaults to the locked digest")
  .action(async (project, options: { digest?: string }) => {
    const root = projectPath(project);
    const config = await loadProjectConfig(root);
    const lock = await loadProjectLock(root);
    const digest = options.digest ?? lock.digest;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new KnittoError(`Invalid template digest: ${digest}`, "USAGE");
    }
    config.trust = {
      hooks: [...new Set([...(config.trust?.hooks ?? []), digest])],
    };
    await saveProjectConfig(root, config);
    console.log(`Trusted executable hooks from ${digest}`);
  });

program.command("gh", "orchestrate Knitto repositories through GitHub", {
  executableFile: "knitto-gh",
});

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`knitto: ${message}`);
  process.exitCode = exitCodeFor(error);
});
