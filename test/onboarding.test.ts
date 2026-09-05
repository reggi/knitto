import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCiTemplateInputsConfigured,
  describeTemplateInputs,
  parsePromptAssignments,
  resolveTemplateInputs,
} from "../src/onboarding.js";
import type { ProjectConfig, TemplateManifest } from "../src/types.js";

const config: ProjectConfig = {
  source: {
    type: "local",
    path: ".knitto",
  },
};

const manifest: TemplateManifest = {
  schemaVersion: 1,
  name: "inputs",
  rules: [],
  prompts: [
    {
      path: "metadata.name",
      type: "text",
      message: "Package name",
      default: "{{project.name}}",
      required: true,
    },
    {
      path: "variables.nodeVersion",
      type: "select",
      message: "Node.js version",
      default: ">=22",
      choices: [{ value: ">=22" }, { value: ">=24" }],
    },
    {
      path: "metadata.replicas",
      type: "number",
      message: "Replica count",
    },
    {
      path: "variables.sleep",
      type: "confirm",
      message: "Enable sleep",
    },
  ],
};

test("template inputs populate typed metadata and variables", async () => {
  const result = await resolveTemplateInputs(
    "/projects/example",
    config,
    manifest,
    {
      "metadata.name": "custom-name",
      "variables.nodeVersion": ">=24",
      "metadata.replicas": "2",
      "variables.sleep": "yes",
    },
  );

  assert.deepEqual(result.config, {
    source: config.source,
    metadata: {
      name: "custom-name",
      replicas: 2,
    },
    variables: {
      nodeVersion: ">=24",
      sleep: true,
    },
  });
});

test("template inputs render project-aware defaults", async () => {
  const result = await resolveTemplateInputs(
    "/projects/example",
    config,
    {
      ...manifest,
      prompts: manifest.prompts?.slice(0, 2),
    },
    {},
  );

  assert.deepEqual(result.config, {
    source: config.source,
    metadata: {
      name: "example",
    },
    variables: {
      nodeVersion: ">=22",
    },
  });
});

test("--set assignments split on the first equals sign", () => {
  assert.deepEqual(parsePromptAssignments(["metadata.name=value=with=equals"]), {
    "metadata.name": "value=with=equals",
  });

  test("input descriptions expose prompt behavior without collecting answers", () => {
    const description = describeTemplateInputs(
      "/projects/example",
      {
        ...config,
        metadata: {
          name: "configured-name",
        },
      },
      manifest,
    );

    assert.equal(description.willPrompt, true);
    assert.deepEqual(description.missingRequired, []);
    assert.deepEqual(
      description.inputs.map((input) => ({
        path: input.path,
        configured: input.configured,
        willPrompt: input.willPrompt,
        default: input.default,
      })),
      [
        {
          path: "metadata.name",
          configured: true,
          willPrompt: false,
          default: "example",
        },
        {
          path: "variables.nodeVersion",
          configured: false,
          willPrompt: true,
          default: ">=22",
        },
        {
          path: "metadata.replicas",
          configured: false,
          willPrompt: true,
          default: undefined,
        },
        {
          path: "variables.sleep",
          configured: false,
          willPrompt: true,
          default: undefined,
        },
      ],
    );
  });
});

test("conditional template inputs are omitted when disabled", async () => {
  const conditionalManifest: TemplateManifest = {
    ...manifest,
    prompts: [
      {
        path: "metadata.name",
        type: "text",
        message: "Package name",
        default: "{{project.name}}",
        required: true,
        when:
          '{{#unless (eq project.name "template-source")}}true{{/unless}}',
      },
    ],
  };

  assert.deepEqual(
    describeTemplateInputs(
      "/projects/template-source",
      config,
      conditionalManifest,
    ),
    {
      inputs: [],
      willPrompt: false,
      missingRequired: [],
    },
  );

  const result = await resolveTemplateInputs(
    "/projects/template-source",
    config,
    conditionalManifest,
    {},
  );
  assert.deepEqual(result, { config, changed: false });
});

test("CI requires unresolved inputs to be populated through a manual PR", () => {
  const ciManifest: TemplateManifest = {
    ...manifest,
    prompts: manifest.prompts?.slice(0, 1),
  };

  assert.throws(
    () =>
      assertCiTemplateInputsConfigured(
        "/projects/example",
        config,
        ciManifest,
        {},
        true,
      ),
    (error: unknown) => {
      assert.match(
        String(error),
        /Create a pull request that populates these fields in \.knitto\.json/,
      );
      assert.match(String(error), /knitto plan --update/);
      assert.match(
        String(error),
        /--set 'metadata\.name=<value>'/,
      );
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertCiTemplateInputsConfigured(
      "/projects/example",
      config,
      ciManifest,
      { "metadata.name": "example" },
      true,
    ),
  );
});
