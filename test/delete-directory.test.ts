import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { access, rm } from "node:fs/promises";
import { applyPlan } from "../src/engine/apply.js";
import { createPlan } from "../src/engine/plan.js";
import { resolveCurrentSnapshot } from "../src/sources/resolve.js";
import type { ProjectConfig } from "../src/types.js";
import { temporaryDirectory, writeJson, writeText } from "./helpers.js";

test("glob deletion prunes empty parent directories", async () => {
  const root = await temporaryDirectory("knitto-delete-directory-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "remove-github",
      rules: [
        {
          id: "remove-github",
          type: "delete",
          destination: ".github/**",
          glob: true,
        },
      ],
    });
    await writeText(
      path.join(project, ".github", "workflows", "ci.yml"),
      "name: CI\n",
    );

    const config: ProjectConfig = {
      source: { type: "local", path: "../template" },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);
    await applyPlan(plan);

    await assert.rejects(() => access(path.join(project, ".github")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
