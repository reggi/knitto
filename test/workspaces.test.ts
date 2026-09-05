import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chmod, rm } from "node:fs/promises";
import { createPlan } from "../src/engine/plan.js";
import { resolveCurrentSnapshot } from "../src/sources/resolve.js";
import type { ProjectConfig } from "../src/types.js";
import {
  temporaryDirectory,
  writeJson,
  writeText,
} from "./helpers.js";

test("workspace rules can target workspaces and repository root", async () => {
  const root = await temporaryDirectory("knitto-workspaces-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "workspace-template",
      rules: [
        {
          id: "workspace-readme",
          type: "file",
          scope: "workspace",
          template: "workspace.hbs",
          destination: "GENERATED.md",
        },
        {
          id: "workspace-root-file",
          type: "file",
          scope: "workspace",
          target: "root",
          template: "workspace.hbs",
          destination: ".generated/{{pkgNameFs}}.md",
        },
      ],
    });
    await writeText(path.join(template, "workspace.hbs"), "# {{pkgName}}\n");
    await writeJson(path.join(project, "package.json"), {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeJson(path.join(project, "packages/a/package.json"), {
      name: "@example/a",
    });

    const config: ProjectConfig = {
      source: { type: "local", path: "../template" },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);
    assert.deepEqual(
      plan.operations.map((operation) => operation.path).sort(),
      [".generated/example-a.md", "packages/a/GENERATED.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted context hooks can provide template-specific derived values", async () => {
  const root = await temporaryDirectory("knitto-hooks-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "hook-template",
      hooks: [
        {
          id: "derive",
          kind: "context",
          command: "hooks/derive.mjs",
        },
      ],
      rules: [
        {
          id: "derived",
          type: "file",
          when: "{{hookEnabled}}",
          template: "derived.hbs",
          destination: "DERIVED.md",
        },
      ],
    });
    const hook = path.join(template, "hooks/derive.mjs");
    await writeText(
      hook,
      '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ hookEnabled: true, hookValue: "from hook" })));\n',
    );
    await chmod(hook, 0o755);
    await writeText(path.join(template, "derived.hbs"), "{{hookValue}}\n");
    await writeJson(path.join(project, "package.json"), { name: "project" });

    const source = { type: "local", path: "../template" } as const;
    const snapshot = await resolveCurrentSnapshot(source, project);
    const config: ProjectConfig = {
      source,
      trust: { hooks: [snapshot.digest] },
    };
    const plan = await createPlan(project, config, snapshot);
    assert.equal(plan.operations.length, 1);
    assert.equal(
      plan.operations[0]?.type === "write"
        ? plan.operations[0].after
        : undefined,
      "from hook\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
