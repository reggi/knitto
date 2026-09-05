import { parse as parseIni, stringify as stringifyIni } from "ini";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { KnittoError } from "../errors.js";
import { prepareJson } from "./json.js";
import { DELETE_SENTINEL } from "../context/render.js";
import { deletePointer, getPointer, setPointer } from "../rules/json-pointer.js";
import type { JsonPatchOperation, ParserName } from "../types.js";
import { mergeDocuments } from "./merge.js";

interface PrepareOptions {
  parser: ParserName;
  rendered: string;
  current: string | null;
  pointers?: string[];
  excludedPointers?: string[];
  overrides?: Record<string, unknown>;
  indent?: number;
  schema?: unknown;
  exactPointers?: string[];
}

export interface PreparedContent {
  contents: string;
  jsonPatch?: JsonPatchOperation[];
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new KnittoError(`${label} is not valid JSON`, "TEMPLATE", {
      cause: error,
    });
  }
}

function restoreExcluded(
  prepared: unknown,
  target: unknown,
  pointers: string[],
): unknown {
  let result = prepared;
  for (const pointer of pointers) {
    const existing = getPointer(target, pointer);
    result =
      existing === undefined
        ? deletePointer(result, pointer)
        : setPointer(result, pointer, existing);
  }
  return result;
}

function applyOverrides(
  prepared: unknown,
  overrides: Record<string, unknown>,
): unknown {
  let result = prepared;
  for (const [pointer, value] of Object.entries(overrides)) {
    result = setPointer(result, pointer, value);
  }
  return result;
}

function prepareStructured(
  source: unknown,
  target: unknown,
  merge: boolean,
  pointers: string[] | undefined,
  excludedPointers: string[],
  overrides: Record<string, unknown>,
): unknown {
  let prepared: unknown;

  if (pointers) {
    prepared = target;
    for (const pointer of pointers) {
      if (excludedPointers.includes(pointer)) continue;
      const value =
        pointer in overrides ? overrides[pointer] : getPointer(source, pointer);
      if (value === undefined) {
        throw new KnittoError(
          `Rendered template does not define managed pointer ${pointer}`,
          "TEMPLATE",
        );
      }
      prepared =
        value === DELETE_SENTINEL
          ? deletePointer(prepared, pointer)
          : setPointer(prepared, pointer, value);
    }
    return prepared;
  }

  prepared = merge ? mergeDocuments(target, source) : source;
  prepared = restoreExcluded(prepared, target, excludedPointers);
  return applyOverrides(prepared, overrides);
}

function packageKeyOrder(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const packageJson = value as Record<string, unknown>;
  const preferred = [
    "name",
    "version",
    "private",
    "description",
    "keywords",
    "homepage",
    "bugs",
    "repository",
    "funding",
    "license",
    "author",
    "contributors",
    "files",
    "type",
    "main",
    "module",
    "types",
    "exports",
    "bin",
    "scripts",
    "prettier",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "optionalDependencies",
    "engines",
    "os",
    "cpu",
    "publishConfig",
    "workspaces",
  ];
  const ordered: Record<string, unknown> = {};
  for (const key of preferred) {
    if (key in packageJson) ordered[key] = packageJson[key];
  }
  for (const key of Object.keys(packageJson).sort()) {
    if (!(key in ordered)) ordered[key] = packageJson[key];
  }
  return ordered;
}

export function prepareContent(options: PrepareOptions): PreparedContent {
  if (options.parser === "text") return { contents: options.rendered };

  const excludedPointers = options.excludedPointers ?? [];
  const overrides = options.overrides ?? {};
  let source: unknown;
  let target: unknown = {};
  let prepared: unknown;

  if (
    options.parser === "json" ||
    options.parser === "json-merge" ||
    options.parser === "package-json"
  ) {
    source = parseJson(options.rendered, "Rendered template");
    if (options.current !== null) {
      target = parseJson(options.current, "Destination file");
    }
    let jsonPatch: JsonPatchOperation[] | undefined;
    if (!options.pointers) {
      const reconciliation = prepareJson({
        current: target,
        desired: source,
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        excludedPointers,
        overrides,
        exactPointers: [
          ...(options.parser === "json" ? [""] : []),
          ...(options.exactPointers ?? []),
        ],
      });
      if (reconciliation.unfixable.length > 0) {
        throw new KnittoError(
          `JSON Schema violations cannot be reconciled automatically: ${reconciliation.unfixable
            .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
            .join("; ")}`,
          "TEMPLATE",
        );
      }
      prepared = reconciliation.value;
      jsonPatch = reconciliation.patch;
    } else {
      prepared = prepareStructured(
        source,
        target,
        options.parser !== "json",
        options.pointers,
        excludedPointers,
        overrides,
      );
    }
    if (options.parser === "package-json") prepared = packageKeyOrder(prepared);
    const trailingNewline =
      options.current === null || options.current.endsWith("\n") ? "\n" : "";
    return {
      contents: `${JSON.stringify(prepared, null, options.indent ?? 2)}${trailingNewline}`,
      ...(jsonPatch ? { jsonPatch } : {}),
    };
  }

  if (options.parser === "yaml" || options.parser === "yaml-merge") {
    source = parseYaml(options.rendered) as unknown;
    target = options.current === null ? {} : (parseYaml(options.current) as unknown);
    let jsonPatch: JsonPatchOperation[] | undefined;
    if (!options.pointers) {
      const reconciliation = prepareJson({
        current: target,
        desired: source,
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        excludedPointers,
        overrides,
        exactPointers: [
          ...(options.parser === "yaml" ? [""] : []),
          ...(options.exactPointers ?? []),
        ],
      });
      if (reconciliation.unfixable.length > 0) {
        throw new KnittoError(
          `JSON Schema violations cannot be reconciled automatically: ${reconciliation.unfixable
            .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
            .join("; ")}`,
          "TEMPLATE",
        );
      }
      prepared = reconciliation.value;
      jsonPatch = reconciliation.patch;
    } else {
      prepared = prepareStructured(
        source,
        target,
        options.parser === "yaml-merge",
        options.pointers,
        excludedPointers,
        overrides,
      );
    }
    return {
      contents: stringifyYaml(prepared, {
        indent: options.indent ?? 2,
        lineWidth: 0,
      }),
      ...(jsonPatch ? { jsonPatch } : {}),
    };
  }

  source = parseIni(options.rendered);
  target = options.current === null ? {} : parseIni(options.current);
  prepared = prepareStructured(
    source,
    target,
    options.parser === "ini-merge",
    options.pointers,
    excludedPointers,
    overrides,
  );
  return { contents: stringifyIni(prepared as Record<string, unknown>) };
}
