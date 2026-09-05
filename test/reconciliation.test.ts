import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { createPlan } from "../src/engine/plan.js";
import { applyPlan } from "../src/engine/apply.js";
import { resolveCurrentSnapshot } from "../src/sources/resolve.js";
import type { ProjectConfig } from "../src/types.js";
import {
  temporaryDirectory,
  writeJson,
  writeText,
} from "./helpers.js";

test("structured rules preserve unmanaged values and honor exclusions", async () => {
  const root = await temporaryDirectory("knitto-project-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "node-project",
      inputs: ["package.json"],
      variables: { license: "MIT" },
      rules: [
        {
          id: "package",
          type: "json",
          template: "package.json.hbs",
          destination: "package.json",
          pointers: ["/name", "/license", "/repository"],
        },
      ],
    });
    await writeText(
      path.join(template, "package.json.hbs"),
      [
        "{",
        '  "name": {{json files.[package.json].json.name}},',
        '  "license": {{json variables.license}},',
        '  "repository": {{json metadata.url}}',
        "}",
        "",
      ].join("\n"),
    );
    await writeJson(path.join(project, "package.json"), {
      name: "example",
      private: true,
      scripts: { test: "node --test" },
      license: "ISC",
    });

    const config: ProjectConfig = {
      source: { type: "local", path: "../template" },
      metadata: { url: "https://example.com/example" },
      exclude: { pointers: { package: ["/name"] } },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);

    assert.equal(plan.operations.length, 1);
    await applyPlan(plan);

    const result = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(result.name, "example");
    assert.equal(result.private, true);
    assert.deepEqual(result.scripts, { test: "node --test" });
    assert.equal(result.license, "MIT");
    assert.equal(result.repository, "https://example.com/example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project overrides replace managed template values", async () => {
  const root = await temporaryDirectory("knitto-override-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "override",
      rules: [
        {
          id: "package",
          type: "json",
          template: "package.json.hbs",
          destination: "package.json",
          pointers: ["/homepage"],
        },
      ],
    });

    test("apply refuses to overwrite a file changed after planning", async () => {
      const root = await temporaryDirectory("knitto-stale-");
      const template = path.join(root, "template");
      const project = path.join(root, "project");

      try {
        await writeJson(path.join(template, "template.json"), {
          schemaVersion: 1,
          name: "stale",
          rules: [
            {
              id: "readme",
              type: "file",
              template: "README.hbs",
              destination: "README.md",
            },
          ],
        });
        await writeText(path.join(template, "README.hbs"), "# Managed\n");
        await writeText(path.join(project, "README.md"), "# Original\n");

        const config: ProjectConfig = {
          source: { type: "local", path: "../template" },
        };
        const snapshot = await resolveCurrentSnapshot(config.source, project);
        const plan = await createPlan(project, config, snapshot);
        await writeText(path.join(project, "README.md"), "# Concurrent edit\n");

        await assert.rejects(() => applyPlan(plan), /stale plan/);
        assert.equal(
          await readFile(path.join(project, "README.md"), "utf8"),
          "# Concurrent edit\n",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    await writeText(
      path.join(template, "package.json.hbs"),
      '{"homepage":"https://default.example"}\n',
    );
    await writeJson(path.join(project, "package.json"), { name: "example" });

    const config: ProjectConfig = {
      source: { type: "local", path: "../template" },
      overrides: {
        package: { "/homepage": "https://custom.example" },
      },
    };
    const snapshot = await resolveCurrentSnapshot(config.source, project);
    const plan = await createPlan(project, config, snapshot);
    await applyPlan(plan);

    const result = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(result.homepage, "https://custom.example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
