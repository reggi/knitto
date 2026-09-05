import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chmod, rm } from "node:fs/promises";
import { digestDirectory } from "../src/snapshots/canonical.js";
import { temporaryDirectory, writeText } from "./helpers.js";

test("canonical snapshots ignore creation order and root location", async () => {
  const left = await temporaryDirectory("knitto-left-");
  const right = await temporaryDirectory("knitto-right-");

  try {
    await writeText(path.join(left, "b.txt"), "two\n");
    await writeText(path.join(left, "a.txt"), "one\n");
    await writeText(path.join(right, "a.txt"), "one\n");
    await writeText(path.join(right, "b.txt"), "two\n");

    assert.equal(await digestDirectory(left), await digestDirectory(right));
  } finally {
    await rm(left, { recursive: true, force: true });
    await rm(right, { recursive: true, force: true });
  }
});

test("canonical snapshots include executable mode", async () => {
  const directory = await temporaryDirectory("knitto-mode-");

  try {
    const executable = path.join(directory, "script");
    await writeText(executable, "#!/bin/sh\n");
    const before = await digestDirectory(directory);
    await chmod(executable, 0o755);
    const after = await digestDirectory(directory);
    assert.notEqual(before, after);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
