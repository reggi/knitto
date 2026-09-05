import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { initializeTemplate } from "../src/template/init.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "../src/version.js";
import { temporaryDirectory } from "./helpers.js";

test("initializes an empty self-managed template", async () => {
  const parent = await temporaryDirectory("knitto-init-template-");
  const root = path.join(parent, "service-template");

  await initializeTemplate(root);

  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, ".knitto.json"), "utf8")),
    {
      source: {
        type: "local",
        path: ".knitto",
      },
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, ".knitto", "template.json"), "utf8"),
    ),
    {
      schemaVersion: 1,
      name: "service-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      rules: [],
    },
  );
});

test("refuses to replace an existing template target", async () => {
  const root = await temporaryDirectory("knitto-init-template-existing-");
  const configFile = path.join(root, ".knitto.json");
  await writeFile(configFile, '{"existing":true}\n');

  await assert.rejects(
    initializeTemplate(root),
    /Refusing to initialize a template/,
  );
  assert.equal(await readFile(configFile, "utf8"), '{"existing":true}\n');
});
