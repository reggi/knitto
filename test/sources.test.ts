import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as tar from "tar";
import { resolveCurrentSnapshot } from "../src/sources/resolve.js";
import { run } from "../src/sources/process.js";
import { temporaryDirectory, writeJson, writeText } from "./helpers.js";

async function createTemplate(directory: string): Promise<void> {
  await writeJson(path.join(directory, "template.json"), {
    schemaVersion: 1,
    name: "source-test",
    rules: [
      {
        id: "readme",
        type: "file",
        template: "README.hbs",
        destination: "README.md",
      },
    ],
  });
  await writeText(path.join(directory, "README.hbs"), "# {{project.name}}\n");
}

test("HTTP and local adapters produce the same content digest", async () => {
  const root = await temporaryDirectory("knitto-http-test-");
  const template = path.join(root, "template");
  const archive = path.join(root, "template.tar.gz");
  await mkdir(template);
  await createTemplate(template);
  await tar.c({ gzip: true, cwd: template, file: archive }, [
    "template.json",
    "README.hbs",
  ]);

  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/gzip");
    createReadStream(archive).pipe(response);
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const local = await resolveCurrentSnapshot(
      { type: "local", path: template },
      root,
    );
    const http = await resolveCurrentSnapshot(
      {
        type: "http",
        url: `http://127.0.0.1:${address.port}/template.tar.gz`,
      },
      root,
    );
    assert.equal(http.digest, local.digest);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("Git sources resolve to the same snapshot as their working tree", async () => {
  const root = await temporaryDirectory("knitto-git-test-");
  const template = path.join(root, "template");

  try {
    await mkdir(template);
    await createTemplate(template);
    await run("git", ["init", "--quiet"], { cwd: template });
    await run("git", ["config", "user.name", "Knitto Test"], {
      cwd: template,
    });
    await run("git", ["config", "user.email", "test@example.invalid"], {
      cwd: template,
    });
    await run("git", ["add", "."], { cwd: template });
    await run("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: template,
    });

    const local = await resolveCurrentSnapshot(
      { type: "local", path: template },
      root,
    );
    const git = await resolveCurrentSnapshot(
      { type: "git", url: template, ref: "HEAD" },
      root,
    );
    assert.equal(git.digest, local.digest);
    assert.match(git.provenance.revision ?? "", /^[a-f0-9]{40,64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an embedded .knitto directory shadows the configured source", async () => {
  const root = await temporaryDirectory("knitto-embedded-source-test-");
  const embedded = path.join(root, ".knitto");

  try {
    await mkdir(embedded);
    await createTemplate(embedded);

    const snapshot = await resolveCurrentSnapshot(
      {
        type: "git",
        url: path.join(root, "missing-remote"),
        path: ".knitto",
        ref: "v1.0.0",
      },
      root,
    );

    assert.equal(snapshot.manifest.name, "source-test");
    assert.deepEqual(snapshot.provenance, {
      sourceType: "local",
      locator: ".knitto",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
