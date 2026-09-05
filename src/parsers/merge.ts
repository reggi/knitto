function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeDocuments(target: unknown, source: unknown): unknown {
  if (Array.isArray(source)) return structuredClone(source);
  if (!isRecord(source)) return structuredClone(source);

  const output: Record<string, unknown> = isRecord(target)
    ? structuredClone(target)
    : {};
  for (const [key, value] of Object.entries(source)) {
    output[key] = mergeDocuments(output[key], value);
  }
  return output;
}
