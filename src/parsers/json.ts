import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import jsonPatch from "fast-json-patch";
import { DELETE_SENTINEL } from "../context/render.js";
import { setPointer } from "../rules/json-pointer.js";
import { deletePointer, getPointer } from "../rules/json-pointer.js";
import type { JsonPatchOperation } from "../types.js";

const REMOVE = Symbol("remove");

export interface JsonPrepareOptions {
  current: unknown;
  desired: unknown;
  schema?: unknown;
  excludedPointers?: string[];
  overrides?: Record<string, unknown>;
  exactPointers?: string[];
}

export interface JsonPrepareResult {
  value: unknown;
  patch: JsonPatchOperation[];
  violations: ErrorObject[];
  unfixable: ErrorObject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string, key: string): string {
  return `${pointer}/${escapePointer(key)}`;
}

function isExcluded(pointer: string, exclusions: string[]): boolean {
  return exclusions.some(
    (excluded) =>
      pointer === excluded || pointer.startsWith(`${excluded}/`),
  );
}

function mergeDesired(
  current: unknown,
  desired: unknown,
): unknown | typeof REMOVE {
  if (desired === DELETE_SENTINEL) return REMOVE;
  if (desired === undefined) return clone(current);
  if (Array.isArray(desired)) {
    return desired.flatMap((value) => {
      const merged = mergeDesired(undefined, value);
      return merged === REMOVE ? [] : [merged];
    });
  }
  if (!isRecord(desired)) return clone(desired);
  const output: Record<string, unknown> = isRecord(current)
    ? structuredClone(current)
    : {};
  for (const [key, value] of Object.entries(desired)) {
    const merged = mergeDesired(output[key], value);
    if (merged === REMOVE) delete output[key];
    else output[key] = merged;
  }
  return output;
}

function matchingSchema(
  key: string,
  patterns: Record<string, unknown>,
): unknown | undefined {
  for (const [pattern, schema] of Object.entries(patterns)) {
    if (new RegExp(pattern).test(key)) return schema;
  }
  return undefined;
}

function reconcileNode(
  current: unknown,
  desired: unknown,
  schema: unknown,
  pointer: string,
  exclusions: string[],
): unknown | typeof REMOVE {
  if (isExcluded(pointer, exclusions)) return clone(current);
  if (schema === false) return REMOVE;

  const merged = mergeDesired(current, desired);
  if (merged === REMOVE) return REMOVE;
  if (schema === true || !isRecord(schema)) return merged;

  if ("const" in schema) return clone(schema.const);
  if (merged === undefined && "default" in schema) return clone(schema.default);

  const objectSchema =
    schema.type === "object" ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties);
  if (objectSchema) {
    const output: Record<string, unknown> = isRecord(merged)
      ? structuredClone(merged)
      : {};
    const desiredRecord = isRecord(desired) ? desired : {};
    const currentRecord = isRecord(current) ? current : {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const patterns = isRecord(schema.patternProperties)
      ? schema.patternProperties
      : {};

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in output) && !(key in desiredRecord)) continue;
      const reconciled = reconcileNode(
        currentRecord[key],
        desiredRecord[key],
        propertySchema,
        childPointer(pointer, key),
        exclusions,
      );
      if (reconciled === REMOVE) delete output[key];
      else output[key] = reconciled;
    }

    for (const key of Object.keys(output)) {
      if (key in properties) continue;
      const patternSchema = matchingSchema(key, patterns);
      if (patternSchema !== undefined) {
        const reconciled = reconcileNode(
          currentRecord[key],
          desiredRecord[key],
          patternSchema,
          childPointer(pointer, key),
          exclusions,
        );
        if (reconciled === REMOVE) delete output[key];
        else output[key] = reconciled;
        continue;
      }

      const additional =
        schema.unevaluatedProperties ?? schema.additionalProperties;
      if (
        additional === false &&
        !isExcluded(childPointer(pointer, key), exclusions)
      ) {
        delete output[key];
      } else if (isRecord(additional) || additional === true) {
        const reconciled = reconcileNode(
          currentRecord[key],
          desiredRecord[key],
          additional,
          childPointer(pointer, key),
          exclusions,
        );
        if (reconciled === REMOVE) delete output[key];
        else output[key] = reconciled;
      }
    }

    for (const required of Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : []) {
      if (required in output) continue;
      const propertySchema = properties[required];
      if (!isRecord(propertySchema)) continue;
      if ("const" in propertySchema) output[required] = clone(propertySchema.const);
      else if ("default" in propertySchema) {
        output[required] = clone(propertySchema.default);
      }
    }

    return output;
  }

  if (
    (schema.type === "array" || "items" in schema) &&
    Array.isArray(merged) &&
    schema.items !== undefined
  ) {
    return merged.flatMap((value, index) => {
      const reconciled = reconcileNode(
        Array.isArray(current) ? current[index] : undefined,
        Array.isArray(desired) ? desired[index] : value,
        schema.items,
        childPointer(pointer, String(index)),
        exclusions,
      );
      return reconciled === REMOVE ? [] : [reconciled];
    });
  }

  return merged;
}

