import { spawn } from "node:child_process";
import { KnittoError } from "../errors.js";
import { resolveInside } from "../filesystem/paths.js";
import type {
  CheckResult,
  JsonPatchOperation,
  ProjectUnit,
  RenderContext,
  Snapshot,
  TemplateHook,
} from "../types.js";

interface ParserHookResult {
  contents: string;
  jsonPatch?: JsonPatchOperation[];
}

async function executeHook(
  snapshot: Snapshot,
  hook: TemplateHook,
  input: unknown,
): Promise<unknown> {
  const command = resolveInside(snapshot.directory, hook.command);
  return new Promise((resolve, reject) => {
    const child = spawn(command, hook.args ?? [], {
      cwd: snapshot.directory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      reject(
        new KnittoError(`Unable to execute hook ${hook.id}`, "TEMPLATE", {
          cause: error,
        }),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new KnittoError(
            `Hook ${hook.id} failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            "TEMPLATE",
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown);
      } catch (error) {
        reject(
          new KnittoError(
            `Hook ${hook.id} did not return valid JSON`,
            "TEMPLATE",
            { cause: error },
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function assertHooksTrusted(snapshot: Snapshot, unit: ProjectUnit): void {
  if (
    (snapshot.manifest.hooks?.length ?? 0) > 0 &&
    !unit.config.trust?.hooks?.includes(snapshot.digest)
  ) {
    throw new KnittoError(
      `Template ${snapshot.digest} contains executable hooks and is not trusted`,
      "CONFIG",
    );
  }
}

export async function applyContextHooks(
  snapshot: Snapshot,
  unit: ProjectUnit,
  context: RenderContext,
): Promise<RenderContext> {
  let derived = context.derived;
  for (const hook of snapshot.manifest.hooks ?? []) {
    if (hook.kind !== "context") continue;
    const result = await executeHook(snapshot, hook, { unit, context });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new KnittoError(
        `Context hook ${hook.id} must return an object`,
        "TEMPLATE",
      );
    }
    derived = { ...derived, ...(result as Record<string, unknown>) };
  }
  return { ...context, derived };
}

export async function runParserHook(
  snapshot: Snapshot,
  hookId: string,
  input: unknown,
): Promise<ParserHookResult> {
  const hook = snapshot.manifest.hooks?.find(
    (candidate) => candidate.id === hookId && candidate.kind === "parser",
  );
  if (!hook) {
    throw new KnittoError(`Parser hook does not exist: ${hookId}`, "TEMPLATE");
  }
  const result = await executeHook(snapshot, hook, input);
  if (
    typeof result !== "object" ||
    result === null ||
    !("contents" in result) ||
    typeof result.contents !== "string"
  ) {
    throw new KnittoError(
      `Parser hook ${hookId} must return a contents string`,
      "TEMPLATE",
    );
  }
  return {
    contents: result.contents,
    ...("jsonPatch" in result && Array.isArray(result.jsonPatch)
      ? { jsonPatch: result.jsonPatch as JsonPatchOperation[] }
      : {}),
  };
}

export async function runCheckHooks(
  snapshot: Snapshot,
  unit: ProjectUnit,
  context: RenderContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const hook of snapshot.manifest.hooks ?? []) {
    if (hook.kind !== "check") continue;
    const result = await executeHook(snapshot, hook, { unit, context });
    if (!Array.isArray(result)) {
      throw new KnittoError(
        `Check hook ${hook.id} must return an array`,
        "TEMPLATE",
      );
    }
    for (const entry of result) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.title !== "string" ||
        !Array.isArray(entry.body)
      ) {
        throw new KnittoError(
          `Check hook ${hook.id} returned an invalid result`,
          "TEMPLATE",
        );
      }
      results.push({
        id: hook.id,
        project: unit.relativePath,
        title: entry.title,
        body: entry.body.map(String),
        ...("solution" in entry && typeof entry.solution === "string"
          ? { solution: entry.solution }
          : {}),
      });
    }
  }
  return results;
}
