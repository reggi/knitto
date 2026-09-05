import path from "node:path";
import { readFile } from "node:fs/promises";
import { validateTemplateManifest } from "../config.js";
import { KnittoError } from "../errors.js";
import { resolveInside } from "../filesystem/paths.js";
import { TEMPLATE_MANIFEST, type TemplateManifest } from "../types.js";

function mergeManifests(
  base: TemplateManifest,
  overlay: TemplateManifest,
): TemplateManifest {
  const rules = [...base.rules];
  for (const rule of overlay.rules) {
    const existing = rules.findIndex((candidate) => candidate.id === rule.id);
    if (existing === -1) rules.push(rule);
    else rules[existing] = rule;
  }

  return {
    schemaVersion: 1,
    name: overlay.name,
    ...(overlay.engine
      ? { engine: overlay.engine }
      : base.engine
        ? { engine: base.engine }
        : {}),
    ...(overlay.release
      ? { release: overlay.release }
      : base.release
        ? { release: base.release }
        : {}),
    rules,
    checks: [
      ...(base.checks ?? []).filter(
        (check) => !(overlay.checks ?? []).some((entry) => entry.id === check.id),
      ),
      ...(overlay.checks ?? []),
    ],
    hooks: [
      ...(base.hooks ?? []).filter(
        (hook) => !(overlay.hooks ?? []).some((entry) => entry.id === hook.id),
      ),
      ...(overlay.hooks ?? []),
    ],
    variables: {
      ...(base.variables ?? {}),
      ...(overlay.variables ?? {}),
    },
    inputs: [...new Set([...(base.inputs ?? []), ...(overlay.inputs ?? [])])],
    partials: {
      ...(base.partials ?? {}),
      ...(overlay.partials ?? {}),
    },
    prompts: [
      ...(base.prompts ?? []).filter(
        (prompt) =>
          !(overlay.prompts ?? []).some((entry) => entry.path === prompt.path),
      ),
      ...(overlay.prompts ?? []),
    ],
  };
}

export async function loadTemplateManifest(
  root: string,
  manifestPath = TEMPLATE_MANIFEST,
  loading = new Set<string>(),
): Promise<TemplateManifest> {
  const normalized = manifestPath.split(path.sep).join("/");
  if (loading.has(normalized)) {
    throw new KnittoError(
      `Template manifest inheritance cycle: ${[...loading, normalized].join(" -> ")}`,
      "TEMPLATE",
    );
  }
  loading.add(normalized);

  let manifest: TemplateManifest;
  try {
    const value = JSON.parse(
      await readFile(resolveInside(root, normalized), "utf8"),
    ) as unknown;
    manifest = validateTemplateManifest(value);
  } catch (error) {
    if (error instanceof KnittoError) throw error;
    throw new KnittoError(
      `Unable to load template manifest: ${normalized}`,
      "TEMPLATE",
      { cause: error },
    );
  }

  let resolved: TemplateManifest = {
    schemaVersion: 1,
    name: manifest.name,
    rules: [],
  };
  for (const parent of manifest.extends ?? []) {
    resolved = mergeManifests(
      resolved,
      await loadTemplateManifest(root, parent, new Set(loading)),
    );
  }
  loading.delete(normalized);
  return mergeManifests(resolved, manifest);
}
