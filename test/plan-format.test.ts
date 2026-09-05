import assert from "node:assert/strict";
import test from "node:test";
import { formatPlan } from "../src/engine/diff.js";
import type { ReconciliationPlan } from "../src/types.js";

const basePlan: ReconciliationPlan = {
  projectRoot: "/projects/example",
  templateDigest:
    "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  operations: [],
  checks: [],
  excludedRules: [],
  excludedPointers: {},
};

test("plan output provides context before file diffs", () => {
  const output = formatPlan({
    ...basePlan,
    operations: [
      {
        type: "write",
        ruleId: "shared-gitignore",
        path: ".gitignore",
        before: "node_modules/\n",
        after: "node_modules/\n.DS_Store\n",
        beforeDigest: "sha256:before",
      },
    ],
  });

  assert.match(output, /^Knitto Plan/);
  assert.match(output, /Project:   \/projects\/example/);
  assert.match(output, /Template:  sha256:1234567890ab/);
  assert.match(output, /Status:    Changes required/);
  assert.match(output, /1\. UPDATE \.gitignore/);
  assert.match(output, /Rule: shared-gitignore/);
  assert.match(output, /Change: 1 line added/);
  assert.match(output, /\+\.DS_Store/);
});

test("compliant plan output still identifies the project and revision", () => {
  const output = formatPlan(basePlan);

  assert.match(output, /Status:    Compliant/);
  assert.match(output, /Changes:   0 writes, 0 deletions/);
  assert.doesNotMatch(output, /Changes\n-------/);
});
