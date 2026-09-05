import path from "node:path";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { KnittoError } from "../errors.js";
import { CONFIG_FILE, TEMPLATE_MANIFEST } from "../types.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "../version.js";

async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

export async function initializeTemplate(
  root: string,
  name = path.basename(root),
): Promise<void> {
  const templateRoot = path.join(root, ".knitto");
  const configFile = path.join(root, CONFIG_FILE);
  const existing = (
    await Promise.all([
      [templateRoot, await exists(templateRoot)] as const,
      [configFile, await exists(configFile)] as const,
    ])
  )
    .filter(([, present]) => present)
    .map(([file]) => file);

  if (existing.length > 0) {
    throw new KnittoError(
      `Refusing to initialize a template because ${existing.join(", ")} already exists`,
      "CONFIG",
    );
  }

  await mkdir(root, { recursive: true });
  let templateCreated = false;
  let configCreated = false;
  try {
    await mkdir(templateRoot);
    templateCreated = true;
    await mkdir(path.join(templateRoot, "files"));
    await writeFile(
      path.join(templateRoot, TEMPLATE_MANIFEST),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name,
          engine: {
            package: KNITTO_PACKAGE,
            version: KNITTO_VERSION,
          },
          rules: [],
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          source: {
            type: "local",
            path: ".knitto",
          },
          engine: {
            package: KNITTO_PACKAGE,
            version: KNITTO_VERSION,
          },
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    configCreated = true;
  } catch (error) {
    if (templateCreated) {
      await rm(templateRoot, { recursive: true, force: true });
    }
    if (configCreated) await rm(configFile, { force: true });
    throw new KnittoError(`Unable to initialize template: ${root}`, "CONFIG", {
      cause: error,
    });
  }
}
