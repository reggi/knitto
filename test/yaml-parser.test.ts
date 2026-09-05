import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { DELETE_SENTINEL } from "../src/context/render.js";
import { prepareContent } from "../src/parsers/index.js";

test("yaml merge supports exact subtrees and nested removal markers", () => {
  const result = prepareContent({
    parser: "yaml-merge",
    current: [
      "name: example",
      "repository:",
      "  type: git",
      "  url: old",
      "  directory: legacy",
      "scripts:",
      "  test: node --test",
      "  format: legacy formatter",
      "",
    ].join("\n"),
    rendered: [
      "repository:",
      "  type: git",
      "  url: new",
      "scripts:",
      "  lint: eslint .",
      `  format: ${JSON.stringify(DELETE_SENTINEL)}`,
      "",
    ].join("\n"),
    exactPointers: ["/repository"],
  });

  assert.deepEqual(parseYaml(result.contents), {
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
    result.jsonPatch?.some(
      (operation) =>
        operation.op === "remove" &&
        operation.path === "/repository/directory",
    ),
  );
  assert.ok(
    result.jsonPatch?.some(
      (operation) =>
        operation.op === "remove" && operation.path === "/scripts/format",
    ),
  );
});

test("yaml merge supports exclusions, overrides, and schema reconciliation", () => {
  const result = prepareContent({
    parser: "yaml-merge",
    current: [
      "repository:",
      "  type: custom",
      "  url: old",
      "  extra: remove",
      "legacy: true",
      "",
    ].join("\n"),
    rendered: [
      "repository:",
      "  type: git",
      "  url: new",
      "",
    ].join("\n"),
    excludedPointers: ["/repository/type"],
    overrides: {
      "/repository/url": "overridden",
    },
    schema: {
      type: "object",
      properties: {
        repository: {
          type: "object",
          properties: {
            type: { const: "git" },
            url: { type: "string" },
          },
          required: ["type", "url"],
          additionalProperties: false,
        },
        legacy: false,
      },
      additionalProperties: false,
    },
  });

  assert.deepEqual(parseYaml(result.contents), {
    repository: {
      type: "custom",
      url: "overridden",
    },
  });
});
