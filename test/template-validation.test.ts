import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateTemplateSnapshot } from "../src/template/validate.js";
import type { Snapshot } from "../src/types.js";
import { temporaryDirectory, writeText } from "./helpers.js";

function snapshot(
  directory: string,
  manifest: Snapshot["manifest"],
): Snapshot {
  return {
    digest: `sha256:${"0".repeat(64)}`,
    directory,
    manifest,
    provenance: {
      sourceType: "local",
      locator: directory,
    },
  };
}

test("validates assets for inactive template rules", async () => {
  const root = await temporaryDirectory("knitto-template-validation-");

  await assert.rejects(
    validateTemplateSnapshot(
      snapshot(root, {
        schemaVersion: 1,
        name: "validation",
        rules: [
          {
            id: "inactive",
            type: "file",
            template: "files/missing.hbs",
            destination: "missing",
            when: "false",
          },
        ],
      }),
    ),
    /does not exist: files\/missing\.hbs/,
  );
});

test("validates referenced schemas before reconciliation", async () => {
  const root = await temporaryDirectory("knitto-schema-validation-");
  await writeText(path.join(root, "files", "config.hbs"), "{}\n");

  await assert.rejects(
    validateTemplateSnapshot(
      snapshot(root, {
        schemaVersion: 1,
        name: "validation",
        rules: [
          {
            id: "config",
            type: "json",
            template: "files/config.hbs",
            schema: "schemas/config.json",
            destination: "config.json",
          },
        ],
      }),
    ),
    /does not exist: schemas\/config\.json/,
  );
});

test("validates partial mappings", async () => {
  const root = await temporaryDirectory("knitto-reference-validation-");
  await writeText(path.join(root, "files", "config.hbs"), "{{> shared}}\n");

  await assert.rejects(
    validateTemplateSnapshot(
      snapshot(root, {
        schemaVersion: 1,
        name: "validation",
        partials: { shared: "partials/missing.hbs" },
        rules: [
          {
            id: "config",
            type: "file",
            template: "files/config.hbs",
            destination: "config",
          },
        ],
      }),
    ),
    /does not exist: partials\/missing\.hbs/,
  );
});

test("validates parser hook references and hook commands", async () => {
  const root = await temporaryDirectory("knitto-hook-validation-");
  await writeText(path.join(root, "files", "config.hbs"), "managed\n");

  await assert.rejects(
    validateTemplateSnapshot(
      snapshot(root, {
        schemaVersion: 1,
        name: "validation",
        hooks: [
          {
            id: "parse-config",
            kind: "check",
            command: "hooks/missing",
          },
        ],
        rules: [
          {
            id: "config",
            type: "content",
            parser: "hook",
            hook: "parse-config",
            template: "files/config.hbs",
            destination: "config",
          },
        ],
      }),
    ),
    /Parser hook does not exist for rule config: parse-config/,
  );

  await assert.rejects(
    validateTemplateSnapshot(
      snapshot(root, {
        schemaVersion: 1,
        name: "validation",
        hooks: [
          {
            id: "parse-config",
            kind: "parser",
            command: "hooks/missing",
          },
        ],
        rules: [
          {
            id: "config",
            type: "content",
            parser: "hook",
            hook: "parse-config",
            template: "files/config.hbs",
            destination: "config",
          },
        ],
      }),
    ),
    /does not exist: hooks\/missing/,
  );
});
