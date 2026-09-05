import assert from "node:assert/strict";
import test from "node:test";
import { prepareJson } from "../src/parsers/json.js";
import { DELETE_SENTINEL } from "../src/context/render.js";

test("schema reconciliation removes forbidden and additional properties", () => {
  const result = prepareJson({
    current: {
      name: "example",
      legacy: true,
      repository: {
        type: "git",
        url: "old",
        extra: "remove",
      },
    },
    desired: {
      repository: {
        url: "https://example.com/repo",
      },
    },
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        legacy: false,
        repository: {
          type: "object",
          properties: {
            type: { const: "git" },
            url: { type: "string" },
          },
          required: ["type", "url"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  });

  assert.deepEqual(result.value, {
    name: "example",
    repository: {
      type: "git",
      url: "https://example.com/repo",
    },
  });
  assert.deepEqual(result.unfixable, []);
  assert.ok(
    result.patch.some(
      (operation) =>
        operation.op === "remove" && operation.path === "/repository/extra",
    ),
  );
  assert.ok(
    result.patch.some(
      (operation) => operation.op === "remove" && operation.path === "/legacy",
    ),
  );
});

test("excluded pointers remain untouched and suppress their violations", () => {
  const result = prepareJson({
    current: {
      repository: {
        type: "custom",
        url: "old",
      },
    },
    desired: {
      repository: {
        type: "git",
        url: "new",
      },
    },
    schema: {
      type: "object",
      properties: {
        repository: {
          type: "object",
          properties: {
            type: { const: "git" },
            url: { const: "new" },
          },
          required: ["type", "url"],
          additionalProperties: false,
        },
      },
    },
    excludedPointers: ["/repository/type"],
  });

  test("conditional false schemas remove properties when a feature is disabled", () => {
    const prettier = false;
    const result = prepareJson({
      current: {
        scripts: {
          test: "node --test",
          format: "legacy formatter",
        },
      },
      desired: {
        scripts: {
          lint: "eslint .",
          ...(prettier ? { format: "prettier . --check" } : {}),
        },
      },
      schema: {
        type: "object",
        properties: {
          scripts: {
            type: "object",
            properties: {
              lint: { type: "string" },
              format: prettier ? { type: "string" } : false,
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    });

    test("exact pointers and template deletion markers emit JSON Patch", () => {
      const result = prepareJson({
        current: {
          name: "example",
          repository: {
            type: "git",
            url: "old",
            directory: "legacy",
          },
          scripts: {
            test: "node --test",
            format: "legacy formatter",
          },
          standard: true,
        },
        desired: {
          repository: {
            type: "git",
            url: "new",
          },
          scripts: {
            lint: "eslint .",
            format: DELETE_SENTINEL,
          },
          standard: DELETE_SENTINEL,
        },
        exactPointers: ["/repository"],
      });

      assert.deepEqual(result.value, {
        name: "example",
        repository: {
          type: "git",
          url: "new",
        },
        scripts: {
          test: "node --test",
          lint: "eslint .",
        },
      });
      assert.ok(
        result.patch.some(
          (operation) =>
            operation.op === "remove" &&
            operation.path === "/repository/directory",
        ),
      );
    });

    assert.deepEqual(result.value, {
      scripts: {
        test: "node --test",
        lint: "eslint .",
      },
    });
    assert.ok(
      result.patch.some(
        (operation) =>
          operation.op === "remove" && operation.path === "/scripts/format",
      ),
    );
  });

  assert.deepEqual(result.value, {
    repository: {
      type: "custom",
      url: "new",
    },
  });
  assert.deepEqual(result.unfixable, []);
});
