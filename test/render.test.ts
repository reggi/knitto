import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "../src/context/render.js";
import type { RenderContext } from "../src/types.js";

const context: RenderContext = {
  project: {
    path: "/project",
    name: "project",
  },
  files: {},
  metadata: {},
  variables: {
    value: "node_modules/\n",
  },
  pkg: {},
  derived: {},
};

test("appendMissingLines remains available to locked template snapshots", () => {
  const rendered = renderTemplate(
    '{{appendMissingLines value ".DS_Store" "railway-plan.json"}}',
    context,
    "legacy-template",
  );

  assert.equal(
    rendered,
    "node_modules/\n.DS_Store\nrailway-plan.json\n",
  );
});
