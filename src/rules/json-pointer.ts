import { KnittoError } from "../errors.js";

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new KnittoError(`Invalid JSON Pointer: ${pointer}`, "TEMPLATE");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function indexFor(token: string, length: number): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new KnittoError(`Invalid array index in JSON Pointer: ${token}`, "TEMPLATE");
  }
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index > length) {
    throw new KnittoError(`Array index is out of range: ${token}`, "TEMPLATE");
  }
  return index;
}

export function getPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of tokens(pointer)) {
    if (Array.isArray(current)) {
      current = current[indexFor(token, current.length)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

export function setPointer(
  document: unknown,
  pointer: string,
  value: unknown,
): unknown {
  const parts = tokens(pointer);
  if (parts.length === 0) return structuredClone(value);

  const root =
    typeof document === "object" && document !== null
      ? structuredClone(document)
      : {};
  let current: unknown = root;

  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (token === undefined) continue;
    const last = index === parts.length - 1;
    const nextToken = parts[index + 1];
    const nextShouldBeArray = nextToken !== undefined && /^(0|[1-9]\d*)$/.test(nextToken);

    if (Array.isArray(current)) {
      const arrayIndex = indexFor(token, current.length);
      if (last) {
        current[arrayIndex] = structuredClone(value);
      } else {
        current[arrayIndex] ??= nextShouldBeArray ? [] : {};
        current = current[arrayIndex];
      }
      continue;
    }

    if (typeof current !== "object" || current === null) {
      throw new KnittoError(
        `Cannot traverse scalar value at JSON Pointer: ${pointer}`,
        "TEMPLATE",
      );
    }

    const record = current as Record<string, unknown>;
    if (last) {
      record[token] = structuredClone(value);
    } else {
      record[token] ??= nextShouldBeArray ? [] : {};
      current = record[token];
    }
  }

  return root;
}

export function deletePointer(document: unknown, pointer: string): unknown {
  const parts = tokens(pointer);
  if (parts.length === 0) return undefined;
  const root =
    typeof document === "object" && document !== null
      ? structuredClone(document)
      : {};
  let current: unknown = root;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const token = parts[index];
    if (token === undefined) return root;
    if (Array.isArray(current)) {
      current = current[indexFor(token, current.length)];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return root;
    }
    if (current === undefined) return root;
  }

  const finalToken = parts.at(-1);
  if (finalToken === undefined) return root;
  if (Array.isArray(current)) {
    const index = indexFor(finalToken, current.length);
    current.splice(index, 1);
  } else if (typeof current === "object" && current !== null) {
    delete (current as Record<string, unknown>)[finalToken];
  }
  return root;
}
