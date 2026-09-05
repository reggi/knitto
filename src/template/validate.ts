import { readFile, stat } from "node:fs/promises";
import Handlebars from "handlebars";
import { KnittoError } from "../errors.js";
import {
  assertNoEscapingSymlink,
  resolveInside,
} from "../filesystem/paths.js";
import type { Snapshot } from "../types.js";
import { repositoryAssetPath } from "./assets.js";

interface TemplateAsset {
  path: string;
  kind: "file" | "source" | "schema" | "hook";
  owner: string;
}

async function validateAsset(
  snapshot: Snapshot,
  asset: TemplateAsset,
): Promise<void> {
  const file = resolveInside(snapshot.directory, asset.path);
  await assertNoEscapingSymlink(snapshot.directory, file);

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(file);
  } catch (error) {
    throw new KnittoError(
      `Template ${asset.kind} for ${asset.owner} does not exist: ${asset.path}`,
      "TEMPLATE",
      { cause: error },
    );
  }
  if (!fileStat.isFile()) {
    throw new KnittoError(
      `Template ${asset.kind} for ${asset.owner} is not a file: ${asset.path}`,
      "TEMPLATE",
    );
  }
  if (asset.kind === "file" || asset.kind === "schema") {
    try {
      Handlebars.parse(await readFile(file, "utf8"));
    } catch (error) {
      throw new KnittoError(
        `Template ${asset.kind} for ${asset.owner} contains invalid Handlebars: ${asset.path}`,
        "TEMPLATE",
        { cause: error },
      );
    }
  }
  if (asset.kind === "hook" && (fileStat.mode & 0o111) === 0) {
    throw new KnittoError(
      `Template hook ${asset.owner} is not executable: ${asset.path}`,
      "TEMPLATE",
    );
  }
}

export async function validateTemplateSnapshot(
  snapshot: Snapshot,
): Promise<void> {
  const assets: TemplateAsset[] = [];

  for (const [name, partial] of Object.entries(
    snapshot.manifest.partials ?? {},
  )) {
    assets.push({ path: partial, kind: "file", owner: `partial ${name}` });
  }

  for (const rule of snapshot.manifest.rules) {
    if (rule.type === "delete") continue;
    if ("template" in rule && rule.template) {
      assets.push({
        path: rule.template,
        kind: "file",
        owner: `rule ${rule.id}`,
      });
    }
    if (rule.type === "file" && "source" in rule) {
      assets.push({
        path: repositoryAssetPath(rule.source),
        kind: "source",
        owner: `rule ${rule.id}`,
      });
    }
    if ("schema" in rule && rule.schema) {
      assets.push({
        path: rule.schema,
        kind: "schema",
        owner: `rule ${rule.id}`,
      });
    }
    if (rule.type === "content" && rule.parser === "hook") {
      const hook = snapshot.manifest.hooks?.find(
        (candidate) =>
          candidate.id === rule.hook && candidate.kind === "parser",
      );
      if (!hook) {
        throw new KnittoError(
          `Parser hook does not exist for rule ${rule.id}: ${rule.hook ?? ""}`,
          "TEMPLATE",
        );
      }
    }
  }

  for (const hook of snapshot.manifest.hooks ?? []) {
    assets.push({ path: hook.command, kind: "hook", owner: hook.id });
  }

  await Promise.all(assets.map((asset) => validateAsset(snapshot, asset)));
}
