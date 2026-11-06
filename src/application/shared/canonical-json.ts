export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * Serializes a JSON value with object keys sorted (default UTF-16 order) at every level, no whitespace,
 * `undefined` members omitted, and strings escaped exactly like JSON.stringify.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const member = (value as { readonly [key: string]: JsonValue | undefined })[key];
        return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
      });
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}
