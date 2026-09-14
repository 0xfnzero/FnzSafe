const MAX_NESTED_JSON_DEPTH = 4;

function expandNestedJson(value: unknown, depth: number): unknown {
  if (depth >= MAX_NESTED_JSON_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => expandNestedJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandNestedJson(item, depth + 1)]),
    );
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    return value;
  }
  try {
    return expandNestedJson(JSON.parse(trimmed) as unknown, depth + 1);
  } catch {
    return value;
  }
}

export function formatDappPayloadForDisplay(payloadJson: string | null | undefined): string {
  const source = payloadJson?.trim() || "[]";
  try {
    return JSON.stringify(expandNestedJson(JSON.parse(source) as unknown, 0), null, 2);
  } catch {
    return source;
  }
}
