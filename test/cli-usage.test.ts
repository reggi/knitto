import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "../src/version.js";
import {
  temporaryDirectory,
  writeJson,
  writeText,
} from "./helpers.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = process.env.KNITTO_CLI_ENTRY
  ? path.resolve(repositoryRoot, process.env.KNITTO_CLI_ENTRY)
  : path.join(repositoryRoot, "src", "cli.ts");

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; cache?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: {
        ...process.env,
        CI: "true",
        ...(options.cache ? { XDG_CACHE_HOME: options.cache } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

function knitto(
  args: string[],
  options: { cache: string },
): Promise<CommandResult> {
  return run(
    process.execPath,
    [
      ...(cli.endsWith(".ts") ? ["--import", "tsx"] : []),
      cli,
      ...args,
    ],
    options,
  );
}

async function successful(
  result: Promise<CommandResult>,
): Promise<CommandResult> {
  const resolved = await result;
  assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
  return resolved;
}

test("CLI reports the engine version used by the test entrypoint", async () => {
  const root = await temporaryDirectory("knitto-cli-version-");
  try {
    const result = await successful(
      knitto(["--version"], { cache: path.join(root, "cache") }),
    );
    assert.equal(result.stdout.trim(), KNITTO_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI initializes, plans, applies, and checks a local project", async () => {
  const root = await temporaryDirectory("knitto-cli-local-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");

  try {
    await successful(knitto(["init-template", template], { cache }));
    await writeJson(path.join(template, ".knitto", "template.json"), {
      schemaVersion: 1,
      name: "usage-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      rules: [
        {
          id: "readme",
          type: "file",
          template: "files/README.md.hbs",
          destination: "README.md",
        },
        {
          id: "package-script",
          type: "json",
          template: "files/package.json.hbs",
          destination: "package.json",
          pointers: ["/scripts/format"],
        },
        {
          id: "legacy-file",
          type: "delete",
          destination: "LEGACY.md",
        },
      ],
    });

    await writeText(
      path.join(template, ".knitto", "files", "README.md.hbs"),
      "# Managed by Knitto\n",
    );
    await writeText(
      path.join(template, ".knitto", "files", "package.json.hbs"),
      '{"scripts":{"format":"prettier --write ."}}\n',
    );
    await writeJson(path.join(project, "package.json"), {
      name: "example",
      scripts: { test: "node --test" },
    });
    await writeText(path.join(project, "LEGACY.md"), "remove me\n");

    await successful(
      knitto(
        [
          "init",
          project,
          "--type",
          "local",
          "--source",
          path.join(template, ".knitto"),
        ],
        { cache },
      ),
    );

    const planned = await successful(
      knitto(["plan", project, "--json"], { cache }),
    );
    const plan = JSON.parse(planned.stdout) as {
      operations: Array<{ type: string; path: string }>;
    };
    assert.deepEqual(
      plan.operations
        .map((operation) => [operation.type, operation.path])
        .sort((left, right) =>
          left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0,
        ),
      [
        ["delete", "LEGACY.md"],
        ["write", "README.md"],
        ["write", "package.json"],
      ],
    );

    const drifted = await knitto(["check", project, "--quiet"], { cache });
    assert.equal(drifted.status, 1);

    await successful(knitto(["apply", project], { cache }));
    await successful(knitto(["check", project, "--quiet"], { cache }));

    assert.equal(
      await readFile(path.join(project, "README.md"), "utf8"),
      "# Managed by Knitto\n",
    );
    const packageJson = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    ) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(packageJson.name, "example");
    assert.deepEqual(packageJson.scripts, {
      format: "prettier --write .",
      test: "node --test",
    });
    await assert.rejects(readFile(path.join(project, "LEGACY.md")), /ENOENT/);

    await writeText(path.join(project, "README.md"), "# Local drift\n");
    const changed = await knitto(["check", project, "--quiet"], { cache });
    assert.equal(changed.status, 1);
    await successful(knitto(["apply", project], { cache }));
    await successful(knitto(["check", project, "--quiet"], { cache }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI pins and applies an immutable Git template release", async () => {
  const root = await temporaryDirectory("knitto-cli-release-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");

  try {
    await writeJson(path.join(template, ".knitto", "template.json"), {
      schemaVersion: 1,
      name: "released-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      release: {
        provider: "release-please",
        version: "1.0.0",
        tagFormat: "policy-v{version}",
      },
      rules: [
        {
          id: "policy",
          type: "file",
          template: "files/POLICY.md.hbs",
          destination: "POLICY.md",
        },
      ],
    });
    await writeText(
      path.join(template, ".knitto", "files", "POLICY.md.hbs"),
      "# Released policy\n",
    );
    await successful(run("git", ["init", "--initial-branch=main"], { cwd: template }));
    await successful(
      run("git", ["config", "user.name", "Knitto CLI Test"], {
        cwd: template,
      }),
    );
    await successful(
      run("git", ["config", "user.email", "test@example.invalid"], {
        cwd: template,
      }),
    );
    await successful(run("git", ["add", "."], { cwd: template }));
    await successful(
      run("git", ["commit", "--message", "feat: initial policy"], {
        cwd: template,
      }),
    );
    await successful(
      run("git", ["tag", "policy-v1.0.0"], { cwd: template }),
    );
    await successful(
      run("git", ["tag", "incorrect-v1.0.0"], { cwd: template }),
    );

    await writeJson(path.join(project, ".knitto.json"), {
      source: {
        type: "git",
        url: pathToFileURL(template).href,
        path: ".knitto",
        ref: "main",
      },
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
    });

    const unpinned = await knitto(["plan", project, "--update"], { cache });
    assert.equal(unpinned.status, 2);
    assert.match(unpinned.stderr, /knitto source pin/);

    const incorrectTag = await knitto(
      ["source", "pin", project, "--ref", "incorrect-v1.0.0"],
      { cache },
    );
    assert.equal(incorrectTag.status, 4);
    assert.match(
      incorrectTag.stderr,
      /declares tag policy-v1\.0\.0/,
    );
    assert.equal(
      (
        JSON.parse(
          await readFile(path.join(project, ".knitto.json"), "utf8"),
        ) as { source: { ref: string } }
      ).source.ref,
      "main",
    );

    await successful(
      knitto(
        ["source", "pin", project, "--ref", "policy-v1.0.0"],
        { cache },
      ),
    );
    const config = JSON.parse(
      await readFile(path.join(project, ".knitto.json"), "utf8"),
    ) as {
      source: { ref: string };
      engine: { package: string; version: string };
    };
    assert.equal(config.source.ref, "policy-v1.0.0");
    assert.deepEqual(config.engine, {
      package: KNITTO_PACKAGE,
      version: KNITTO_VERSION,
    });

    await successful(knitto(["apply", project, "--update"], { cache }));
    await successful(knitto(["check", project, "--quiet"], { cache }));
    assert.equal(
      await readFile(path.join(project, "POLICY.md"), "utf8"),
      "# Released policy\n",
    );

    const lock = JSON.parse(
      await readFile(path.join(project, ".knitto.lock"), "utf8"),
    ) as {
      source: { ref: string };
      engine: { package: string; version: string };
      provenance: { revision?: string };
    };
    assert.equal(lock.source.ref, "policy-v1.0.0");
    assert.deepEqual(lock.engine, {
      package: KNITTO_PACKAGE,
      version: KNITTO_VERSION,
    });
    assert.match(lock.provenance.revision ?? "", /^[a-f0-9]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI keeps locked plans stable until an explicit update", async () => {
  const root = await temporaryDirectory("knitto-cli-lock-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");
  const templateFile = path.join(template, "files", "VERSION.md.hbs");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "versioned-local-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      rules: [
        {
          id: "version",
          type: "file",
          template: "files/VERSION.md.hbs",
          destination: "VERSION.md",
        },
      ],
    });
    await writeText(templateFile, "version one\n");
    await mkdir(project, { recursive: true });
    await successful(
      knitto(
        ["init", project, "--type", "local", "--source", template],
        { cache },
      ),
    );
    await successful(knitto(["apply", project], { cache }));
    const firstLock = JSON.parse(
      await readFile(path.join(project, ".knitto.lock"), "utf8"),
    ) as { digest: string };

    await writeText(templateFile, "version two\n");

    const lockedPlan = JSON.parse(
      (await successful(knitto(["plan", project, "--json"], { cache }))).stdout,
    ) as { operations: unknown[] };
    assert.deepEqual(lockedPlan.operations, []);
    assert.equal(
      await readFile(path.join(project, "VERSION.md"), "utf8"),
      "version one\n",
    );

    const updatePlan = JSON.parse(
      (
        await successful(
          knitto(["plan", project, "--update", "--json"], { cache }),
        )
      ).stdout,
    ) as { operations: Array<{ path: string }> };
    assert.deepEqual(
      updatePlan.operations.map((operation) => operation.path),
      ["VERSION.md"],
    );

    await successful(knitto(["apply", project, "--update"], { cache }));
    assert.equal(
      await readFile(path.join(project, "VERSION.md"), "utf8"),
      "version two\n",
    );
    const secondLock = JSON.parse(
      await readFile(path.join(project, ".knitto.lock"), "utf8"),
    ) as { digest: string };
    assert.notEqual(secondLock.digest, firstLock.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reports and persists required template inputs in CI", async () => {
  const root = await temporaryDirectory("knitto-cli-inputs-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "input-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      prompts: [
        {
          path: "metadata.owner",
          type: "text",
          message: "Repository owner",
          required: true,
        },
      ],
      rules: [
        {
          id: "owners",
          type: "file",
          template: "files/OWNERS.hbs",
          destination: "OWNERS",
        },
      ],
    });
    await writeText(
      path.join(template, "files", "OWNERS.hbs"),
      "{{metadata.owner}}\n",
    );
    await writeJson(path.join(project, ".knitto.json"), {
      source: { type: "local", path: template },
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
    });

    const missing = await knitto(["plan", project, "--update"], { cache });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /metadata\.owner/);
    assert.match(missing.stderr, /--set/);

    await successful(
      knitto(
        [
          "plan",
          project,
          "--update",
          "--set",
          "metadata.owner=acme",
          "--json",
        ],
        { cache },
      ),
    );
    const configured = JSON.parse(
      await readFile(path.join(project, ".knitto.json"), "utf8"),
    ) as { metadata: { owner: string } };
    assert.equal(configured.metadata.owner, "acme");

    await successful(knitto(["apply", project, "--update"], { cache }));
    assert.equal(await readFile(path.join(project, "OWNERS"), "utf8"), "acme\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI reconciles workspace and repository-root targets", async () => {
  const root = await temporaryDirectory("knitto-cli-workspaces-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "workspace-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      rules: [
        {
          id: "workspace-file",
          type: "file",
          scope: "workspace",
          template: "files/workspace.hbs",
          destination: "GENERATED.md",
        },
        {
          id: "workspace-index",
          type: "file",
          scope: "workspace",
          target: "root",
          template: "files/workspace.hbs",
          destination: ".generated/{{pkgNameFs}}.md",
        },
      ],
    });
    await writeText(
      path.join(template, "files", "workspace.hbs"),
      "# {{pkgName}}\n",
    );
    await writeJson(path.join(project, "package.json"), {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeJson(path.join(project, "packages", "api", "package.json"), {
      name: "@acme/api",
    });
    await successful(
      knitto(
        ["init", project, "--type", "local", "--source", template],
        { cache },
      ),
    );
    await successful(knitto(["apply", project], { cache }));

    assert.equal(
      await readFile(
        path.join(project, "packages", "api", "GENERATED.md"),
        "utf8",
      ),
      "# @acme/api\n",
    );
    assert.equal(
      await readFile(path.join(project, ".generated", "acme-api.md"), "utf8"),
      "# @acme/api\n",
    );
    await successful(knitto(["check", project, "--quiet"], { cache }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects invalid inactive assets and mismatched engines", async () => {
  const root = await temporaryDirectory("knitto-cli-invalid-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "invalid-template",
      rules: [
        {
          id: "inactive",
          type: "file",
          template: "files/missing.hbs",
          destination: "MISSING",
          when: "false",
        },
      ],
    });
    await writeJson(path.join(project, ".knitto.json"), {
      source: { type: "local", path: template },
    });

    const invalidTemplate = await knitto(
      ["plan", project, "--update"],
      { cache },
    );
    assert.equal(invalidTemplate.status, 4);
    assert.match(invalidTemplate.stderr, /files\/missing\.hbs/);

    await writeJson(path.join(project, ".knitto.json"), {
      source: { type: "local", path: template },
      engine: { package: KNITTO_PACKAGE, version: "99.0.0" },
    });
    const wrongEngine = await knitto(["plan", project, "--update"], { cache });
    assert.equal(wrongEngine.status, 2);
    assert.match(wrongEngine.stderr, /npx knitto@99\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI requires explicit trust before executing template hooks", async () => {
  const root = await temporaryDirectory("knitto-cli-hooks-");
  const template = path.join(root, "template");
  const project = path.join(root, "project");
  const cache = path.join(root, "cache");
  const hook = path.join(template, "hooks", "derive.mjs");

  try {
    await writeJson(path.join(template, "template.json"), {
      schemaVersion: 1,
      name: "hook-template",
      engine: {
        package: KNITTO_PACKAGE,
        version: KNITTO_VERSION,
      },
      hooks: [
        {
          id: "derive",
          kind: "context",
          command: "hooks/derive.mjs",
        },
      ],
      rules: [
        {
          id: "derived-file",
          type: "file",
          template: "files/DERIVED.hbs",
          destination: "DERIVED.md",
        },
      ],
    });
    await writeText(
      hook,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ value: "trusted hook" }));',
        "});",
        "",
      ].join("\n"),
    );
    await chmod(hook, 0o755);
    await writeText(
      path.join(template, "files", "DERIVED.hbs"),
      "{{value}}\n",
    );
    await mkdir(project, { recursive: true });
    await successful(
      knitto(
        ["init", project, "--type", "local", "--source", template],
        { cache },
      ),
    );

    const untrusted = await knitto(["plan", project], { cache });
    assert.equal(untrusted.status, 2);
    assert.match(untrusted.stderr, /contains executable hooks and is not trusted/);
    await assert.rejects(
      readFile(path.join(project, "DERIVED.md"), "utf8"),
      /ENOENT/,
    );

    await successful(knitto(["source", "trust", project], { cache }));
    await successful(knitto(["apply", project], { cache }));
    assert.equal(
      await readFile(path.join(project, "DERIVED.md"), "utf8"),
      "trusted hook\n",
    );
    await successful(knitto(["check", project, "--quiet"], { cache }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