function errorPointer(error: ErrorObject): string {
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    return childPointer(error.instancePath, error.params.additionalProperty);
  }
  if (
    error.keyword === "required" &&
    typeof error.params.missingProperty === "string"
  ) {
    return childPointer(error.instancePath, error.params.missingProperty);
  }
  return error.instancePath;
}

function filterExcludedErrors(
  errors: ErrorObject[] | null | undefined,
  exclusions: string[],
): ErrorObject[] {
  return (errors ?? []).filter(
    (error) => !isExcluded(errorPointer(error), exclusions),
  );
}

function toPatchOperations(
  current: unknown,
  value: unknown,
): JsonPatchOperation[] {
  const left = isRecord(current) || Array.isArray(current) ? current : {};
  const right = isRecord(value) || Array.isArray(value) ? value : {};
  return jsonPatch
    .compare(left, right)
    .filter(
      (
        operation,
      ): operation is Exclude<typeof operation, { op: "_get" }> =>
        operation.op !== "_get",
    )
    .map((operation) => ({
      op: operation.op,
      path: operation.path,
      ...("from" in operation ? { from: operation.from } : {}),
      ...("value" in operation ? { value: operation.value } : {}),
    }));
}

export function prepareJson(
  options: JsonPrepareOptions,
): JsonPrepareResult {
  const exclusions = options.excludedPointers ?? [];
  const hasSchema = options.schema !== undefined;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate: ReturnType<Ajv2020["compile"]> | null = null;
  if (options.schema !== undefined) {
    const schema = options.schema;
    if (typeof schema !== "boolean" && !isRecord(schema)) {
      throw new TypeError("JSON Schema must be an object or boolean");
    }
    validate = ajv.compile(schema);
  }
  validate?.(options.current);
  const violations = filterExcludedErrors(validate?.errors, exclusions);

  let value = hasSchema
    ? reconcileNode(
        options.current,
        options.desired,
        options.schema,
        "",
        exclusions,
      )
    : mergeDesired(options.current, options.desired);
  if (value === REMOVE) value = {};

  for (const pointer of options.exactPointers ?? []) {
    if (isExcluded(pointer, exclusions)) continue;
    const desired = getPointer(options.desired, pointer);
    value =
      pointer === ""
        ? clone(desired)
        : desired === DELETE_SENTINEL
          ? deletePointer(value, pointer)
        : desired === undefined
          ? value
          : setPointer(value, pointer, desired);
  }

  if (options.overrides) {
    for (const [pointer, override] of Object.entries(options.overrides)) {
      value = setPointer(value, pointer, override);
    }
  }

  validate?.(value);
  const unfixable = filterExcludedErrors(validate?.errors, exclusions);
  return {
    value,
    patch: toPatchOperations(options.current, value),
    violations,
    unfixable,
  };
}
