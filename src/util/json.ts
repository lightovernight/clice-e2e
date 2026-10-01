export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pretty JSON with a trailing newline, for files people read. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
