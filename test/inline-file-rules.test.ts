import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { createPlan } from "../src/engine/plan.js";
import { applyPlan } from "../src/engine/apply.js";
import { resolveCurrentSnapshot } from "../src/sources/resolve.js";
import { validateTemplateManifest } from "../src/config.js";
import { run } from "../src/sources/process.js";
import type { ProjectConfig } from "../src/types.js";
import {
  temporaryDirectory,
  writeJson,
  writeText,
} from "./helpers.js";

test("inline file rules require exactly one content source", () => {
  for (const rule of [
    {
      id: "missing-source",
      type: "file",
      destination: "file.txt",
    },
    {
      id: "multiple-sources",
      type: "file",
      destination: "file.txt",
      template: "file.txt.hbs",
      contents: "managed\n",
    },
  ]) {
    assert.throws(
      () =>
        validateTemplateManifest({
          schemaVersion: 1,
          name: "invalid-inline-file",
          rules: [rule],
        }),
      /must define exactly one of template, source, or contents/,
    );
  }
});

test("repository source rules capture a root file in Git snapshots", async () => {
  const root = await temporaryDirectory("knitto-repository-source-");
  const templateRepository = path.join(root, "template-repository");
  const template = path.join(templateRepository, ".knitto");
  const project = path.join(root, "project");
  const workflow = [
    "name: Managed",
    "on:",
    "  workflow_dispatch:",
    "",
  ].join("\n");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "repository-source",
      rules: [
        {
          id: "workflow",
          type: "file",
          source: ".github/workflows/update.yml",
          destination: ".github/workflows/update.yml",
        },
      ],
    });
    await writeText(
      path.join(templateRepository, ".github/workflows/update.yml"),
      workflow,
    );
    await run("git", ["init", "--quiet"], { cwd: templateRepository });
    await run("git", ["config", "user.name", "Knitto Test"], {
      cwd: templateRepository,
    });
    await run("git", ["config", "user.email", "test@example.invalid"], {
      cwd: templateRepository,
    });
    await run("git", ["add", "."], { cwd: templateRepository });
    await run("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: templateRepository,
    });

    const config: ProjectConfig = {
      source: {
        type: "git",
        url: templateRepository,
        path: ".knitto",
        ref: "HEAD",
      },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);
    await applyPlan(plan);

    assert.equal(
      await readFile(
        path.join(project, ".github/workflows/update.yml"),
        "utf8",
      ),
      workflow,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline file rules overwrite by default and can create only when missing", async () => {
  const root = await temporaryDirectory("knitto-inline-files-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "inline-files",
      rules: [
        {
          id: "enforced",
          type: "file",
          destination: "enforced.txt",
          contents: "managed\n",
        },
        {
          id: "preserved",
          type: "file",
          destination: "preserved.txt",
          contents: "default\n",
          ifMissing: true,
        },
        {
          id: "created",
          type: "file",
          destination: "created.txt",
          contents: "created\n",
          ifMissing: true,
        },
      ],
    });
    await writeText(path.join(project, "enforced.txt"), "outdated\n");
    await writeText(path.join(project, "preserved.txt"), "custom\n");

    const config: ProjectConfig = {
      source: { type: "local", path: "../template" },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);

    assert.deepEqual(
      plan.operations.map((operation) => operation.path),
      ["enforced.txt", "created.txt"],
    );
    await applyPlan(plan);

    assert.equal(
      await readFile(path.join(project, "enforced.txt"), "utf8"),
      "managed\n",
    );
    assert.equal(
      await readFile(path.join(project, "preserved.txt"), "utf8"),
      "custom\n",
    );
    assert.equal(
      await readFile(path.join(project, "created.txt"), "utf8"),
      "created\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
