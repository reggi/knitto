import assert from "node:assert/strict";
import test from "node:test";
import {
  isEngineCompatible,
  validateProjectConfig,
  validateTemplateManifest,
} from "../src/config.js";
import { createLock } from "../src/lock.js";
import type { Snapshot } from "../src/types.js";
import {
  templateReleaseTag,
  UNRELEASED_TEMPLATE_VERSION,
} from "../src/template/release.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "../src/version.js";

test("release and engine pins remain optional", () => {
  assert.deepEqual(
    validateProjectConfig({
      source: { type: "git", url: "https://github.com/acme/template.git" },
    }),
    {
      source: { type: "git", url: "https://github.com/acme/template.git" },
    },
  );
});

test("project configuration requires a compatible Knitto engine", () => {
  assert.deepEqual(
    validateProjectConfig({
      source: { type: "local", path: ".knitto" },
      engine: { package: KNITTO_PACKAGE, version: KNITTO_VERSION },
    }).engine,
    { package: KNITTO_PACKAGE, version: KNITTO_VERSION },
  );

  assert.throws(
    () =>
      validateProjectConfig({
        source: { type: "local", path: ".knitto" },
        engine: { package: KNITTO_PACKAGE, version: "99.0.0" },
      }),
    /run with npx knitto@99\.0\.0/,
  );

  assert.deepEqual(
    validateProjectConfig({
      source: { type: "local", path: ".knitto" },
      engine: { package: KNITTO_PACKAGE, version: "0.0.1" },
    }).engine,
    { package: KNITTO_PACKAGE, version: "0.0.1" },
  );

  assert.equal(isEngineCompatible("0.0.1", "0.1.0"), true);
  assert.equal(isEngineCompatible("0.2.0", "0.1.0"), false);
  assert.equal(isEngineCompatible("0.1.0", "1.0.0"), false);

  assert.deepEqual(
    validateProjectConfig(
      {
        source: { type: "local", path: ".knitto" },
        engine: { package: KNITTO_PACKAGE, version: "99.0.0" },
      },
      { enforceEngine: false },
    ).engine,
    { package: KNITTO_PACKAGE, version: "99.0.0" },
  );
});

test("template releases support template-defined tag formats", () => {
  const manifest = validateTemplateManifest({
    schemaVersion: 1,
    name: "policy",
    engine: { package: KNITTO_PACKAGE, version: KNITTO_VERSION },
    release: {
      provider: "release-please",
      version: "2.3.0",
      tagFormat: "policy-v{version}",
    },
    rules: [],
  });

  assert.deepEqual(manifest.release, {
    provider: "release-please",
    version: "2.3.0",
    tagFormat: "policy-v{version}",
  });
});

test("release bootstrap metadata does not require a nonexistent tag", () => {
  assert.equal(
    templateReleaseTag({
      provider: "release-please",
      version: UNRELEASED_TEMPLATE_VERSION,
      tagFormat: "v{version}",
    }),
    undefined,
  );
  assert.equal(
    templateReleaseTag({
      provider: "release-please",
      version: "1.2.3",
      tagFormat: "v{version}",
    }),
    "v1.2.3",
  );
});

test("new locks record the executing Knitto engine", () => {
  const snapshot: Snapshot = {
    digest: `sha256:${"0".repeat(64)}`,
    directory: "/template",
    manifest: {
      schemaVersion: 1,
      name: "policy",
      rules: [],
    },
    provenance: {
      sourceType: "local",
      locator: "/template",
    },
  };

  assert.deepEqual(
    createLock({ type: "local", path: ".knitto" }, snapshot).engine,
    {
      package: KNITTO_PACKAGE,
      version: KNITTO_VERSION,
    },
  );
});
